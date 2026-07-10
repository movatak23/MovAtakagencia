'use strict';

// ============================================================
// Webhooks. Corpos dos handlers movidos verbatim do index.js.
// 4a: 5 handlers menores. 4b: /webhook/zapi (handleZapi, orquestrador) +
// 22 helpers exclusivos (payload/comando). index.js registra app.M(path, handleX).
// ============================================================
const { query, garantirEstruturaConversas } = require('./db');
const { logDebug } = require('./config');
const { registrarConversa, registrarEventoLead, pararAtendimentoLead, limparPedidoAtendente } = require('./leads');
const { agendarFollowupV2, enviarFollowupsPendentesDoLead } = require('./followups');
const { leadRespondeuRecentemente, reentradaFU1Permitida } = require('./antispam');
const { dispararAusenciaSeAplicavel } = require('./ausencia');
const { moverLeadParaColunaFunil } = require('./funil');
const { enviarBoasVindasLead, enviarMenuAtendimento, processarRespostaMenu } = require('./menu');
const { enviarMsgQuestionario, iniciarQuestionario, processarRespostaQuestionario, reiniciarQuestionarioLead } = require('./questionario');
const { iaResponderAutomatico, localizarCampanhaPorIA } = require('./ia');
const { ehGrupoOuCanal, extrairDigitosTelefone, telefonesEquivalentes, variantesTelefone, registrarErroZapi, enviarAlerta } = require('./util');
const { emitirStatusMensagem } = require('./realtime');
const { zapiEtiquetar } = require('./zapi');

// Deps ainda no index.js (compartilhadas com rotas), injetadas no boot via init().
let textoBateGatilho, comandosDoVendedor, contemComando, localizarCampanhaPorGatilho,
    normalizarGatilho, resolverReplyInfoLead;
function init(deps) {
  ({ textoBateGatilho, comandosDoVendedor, contemComando, localizarCampanhaPorGatilho,
     normalizarGatilho, resolverReplyInfoLead } = deps);
}

async function handleMensagem(req, res) {
  try {
    const { phone, text, senderName } = req.body;
    if (!phone || !text) return res.json({ ok: true });

    const mensagem = (text || '').trim().toLowerCase();
    const telefone = phone.replace(/\D/g, '');

    // Buscar cliente com trigger que bate com a mensagem
    // Não usa ILIKE direto porque pequenas diferenças como "PROV>>" vs "PROV >>" quebravam o disparo.
    const r = await query(
      `SELECT * FROM movatak_clientes WHERE ativo = true AND trigger_msg IS NOT NULL`,
      []
    );
    const cliente = r.rows.find(c => textoBateGatilho(mensagem, c.trigger_msg));
    if (!cliente) return res.json({ ok: true });

    // Verificar se lead já existe para evitar duplicata (tolerante ao 9º dígito)
    const _varDup = variantesTelefone(telefone);
    const existe = await query(
      `SELECT id FROM movatak_leads WHERE cliente_id = $1 AND telefone IN (${_varDup.map((_, i) => '$' + (i + 2)).join(',')})`,
      [cliente.id, ..._varDup]
    );
    if (existe.rows.length) return res.json({ ok: true });

    // Criar lead direto em FU1
    const novoLead = await query(
      `INSERT INTO movatak_leads (cliente_id, telefone, nome, etapa)
       VALUES ($1, $2, $3, 'followup')
       RETURNING id`,
      [cliente.id, telefone, senderName || null]
    );

    await registrarEventoLead(novoLead.rows[0].id, cliente.id, 'lead_criado', 'Lead criado pela rota /webhook/mensagem', { telefone, origem: 'webhook/mensagem' });
    await agendarFollowupV2(novoLead.rows[0].id, cliente.id, 1, true);
    await enviarFollowupsPendentesDoLead(novoLead.rows[0].id, 1);

    // Etiquetar no WhatsApp
    await zapiEtiquetar(
      cliente.zapi_instance,
      cliente.zapi_token,
      cliente.zapi_client_token,
      telefone,
      'Lead'
    );

    res.json({ ok: true });
  } catch (e) {
    console.error('[webhook/mensagem]', e.message);
    res.status(500).json({ error: e.message });
  }
}

async function handleEtiqueta(req, res) {
  try {
    // Payload Z-API label_association
    const { phone, label, instanceId } = req.body;
    if (!phone || !label) return res.json({ ok: true });

    const telefone = phone.replace(/\D/g, '');
    const etiqueta = (label || '').toLowerCase();

    // Buscar cliente pela instância
    const rc = await query(
      'SELECT * FROM movatak_clientes WHERE zapi_instance = $1 AND ativo = true',
      [instanceId]
    );
    if (!rc.rows.length) return res.json({ ok: true });

    const cliente = rc.rows[0];

    // Buscar lead (tolerante ao 9º dígito)
    const _varRl = variantesTelefone(telefone);
    const rl = await query(
      `SELECT * FROM movatak_leads WHERE cliente_id = $1 AND telefone IN (${_varRl.map((_, i) => '$' + (i + 2)).join(',')}) ORDER BY atualizado_em DESC NULLS LAST, criado_em DESC LIMIT 1`,
      [cliente.id, ..._varRl]
    );
    if (!rl.rows.length) return res.json({ ok: true });

    const lead = rl.rows[0];

    // ---- Follow Up ----
    if (etiqueta === 'follow up' || etiqueta === 'followup') {
      await query(
        `UPDATE movatak_leads SET etapa = 'followup', atualizado_em = NOW() WHERE id = $1`,
        [lead.id]
      );

      // Follow-up manual entra no FU2 (reativacao)
      await agendarFollowupV2(lead.id, cliente.id, 2, true);
    }

    // ---- Registrar log de etiqueta (auditoria) ----
    await query(
      'INSERT INTO movatak_etiqueta_log (lead_id, cliente_id, etiqueta) VALUES ($1, $2, $3)',
      [lead.id, cliente.id, etiqueta]
    );

    // ---- Detecção de vendedor ----
    const vendedores = await query(
      'SELECT * FROM movatak_vendedores WHERE cliente_id = $1 AND COALESCE(ativo, true) = true',
      [cliente.id]
    );
    const vendedorDetectado = vendedores.rows.find(v =>
      etiqueta.toLowerCase() === ('vendedor - ' + v.nome.toLowerCase())
    );

    if (vendedorDetectado) {
      // Verificar troca suspeita — se já tinha outro vendedor
      const vendedorAnterior = await query(
        `SELECT el.etiqueta FROM movatak_etiqueta_log el
         WHERE el.lead_id = $1
           AND el.etiqueta ILIKE 'vendedor - %'
           AND el.aplicado_em < NOW() - INTERVAL '10 seconds'
         ORDER BY el.aplicado_em DESC LIMIT 1`,
        [lead.id]
      );

      if (vendedorAnterior.rows.length && vendedorAnterior.rows[0].etiqueta.toLowerCase() !== etiqueta.toLowerCase()) {
        // TROCA SUSPEITA DETECTADA
        const alertMsg = `⚠️ *Alerta: Troca de vendedor detectada*\n\n*Cliente:* ${cliente.nome}\n*Lead:* ${lead.telefone}\n*Vendedor anterior:* ${vendedorAnterior.rows[0].etiqueta}\n*Trocado para:* ${etiqueta}\n*Horário:* ${new Date().toLocaleString('pt-BR')}`;

        // Alerta para Movatak (você)
        await enviarAlerta(cliente.zapi_instance, cliente.zapi_token, cliente.zapi_client_token, MOVATAK_ADMIN_WA, alertMsg);

        // Alerta para dono da empresa
        if (cliente.whatsapp_dono) {
          await enviarAlerta(cliente.zapi_instance, cliente.zapi_token, cliente.zapi_client_token, cliente.whatsapp_dono, alertMsg);
        }

        console.log(`[alerta] Troca de vendedor detectada → lead ${lead.id}`);
      }

      // Atribuir vendedor ao lead (primeiro a aplicar ganha)
      if (!lead.vendedor_id) {
        await query(
          'UPDATE movatak_leads SET vendedor_id = $1, atualizado_em = NOW() WHERE id = $2',
          [vendedorDetectado.id, lead.id]
        );
      }
    }

    // ---- Cliente (venda fechada) ----
    if (etiqueta === 'cliente' || vendedorDetectado) {
      if (etiqueta === 'cliente' || vendedorDetectado) {
        await query(
          `UPDATE movatak_leads SET etapa = 'cliente', convertido_em = NOW(), atualizado_em = NOW() WHERE id = $1`,
          [lead.id]
        );

        await query(
          `UPDATE movatak_followup SET status = 'pausado' WHERE lead_id = $1 AND status = 'pendente'`,
          [lead.id]
        );
      }
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('[webhook/etiqueta]', e.message);
    res.status(500).json({ error: e.message });
  }
}

async function handleResposta(req, res) {
  try {
    const { phone, instanceId } = req.body;
    if (!phone) return res.json({ ok: true });

    const telefone = phone.replace(/\D/g, '');

    const rc = await query(
      'SELECT id FROM movatak_clientes WHERE zapi_instance = $1 AND ativo = true',
      [instanceId]
    );
    if (!rc.rows.length) return res.json({ ok: true });

    const clienteId = rc.rows[0].id;

    const _varResp = variantesTelefone(telefone);
    const rl = await query(
      `SELECT id FROM movatak_leads WHERE cliente_id = $1 AND telefone IN (${_varResp.map((_, i) => '$' + (i + 2)).join(',')}) AND etapa = 'followup'`,
      [clienteId, ..._varResp]
    );
    if (!rl.rows.length) return res.json({ ok: true });

    const leadId = rl.rows[0].id;

    await query(
      `UPDATE movatak_leads SET etapa = 'lead', atualizado_em = NOW() WHERE id = $1`,
      [leadId]
    );

    await query(
      `UPDATE movatak_followup SET status = 'pausado'
       WHERE lead_id = $1 AND status = 'pendente'`,
      [leadId]
    );

    console.log(`[resposta] Follow up pausado e lead voltou para atendimento → lead ${leadId}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[webhook/resposta]', e.message);
    res.status(500).json({ error: e.message });
  }
}

async function handleStatus(req, res) {
  try {
    const r = await query(`
      SELECT
        COUNT(*) FILTER (WHERE recebido_em > NOW() - INTERVAL '1 hour') AS recebidos_1h,
        COUNT(*) FILTER (WHERE status = 'erro' AND recebido_em > NOW() - INTERVAL '1 hour') AS erros_1h,
        MAX(recebido_em) AS ultimo_recebido,
        MAX(recebido_em) FILTER (WHERE status = 'erro') AS ultimo_erro
      FROM movatak_webhook_eventos
    `);
    res.json({ ok: true, webhook: r.rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

async function handleZapiStatus(req, res) {
  try {
    await garantirEstruturaConversas();
    const body = req.body || {};
    const messageId = body.messageId || body.id || body.messageID || body.msgId || body.message_id;
    const status = body.status || body.messageStatus || body.type || body.ack || body.event || null;
    if (!messageId) return res.json({ ok: true, ignored: true });
    const r = await query(`UPDATE movatak_conversas
                             SET msg_status=$1, msg_status_em=NOW(), zapi_status_payload=$2::jsonb
                           WHERE msg_id=$3
                           RETURNING id, lead_id, cliente_id`, [String(status || ''), JSON.stringify(body), messageId]);
    if (r.rows.length) emitirStatusMensagem(r.rows[0].cliente_id, r.rows[0].lead_id, r.rows[0].id, status);
    res.json({ ok: true, atualizadas: r.rows.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
}

async function handleZapi(req, res) {
  res.json({ ok: true }); // responde imediato

  const body = req.body || {};

  // ---- Idempotência + registro do evento bruto (protege autoatendimento/conversa) ----
  // A Z-API reenvia o mesmo webhook em timeout/429 (aconteceu no incidente). Sem dedupe,
  // o mesmo messageId vira conversa duplicada e pode reiniciar autoatendimento. Aqui
  // gravamos o evento cru e, se o messageId já foi recebido, encerramos sem reprocessar.
  // Regra de ouro: falha ao gravar NUNCA derruba o fluxo — segue processando normal.
  let _eventoWebhookId = null;
  try {
    const _instEv = body.instanceId || body.instance || null;
    const _msgEv = body.messageId || body.id || null;
    const _phoneEv = String(body.phone || '') || null;
    const _dirEv = body.fromMe ? 'saida' : 'entrada';
    if (_msgEv) {
      const _insEv = await query(
        `INSERT INTO movatak_webhook_eventos (origem, instance_id, message_id, phone, direction, payload, status)
         VALUES ('zapi', $1, $2, $3, $4, $5::jsonb, 'recebido')
         ON CONFLICT (instance_id, message_id) WHERE message_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [_instEv, _msgEv, _phoneEv, _dirEv, JSON.stringify(body)]
      );
      if (!_insEv.rows.length) {
        logDebug('[zapi][ignorado] evento duplicado (messageId ' + _msgEv + ' já recebido)');
        return;
      }
      _eventoWebhookId = _insEv.rows[0].id;
    } else {
      const _insEv = await query(
        `INSERT INTO movatak_webhook_eventos (origem, instance_id, message_id, phone, direction, payload, status)
         VALUES ('zapi', $1, NULL, $2, $3, $4::jsonb, 'recebido') RETURNING id`,
        [_instEv, _phoneEv, _dirEv, JSON.stringify(body)]
      );
      _eventoWebhookId = _insEv.rows[0].id;
    }
  } catch (e) {
    console.error('[zapi][evento] falha ao registrar evento bruto (seguindo mesmo assim):', e.message);
  }

  // ---- Repasse para o rastreiobot (mantém DTF funcionando) ----
  try {
    await axios.post(`${RASTREIOBOT_URL}/webhook/zapi`, body, { timeout: 8000 });
  } catch (e) {
    console.error('[zapi] repasse rastreiobot falhou:', e.message);
  }

  // ---- Processamento Movatak ----
  try {
    const instanceId = body.instanceId || body.instance || '';
    const chatLid    = body.chatLid || null;
    const phoneRaw   = String(body.phone || '');
    // Telefone real: tenta extrair de vários campos porque eventos fromMe podem vir com @lid
    let telefone     = extrairTelefonePayload(body);
    const texto      = (body.text && body.text.message) ? body.text.message
                       : (typeof body.text === 'string' ? body.text : '');
    const replyPayload = extrairReplyPayloadZapi(body);


    logDebug('[zapi][entrada]', JSON.stringify({
      fromMe: !!body.fromMe,
      isGroup: !!body.isGroup,
      isNewsletter: !!body.isNewsletter,
      instanceId,
      chatLid,
      phone: body.phone || null,
      telefoneExtraido: telefone,
      senderName: body.senderName || null,
      texto: texto || null,
      keys: Object.keys(body).slice(0, 30)
    }));

    if (body.isNewsletter) {
      logDebug('[zapi][ignorado] newsletter');
      return;
    }

    // ===== GRUPOS (entram na inbox como um contato, espelhando o WhatsApp) =====
    // Em vez de descartar, registramos a conversa do grupo usando o id do grupo
    // (@g.us) como "telefone"/chave. Fluxo isolado e curto: NÃO dispara gatilho,
    // follow-up, questionário nem comando — só garante que a conversa apareça na
    // inbox. Não cria coluna nova nem altera a query do funil (que quebrou antes).
    // Detecção de grupo robusta: confia no flag isGroup da Z-API, mas também
    // checa a chave (@g.us / id longo) caso o flag não venha em algum payload.
    const _chaveGrupo = String(body.phone || body.chatId || body.remoteJid || '').trim();
    if (body.isGroup || ehGrupoOuCanal(_chaveGrupo)) {
      try {
        if (!instanceId) return;
        const rcg = await query('SELECT * FROM movatak_clientes WHERE zapi_instance = $1 AND ativo = true', [instanceId]);
        if (!rcg.rows.length) return;
        const clienteG = rcg.rows[0];
        const grupoChave = _chaveGrupo;
        if (!grupoChave) return;
        const nomeGrupo = body.chatName || body.notifyName || ('Grupo ' + grupoChave.slice(0, 10));
        const ehSaidaG = !!body.fromMe;
        // Localiza pela "chave" do grupo, guardada no campo telefone do lead.
        let lg = await query('SELECT id FROM movatak_leads WHERE cliente_id=$1 AND telefone=$2 LIMIT 1', [clienteG.id, grupoChave]);
        let lgId;
        if (lg.rows.length) {
          lgId = lg.rows[0].id;
          await query('UPDATE movatak_leads SET atualizado_em=NOW(), nao_lida=$2 WHERE id=$1', [lgId, ehSaidaG ? false : true]).catch(() => null);
        } else {
          const nv = await query(
            `INSERT INTO movatak_leads (cliente_id, telefone, nome, etapa, chat_lid, nao_lida, atualizado_em)
             VALUES ($1, $2, $3, 'lead', $4, $5, NOW()) RETURNING id`,
            [clienteG.id, grupoChave, nomeGrupo, chatLid, ehSaidaG ? false : true]
          );
          lgId = nv.rows[0].id;
        }
        const midiaG = extrairMidiaPayloadZapi(body);
        const remetenteG = ehSaidaG ? '' : (body.senderName ? body.senderName + ': ' : '');
        await registrarConversa(lgId, clienteG.id, ehSaidaG ? 'saida' : 'entrada', remetenteG + (texto || ''), midiaG.url, midiaG.tipo, body.messageId || body.id || null, null).catch(() => null);
      } catch (e) {
        console.error('[zapi][grupo] erro:', e.message);
      }
      return;
    }

    // Mensagem apagada (revogada) — ignorar para não disparar "Não entendi" no questionário
    if (body.type === 'revoked' || body.isDeleted || body.revoked) {
      logDebug('[zapi][ignorado] mensagem apagada/revogada');
      return;
    }

    // Notificações de status (leitura, entrega, etc.) — não são mensagens reais
    if (body.type && ['ack', 'status', 'delivery', 'read', 'presence'].includes(String(body.type).toLowerCase())) {
      logDebug('[zapi][ignorado] evento de status: ' + body.type);
      return;
    }

    if (!instanceId) {
      logDebug('[zapi][ignorado] payload sem instanceId/instance');
      return;
    }

    // Buscar cliente pela instância
    const rc = await query(
      'SELECT * FROM movatak_clientes WHERE zapi_instance = $1 AND ativo = true',
      [instanceId]
    );
    if (!rc.rows.length) {
      console.log('[zapi][ignorado] nenhum cliente ativo encontrado para instanceId ' + instanceId);
      return;
    }
    const cliente = rc.rows[0];

    // Depois de identificar o cliente/instância, recalcula o telefone ignorando
    // qualquer número que seja da própria empresa. Isso evita criar lead
    // "falando consigo mesmo" quando o webhook fromMe traz connectedPhone/phone
    // como número da conta conectada.
    const telefoneAntesFiltroEmpresa = telefone;
    telefone = extrairTelefonePayload(body, cliente);
    if (telefoneAntesFiltroEmpresa && !telefone) {
      logDebug('[zapi][telefone] telefone descartado por ser da própria empresa ou inválido', JSON.stringify({ telefoneAntesFiltroEmpresa, fromMe: !!body.fromMe }));
    }

    const comandos = cliente.comandos || {};
    await registrarWebhookCliente(cliente.id, {
      fromMe: !!body.fromMe,
      isGroup: !!body.isGroup,
      telefone,
      chatLid,
      tipo: body.type || null,
      texto_preview: texto ? String(texto).slice(0, 120) : null
    });
    logDebug('[zapi][cliente]', cliente.nome + ' id=' + cliente.id);

    if (!telefone) {
      logDebug('[zapi][ignorado] telefone real do contato não identificado após filtro anti-próprio-número', JSON.stringify({
        fromMe: !!body.fromMe,
        phone: body.phone || null,
        senderPhone: body.senderPhone || null,
        connectedPhone: body.connectedPhone || null,
        to: body.to || null,
        from: body.from || null,
        chatId: body.chatId || null,
        remoteJid: body.remoteJid || null
      }));
      return;
    }

    // Se o payload trouxe a foto de perfil do contato (entrada), salva no lead.
    // É grátis (não chama a API) e mantém o avatar atualizado conforme as mensagens chegam.
    if (!body.fromMe) {
      const fotoPayload = extrairFotoPayloadZapi(body);
      if (fotoPayload) {
        await query(
          `UPDATE movatak_leads SET foto_url=$1, foto_atualizada_em=NOW()
            WHERE cliente_id=$2 AND telefone=$3`,
          [fotoPayload, cliente.id, telefone]
        ).catch(() => null);
      }
    }

    // ===== MENSAGEM ENVIADA PELO VENDEDOR / PRÓPRIO WHATSAPP (fromMe) =====
    // Antes o CRM descartava toda mensagem fromMe que não fosse comando interno.
    // Isso quebrava o histórico do Kanban, porque respostas manuais do vendedor nunca eram gravadas.
    // Agora a mensagem é registrada primeiro; depois a lógica de comandos continua igual.
    if (body.fromMe) {
      logDebug('[zapi][fromMe] recebido', JSON.stringify({ texto, chatLid, telefone }));

      const rvPre = await query(
        'SELECT * FROM movatak_vendedores WHERE cliente_id = $1 AND COALESCE(ativo, true) = true',
        [cliente.id]
      );

      const colsComandoPre = await query(
        `SELECT comando FROM movatak_funil_colunas
          WHERE cliente_id=$1 AND ativo=true AND comando IS NOT NULL AND TRIM(comando) <> ''`,
        [cliente.id]
      ).catch(() => ({ rows: [] }));
      const comandosColuna = colsComandoPre.rows.map(c => c.comando);

      const ehComandoInterno = textoPareceComandoInterno(texto, comandos, rvPre.rows, cliente.questionario_comando_parar, cliente.questionario_comando_ativar)
        || contemComando(texto, comandosColuna);
      const leadFromMe = await localizarLeadPorPayload(cliente.id, telefone, chatLid, ehComandoInterno);

      const midiaFromMe = extrairMidiaPayloadZapi(body);

      if (!leadFromMe) {
        console.log('[zapi][fromMe] lead nao encontrado para registrar mensagem/comando', JSON.stringify({ chatLid, telefone, ehComandoInterno }));

        // Mensagem enviada diretamente pelo WhatsApp Web para um contato que ainda não
        // existe no CRM. Antes era ignorada; agora cria um contato simples, sem acionar
        // automação nem marcar como não lido.
        if (!ehComandoInterno && telefone && ((texto && String(texto).trim()) || midiaFromMe.url)) {
          const novoLeadFromMe = await query(
            `INSERT INTO movatak_leads (cliente_id, telefone, nome, etapa, chat_lid, nao_lida, atualizado_em)
             VALUES ($1, $2, $3, 'lead', $4, false, NOW())
             RETURNING id`,
            [cliente.id, telefone, extrairNomeContatoPayloadZapi(body, cliente, telefone), chatLid]
          );
          await registrarConversa(novoLeadFromMe.rows[0].id, cliente.id, 'saida', texto || '', midiaFromMe.url, midiaFromMe.tipo, body.messageId || body.id || null, replyPayload, 'whatsapp_web').catch(() => null);
          await registrarEventoLead(novoLeadFromMe.rows[0].id, cliente.id, 'contato_criado_whatsapp_web', 'Contato criado a partir de mensagem enviada no WhatsApp Web', { telefone, chatLid }).catch(() => null);
        }
        return;
      }

      // jaRegistrada fica visível ao bloco de comandos mais abaixo: um eco fromMe de
      // uma mensagem que o PRÓPRIO CRM enviou não deve ser interpretado como comando.
      let jaRegistrada = false;
      if ((texto && String(texto).trim()) || midiaFromMe.url) {
        // Evita duplicar: se a mensagem foi enviada pelo PRÓPRIO painel, ela já foi
        // gravada no banco (com o mesmo messageId do Z-API) no momento do envio. O
        // webhook fromMe chega logo depois confirmando o mesmo envio — se já existe
        // uma conversa com esse messageId, não registra de novo.
        const msgIdFromMe = body.messageId || body.id || null;
        if (msgIdFromMe) {
          const dup = await query(
            'SELECT 1 FROM movatak_conversas WHERE lead_id=$1 AND msg_id=$2 LIMIT 1',
            [leadFromMe.id, msgIdFromMe]
          ).catch(() => ({ rows: [] }));
          jaRegistrada = dup.rows.length > 0;
        }
        // Fallback por conteúdo + janela curta — roda sempre que o match por msg_id não
        // achou. Cobre mensagens que o CRM enviou e gravou SEM messageId (follow-up,
        // boas-vindas, ausência): o eco fromMe chega com messageId próprio, então o match
        // acima falha e, sem isto, a mensagem apareceria DUPLICADA no painel.
        if (!jaRegistrada && texto && String(texto).trim()) {
          const dupC = await query(
            `SELECT 1 FROM movatak_conversas
              WHERE lead_id=$1 AND direcao='saida'
                AND COALESCE(conteudo,'')=COALESCE($2,'')
                AND criado_em > NOW() - INTERVAL '45 seconds' LIMIT 1`,
            [leadFromMe.id, texto || '']
          ).catch(() => ({ rows: [] }));
          jaRegistrada = dupC.rows.length > 0;
        }
        if (!jaRegistrada) {
          const replyFromMe = await resolverReplyInfoLead(leadFromMe.id, null, replyPayload ? replyPayload.reply_to_msg_id : null, replyPayload);
          await registrarConversa(leadFromMe.id, cliente.id, 'saida', texto || '', midiaFromMe.url, midiaFromMe.tipo, msgIdFromMe, replyFromMe.info, 'whatsapp_web').catch(() => null);
          // Mensagem humana (não é comando interno) → o atendente assumiu; limpa o sinal.
          if (!ehComandoInterno) await limparPedidoAtendente(leadFromMe.id);
        } else {
          logDebug('[zapi][fromMe] mensagem já registrada pelo painel, ignorando duplicata');
        }
      }

      if (!ehComandoInterno) {
        logDebug('[zapi][fromMe] mensagem normal registrada no histórico do Kanban');
        return;
      }

      // Eco fromMe de um envio automático do PRÓPRIO CRM (questionário, IA, follow-up,
      // boas-vindas, ausência): jaRegistrada=true significa que já gravamos esse envio.
      // Mesmo que o texto contenha um token de comando — ex.: a intro do questionário
      // que instrui o lead a digitar #ATENDENTE —, NÃO é um comando digitado por um
      // humano. Ignora, senão o bot se auto-pausa. Comando real vem digitado no
      // WhatsApp pelo atendente e não está pré-registrado (jaRegistrada=false).
      if (jaRegistrada) {
        logDebug('[zapi][fromMe] eco de envio automático contém texto de comando — ignorando (não é comando humano)');
        return;
      }

      const lead = leadFromMe;

      // -- Comando: vendedor especifico (conversao atribuida) --
      const rv = { rows: rvPre.rows };
      const vendedorDetectado = rv.rows.find(v => vendedorBateComando(v, texto));
      if (!vendedorDetectado) {
        console.log('[zapi][fromMe] nenhum vendedor bateu com o comando. Cadastrados:', JSON.stringify(
          rv.rows.map(v => ({ nome: v.nome, comando: v.comando || null, comandos_validos: comandosDoVendedor(v) }))
        ));
      }
      if (vendedorDetectado) {
        await query(
          `UPDATE movatak_leads SET etapa = 'cliente', vendedor_id = $1, convertido_em = NOW(), atualizado_em = NOW() WHERE id = $2`,
          [vendedorDetectado.id, lead.id]
        );
        await query(
          `UPDATE movatak_followup SET status = 'pausado' WHERE lead_id = $1 AND status = 'pendente'`,
          [lead.id]
        );
        await registrarEventoLead(lead.id, cliente.id, 'convertido_vendedor', `Lead convertido por ${vendedorDetectado.nome}`, { vendedor_id: vendedorDetectado.id, comando: texto });
        console.log(`[zapi] Convertido por ${vendedorDetectado.nome} -> lead ${lead.id}`);
        return;
      }

      // -- Comando: convertido --
      if (contemComando(texto, comandos.convertido)) {
        await query(
          `UPDATE movatak_leads SET etapa = 'cliente', convertido_em = NOW(), atualizado_em = NOW() WHERE id = $1`,
          [lead.id]
        );
        await query(
          `UPDATE movatak_followup SET status = 'pausado' WHERE lead_id = $1 AND status = 'pendente'`,
          [lead.id]
        );
        await registrarEventoLead(lead.id, cliente.id, 'convertido', 'Lead marcado como cliente por comando geral', { comando: texto });
        console.log(`[zapi] Convertido -> lead ${lead.id}`);
        return;
      }

      // -- Comando: descartar --
      if (contemComando(texto, comandos.descartar)) {
        await query(
          `UPDATE movatak_leads SET etapa = 'descartado', atualizado_em = NOW() WHERE id = $1`,
          [lead.id]
        );
        await query(
          `UPDATE movatak_followup SET status = 'pausado' WHERE lead_id = $1 AND status = 'pendente'`,
          [lead.id]
        );
        await registrarEventoLead(lead.id, cliente.id, 'descartado', 'Lead descartado por comando', { comando: texto });
        console.log(`[zapi] Descartado -> lead ${lead.id}`);
        return;
      }

      // -- Comando: desfazer venda (so reverte se o lead estiver convertido) --
      if (contemComando(texto, comandos.desfazer)) {
        if (lead.etapa === 'cliente') {
          await query(
            `UPDATE movatak_leads SET etapa = 'lead', vendedor_id = NULL, convertido_em = NULL, atualizado_em = NOW() WHERE id = $1`,
            [lead.id]
          );
          await registrarEventoLead(lead.id, cliente.id, 'venda_desfeita', 'Conversão revertida por comando', { comando: texto });
          console.log(`[zapi] Venda desfeita -> lead ${lead.id}`);
        } else {
          console.log(`[zapi] Desfazer ignorado — lead ${lead.id} nao estava convertido`);
        }
        return;
      }

      // -- Comando: followup --
      if (contemComando(texto, comandos.followup)) {
        await query(
          `UPDATE movatak_leads SET etapa = 'followup', atualizado_em = NOW() WHERE id = $1`,
          [lead.id]
        );
        // Follow-up manual entra no FU2 (reativacao)
        await agendarFollowupV2(lead.id, cliente.id, 2, true);
        await registrarEventoLead(lead.id, cliente.id, 'followup_manual', 'Follow-up FU2 ativado manualmente por comando', { comando: texto });
        console.log(`[zapi] Follow up FU2 ativado -> lead ${lead.id}`);
        return;
      }

      // -- Comando: pausar automação --
      if (contemComando(texto, comandos.pausar)) {
        await query(
          `UPDATE movatak_leads SET automacao_pausada = true, atualizado_em = NOW() WHERE id = $1`,
          [lead.id]
        );
        await query(
          `UPDATE movatak_followup SET status = 'pausado' WHERE lead_id = $1 AND status = 'pendente'`,
          [lead.id]
        );
        await query(
          `UPDATE movatak_questionario_estado SET status = 'cancelado', atualizado_em = NOW()
           WHERE lead_id = $1 AND status = 'em_andamento'`,
          [lead.id]
        ).catch(() => null);
        await registrarEventoLead(lead.id, cliente.id, 'automacao_pausada', 'Automação pausada manualmente por comando', { comando: texto });
        console.log(`[zapi] Automação pausada -> lead ${lead.id}`);
        return;
      }

      // -- Comando: parar atendimento (autoatendimento) --
      if (textoBateComandoParar(texto, cliente.questionario_comando_parar)) {
        await pararAtendimentoLead(cliente.id, lead.id, 'vendedor', texto);
        return;
      }

      // -- Comando: ativar/reiniciar autoatendimento (questionário do zero) --
      if (textoBateComandoAtivar(texto, cliente.questionario_comando_ativar)) {
        if (!cliente.questionario_ativo) {
          console.log(`[zapi] Comando ativar ignorado — questionário desativado para cliente ${cliente.id}`);
          return;
        }
        await reiniciarQuestionarioLead(cliente, lead, texto);
        return;
      }

      // -- Comando: mover lead para uma coluna do kanban --
      if (await moverLeadPorComandoColuna(cliente, lead, texto)) {
        return;
      }

      return;
    }

    // ===== MENSAGEM RECEBIDA DO LEAD =====
    const temTexto = !!String(texto || '').trim();
    const midiaRecebida = extrairMidiaPayloadZapi(body);

    if (!temTexto && !midiaRecebida.url) {
      logDebug('[zapi][lead] ignorado: evento sem texto util e sem mídia');
      return;
    }

    if (!telefone) {
      console.log('[zapi][lead] ignorado: nao consegui extrair telefone real do payload');
      return;
    }

    // Buscar lead pelo telefone (tolerante ao 9º dígito)
    const _varMsg = variantesTelefone(telefone);
    const rl = await query(
      `SELECT * FROM movatak_leads WHERE cliente_id = $1 AND telefone IN (${_varMsg.map((_, i) => '$' + (i + 2)).join(',')}) ORDER BY atualizado_em DESC NULLS LAST, criado_em DESC LIMIT 1`,
      [cliente.id, ..._varMsg]
    );
    const lead = rl.rows[0] || null;

    // Gravar mensagem recebida na conversa (agora que o lead está disponível) —
    // cobre texto puro, mídia pura (ex: áudio sem legenda) e mídia com legenda.
    if (lead && (texto || midiaRecebida.url)) {
      const msgIdEntrada = body.messageId || body.id || null;
      const replyEntrada = await resolverReplyInfoLead(lead.id, null, replyPayload ? replyPayload.reply_to_msg_id : null, replyPayload);
      registrarConversa(lead.id, cliente.id, 'entrada', texto || '', midiaRecebida.url, midiaRecebida.tipo, msgIdEntrada, replyEntrada.info).catch(() => null);
    }

    // Sem texto (ex: áudio ou foto sem legenda): já foi registrada acima.
    // Não há comando pra interpretar, então a automação abaixo não se aplica.
    if (!temTexto) {
      return;
    }

    // ===== MENSAGEM DE AUSÊNCIA (lead já existente) =====
    // Toggle da coluna ligado → dispara sempre; senão, por horário. Dedup por período.
    if (lead) {
      await dispararAusenciaSeAplicavel(cliente, lead, telefone);
    }

    // ===== COMANDO: PARAR ATENDIMENTO (cliente pede atendente humano) =====
    // Funciona em qualquer ponto, inclusive durante o questionário.
    // IMPORTANTE: roda ANTES da checagem de automação pausada — mesmo com o lead
    // já pausado (ex: usou o comando antes), repetir o comando deve responder a
    // confirmação de novo, em vez de cair no return silencioso da pausa.
    if (lead && textoBateComandoParar(texto, cliente.questionario_comando_parar)) {
      console.log(`[zapi][comando-parar] lead ${lead.id} usou o comando (ja_pausado=${!!lead.automacao_pausada})`);
      // Roda SEMPRE, mesmo com o lead já pausado: é aqui que o pediu_atendente
      // é ligado, a conversa vira não lida e o socket avisa os painéis (chip 🙋).
      // A função é idempotente — pausar de novo não tem efeito colateral, e o
      // evento repetido no histórico é útil ("lead cobrou atendente de novo").
      await pararAtendimentoLead(cliente.id, lead.id, 'cliente', texto);
      // Confirmação automática pro lead: avisa que um atendente vai falar com ele.
      // Texto configurável no painel (questionario_msg_parar); se vazio, usa o padrão.
      // Enviada com a automação já pausada — o webhook fromMe desta mensagem não
      // dispara nada. Tem dedup interno de 2 min pra comando repetido não spammar.
      await enviarConfirmacaoAtendente(cliente, lead).catch(e => console.error('[zapi][msg-atendente]', e.message));
      return;
    }

    // Se automação pausada manualmente: apenas grava a mensagem, ignora toda lógica de automação.
    // Retomar: vendedor usa o comando de followup ou convertido para reativar.
    if (lead && lead.automacao_pausada) {
      console.log(`[zapi][lead ${lead.id}] automação PAUSADA (pediu_atendente=${!!lead.pediu_atendente}) — mensagem gravada, IA/automação NÃO responde. Reative com o comando de ativar ou followup.`);
      return;
    }

    // ===== MENU DE ATENDIMENTO EM ANDAMENTO (lead escolhendo setor) =====
    // Só age se o cliente tem o menu ativo E existe um estado aguardando para o lead.
    if (lead && cliente.menu_atend_ativo) {
      const estMenu = await query(
        `SELECT * FROM movatak_menu_estado
          WHERE cliente_id = $1 AND lead_id = $2 AND status = 'aguardando'
          ORDER BY id DESC LIMIT 1`,
        [cliente.id, lead.id]
      ).catch(() => ({ rows: [] }));
      if (estMenu.rows.length) {
        await processarRespostaMenu(cliente, lead, estMenu.rows[0], texto);
        return;
      }
    }

    // ===== QUESTIONÁRIO EM ANDAMENTO (venda consultiva) =====
    // Se existe um estado em andamento para o lead, a mensagem é tratada pelo
    // motor do questionário. Não depende do flag global do cliente, pois o
    // questionário pode ter sido iniciado por um template vinculado à campanha.
    if (lead) {
      const estQ = await query(
        `SELECT * FROM movatak_questionario_estado
          WHERE cliente_id = $1 AND lead_id = $2 AND status = 'em_andamento'
          ORDER BY id DESC LIMIT 1`,
        [cliente.id, lead.id]
      ).catch(() => ({ rows: [] }));
      if (estQ.rows.length) {
        await processarRespostaQuestionario(cliente, lead, estQ.rows[0], texto);
        return;
      }
    }

    // Calcula o gatilho antes de tratar lead existente.
    // Assim, se a mesma pessoa clicar no anúncio novamente, conseguimos reativar o FU1.
    let campanhaDetectada = await localizarCampanhaPorGatilho(cliente.id, texto);
    // Fallback por IA: se o gatilho literal não casou, e existe alguma coluna com
    // IA ativa neste cliente, deixa a IA tentar encaixar a mensagem numa campanha.
    if (!campanhaDetectada) {
      const temIA = await query(
        `SELECT 1 FROM movatak_funil_colunas WHERE cliente_id=$1 AND ia_ativa=true AND ativo=true LIMIT 1`,
        [cliente.id]
      ).catch(() => ({ rows: [] }));
      if (temIA.rows.length) {
        campanhaDetectada = await localizarCampanhaPorIA(cliente.id, texto);
      }
    }
    const msg = normalizarGatilho(texto);
    const trigger = normalizarGatilho(campanhaDetectada ? campanhaDetectada.gatilho : cliente.trigger_msg);
    const triggerOk = !!campanhaDetectada || textoBateGatilho(texto, cliente.trigger_msg);

    // -- Lead existe: garantir chat_lid salvo + pausar followup se respondeu --
    if (lead) {
      // Salva o chat_lid se ainda nao tiver (essencial para os comandos)
      if (chatLid && lead.chat_lid !== chatLid) {
        await query('UPDATE movatak_leads SET chat_lid = $1, atualizado_em = NOW() WHERE id = $2', [chatLid, lead.id]);
      }

      // Reentrada por gatilho só vale para leads "frios": novo contato, em follow-up
      // ou descartado. Nunca reativa quem está no meio do questionário (auto_atendimento),
      // já qualificado (negociacao) ou fechado (cliente) — isso causava o reinício do fluxo.
      const etapasReentrada = ['lead', 'followup', 'descartado'];
      if (triggerOk && etapasReentrada.includes(lead.etapa)) {
        // Não reativar o FU1 se o lead já está em conversa ativa (respondeu nas últimas horas).
        // Evita reenviar boas-vindas/follow-up quando a mensagem com gatilho é continuação do papo.
        if (await leadRespondeuRecentemente(lead.id, MOVATAK_REENTRADA_FU1_HORAS)) {
          await registrarEventoLead(lead.id, cliente.id, 'reentrada_ignorada_conversa_ativa', 'Reentrada FU1 ignorada: lead em conversa ativa', { telefone }).catch(() => null);
          console.log(`[anti-spam] reentrada FU1 ignorada (conversa ativa) -> lead ${lead.id}`);
          if (lead.etapa === 'followup') {
            await query(`UPDATE movatak_leads SET etapa = 'lead', atualizado_em = NOW() WHERE id = $1`, [lead.id]);
            await query(`UPDATE movatak_followup SET status = 'pausado' WHERE lead_id = $1 AND status = 'pendente'`, [lead.id]);
          }
          return;
        }
        if (!(await reentradaFU1Permitida(lead.id))) {
          await registrarEventoLead(lead.id, cliente.id, 'anti_spam_reentrada', 'Reentrada no FU1 bloqueada por intervalo mínimo', { telefone, horas: MOVATAK_REENTRADA_FU1_HORAS });
          console.log(`[anti-spam] reentrada FU1 bloqueada -> lead ${lead.id}`);
          return;
        }
        await query(
          `UPDATE movatak_leads
             SET etapa = 'followup', nome = COALESCE($1, nome), automacao_pausada = false, pediu_atendente = false, atualizado_em = NOW()
           WHERE id = $2`,
          [body.senderName || null, lead.id]
        );
        if (campanhaDetectada) {
          await query('UPDATE movatak_leads SET campanha_id = COALESCE(campanha_id, $1), campanha_id_ultimo_toque = $1, template_id_origem = COALESCE(template_id_origem, $2), gatilho_detectado = $3 WHERE id = $4', [campanhaDetectada.id, campanhaDetectada.template_id || null, campanhaDetectada.gatilho || null, lead.id]).catch(() => null);
        }
        await agendarFollowupV2(lead.id, cliente.id, 1, true);
        await enviarFollowupsPendentesDoLead(lead.id, 1);
        await registrarEventoLead(lead.id, cliente.id, 'reativado_gatilho', 'Lead existente reativado no FU1 por nova frase-gatilho', { telefone, texto });
        console.log(`[zapi] Lead existente reativado em FU1 -> lead ${lead.id} telefone ${telefone}`);
        return;
      }

      if (lead.etapa === 'followup') {
        await query(
          `UPDATE movatak_leads SET etapa = 'lead', atualizado_em = NOW() WHERE id = $1`,
          [lead.id]
        );
        await query(
          `UPDATE movatak_followup SET status = 'pausado' WHERE lead_id = $1 AND status = 'pendente'`,
          [lead.id]
        );
        await registrarEventoLead(lead.id, cliente.id, 'lead_respondeu', 'Lead respondeu e saiu do follow-up', { texto_preview: texto ? String(texto).slice(0, 160) : null });
        console.log(`[zapi] Follow up pausado e lead voltou para atendimento -> lead ${lead.id}`);
      }

      // IA automática: se a coluna do lead tem IA ativa, a IA responde sozinha.
      // O texto do lead é passado para as travas transacionais (pré-filtro).
      await iaResponderAutomatico(cliente, lead, texto);
      return;
    }

    // -- Novo lead: mensagem bate com o trigger do trafego --
    console.log('[zapi][novo-lead] comparando trigger', JSON.stringify({
      msg_original: texto,
      trigger_original: cliente.trigger_msg,
      msg,
      trigger,
      triggerOk
    }));
    if (triggerOk) {
      const novoLead = await query(
        `INSERT INTO movatak_leads
           (cliente_id, telefone, nome, etapa, chat_lid, campanha_id, campanha_id_ultimo_toque, template_id_origem, gatilho_detectado)
         VALUES ($1, $2, $3, 'followup', $4, $5, $5, $6, $7)
         RETURNING id`,
        [cliente.id, telefone, extrairNomeContatoPayloadZapi(body, cliente, telefone), chatLid, campanhaDetectada ? campanhaDetectada.id : null, campanhaDetectada ? (campanhaDetectada.template_id || null) : null, campanhaDetectada ? (campanhaDetectada.gatilho || null) : null]
      );
      await registrarEventoLead(novoLead.rows[0].id, cliente.id, 'lead_criado', 'Lead criado pela rota unificada da Z-API', { telefone, chatLid, texto, campanha_id: campanhaDetectada ? campanhaDetectada.id : null });
      // Registra também a primeira mensagem do lead que criou o atendimento.
      // Antes ela ficava fora do histórico porque o lead ainda não existia no momento inicial da busca.
      const midiaNovoLead = extrairMidiaPayloadZapi(body);
      const msgIdNovoLead = body.messageId || body.id || null;
      await registrarConversa(novoLead.rows[0].id, cliente.id, 'entrada', texto || '', midiaNovoLead.url, midiaNovoLead.tipo, msgIdNovoLead, replyPayload).catch(() => null);

      // Decide se inicia o questionário:
      // - Campanha com template de questionário vinculado → usa o questionário do template.
      // - Senão, usa o questionário do cliente (se ativo).
      // A flag questionario_ativo da campanha permite desligar (vai direto ao follow-up).
      const campanhaPermiteQuest = !campanhaDetectada || campanhaDetectada.questionario_ativo !== false;
      const temTemplateQuest = campanhaDetectada && campanhaDetectada.questionario_template_id;
      const deveIniciarQuest = campanhaPermiteQuest && (temTemplateQuest || cliente.questionario_ativo);
      const leadObj = { id: novoLead.rows[0].id, telefone, nome: extrairNomeContatoPayloadZapi(body, cliente, telefone), chat_lid: chatLid, campanha_id: campanhaDetectada ? campanhaDetectada.id : null };

      // PASSO ZERO: Boas-Vindas ao Lead (saudação independente, invisível ao sistema).
      // Enviada antes de qualquer fluxo, se preenchida. Não afeta o follow-up.
      await enviarBoasVindasLead(cliente, telefone);

      // Ausência para lead NOVO (vindo do tráfego): se a coluna de entrada tem o
      // toggle ligado, dispara o aviso de ausência. O delay para chegar após as
      // boas-vindas já está dentro da função dispararAusenciaSeAplicavel.
      await dispararAusenciaSeAplicavel(cliente, { id: novoLead.rows[0].id, funil_coluna_id: null }, telefone);

      // Menu de Atendimento "na entrada": manda as boas-vindas (FU1) e o menu,
      // e PARA aqui — o questionário/follow-up segue só após o lead escolher o setor.
      if (cliente.menu_atend_ativo && cliente.menu_atend_posicao === 'apos_boas_vindas') {
        await agendarFollowupV2(novoLead.rows[0].id, cliente.id, 1, true);
        await enviarFollowupsPendentesDoLead(novoLead.rows[0].id, 1);
        await enviarMenuAtendimento(cliente, leadObj);
        console.log(`[zapi] Novo lead + menu de atendimento (entrada) -> ${telefone} (${cliente.nome})`);
      } else if (deveIniciarQuest) {
        await iniciarQuestionario(cliente, leadObj);
        console.log(`[zapi] Novo lead + questionario iniciado -> ${telefone} (${cliente.nome})`);
      } else {
        await agendarFollowupV2(novoLead.rows[0].id, cliente.id, 1, true);
        await enviarFollowupsPendentesDoLead(novoLead.rows[0].id, 1);
        console.log(`[zapi] Novo lead criado em FU1 -> ${telefone} (${cliente.nome})`);
      }
    } else {
      // Novo contato comum do WhatsApp: não bateu com gatilho de campanha, mas ainda
      // precisa aparecer na caixa de entrada para o CRM espelhar o WhatsApp.
      // Não dispara boas-vindas, questionário nem follow-up.
      const novoContato = await query(
        `INSERT INTO movatak_leads (cliente_id, telefone, nome, etapa, chat_lid, nao_lida, atualizado_em)
         VALUES ($1, $2, $3, 'lead', $4, true, NOW())
         RETURNING id`,
        [cliente.id, telefone, extrairNomeContatoPayloadZapi(body, cliente, telefone), chatLid]
      );
      const midiaNovoContato = extrairMidiaPayloadZapi(body);
      const msgIdNovoContato = body.messageId || body.id || null;
      await registrarConversa(novoContato.rows[0].id, cliente.id, 'entrada', texto || '', midiaNovoContato.url, midiaNovoContato.tipo, msgIdNovoContato, replyPayload).catch(() => null);
      await registrarEventoLead(novoContato.rows[0].id, cliente.id, 'contato_criado_whatsapp', 'Contato comum criado a partir de mensagem recebida no WhatsApp', { telefone, chatLid }).catch(() => null);
      console.log(`[zapi] Novo contato WhatsApp criado sem automação -> ${telefone} (${cliente.nome})`);
    }
  } catch (e) {
    console.error('[zapi] erro processamento:', e.message);
    // Marca o evento bruto como erro (para diagnóstico via /webhook/status). Guardado.
    if (_eventoWebhookId) {
      await query(
        `UPDATE movatak_webhook_eventos SET status='erro', erro=$1, processado_em=NOW() WHERE id=$2`,
        [String(e.message || e).slice(0, 500), _eventoWebhookId]
      ).catch(() => null);
    }
  }
}

async function registrarWebhookCliente(clienteId, resumo = {}) {
  try {
    await query(
      `UPDATE movatak_clientes
          SET ultimo_webhook_em = NOW(), ultimo_webhook_payload = $1::jsonb
        WHERE id = $2`,
      [JSON.stringify(resumo || {}), clienteId]
    );
  } catch (e) {
    console.error('[webhook-status]', e.message);
  }
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return '"' + s.replace(/"/g, '""') + '"';
}

function vendedorBateComando(vendedor, texto) {
  return contemComando(texto, comandosDoVendedor(vendedor));
}

function textoBateComandoParar(texto, comandoParar) {
  const c = String(comandoParar || '').trim();
  if (!c) return false;
  return contemComando(texto, [c]);
}

async function enviarConfirmacaoAtendente(cliente, lead) {
  if (!lead || !lead.telefone) return;
  const agora = Date.now();
  const ultima = _ultimaConfirmacaoAtendente.get(lead.id) || 0;
  if (agora - ultima < 2 * 60 * 1000) {
    console.log(`[zapi][msg-atendente] dedup — confirmação já enviada há menos de 2min pro lead ${lead.id}`);
    return;
  }
  _ultimaConfirmacaoAtendente.set(lead.id, agora);
  const primeiroNome = lead.nome ? (' ' + String(lead.nome).trim().split(' ')[0]) : '';
  const base = String(cliente.questionario_msg_parar || '').trim() || MSG_PARAR_PADRAO;
  const texto = base.replace(/\{nome\}/gi, primeiroNome);
  // enviarMsgQuestionario já trava envio pra grupos/canais e registra a conversa.
  await enviarMsgQuestionario(cliente, lead.telefone, texto, null);
  console.log(`[zapi][msg-atendente] confirmação enviada pro lead ${lead.id}`);
}

function textoBateComandoAtivar(texto, comandoAtivar) {
  const c = String(comandoAtivar || '').trim();
  if (!c) return false;
  return contemComando(texto, [c]);
}

async function moverLeadPorComandoColuna(cliente, lead, texto) {
  try {
    const cols = await query(
      `SELECT id, nome, comando FROM movatak_funil_colunas
        WHERE cliente_id=$1 AND ativo=true AND comando IS NOT NULL AND TRIM(comando) <> ''`,
      [cliente.id]
    );
    const alvo = cols.rows.find(c => contemComando(texto, [c.comando]));
    if (!alvo) return false;
    await moverLeadParaColunaFunil(lead.id, alvo.id, false);
    await registrarEventoLead(lead.id, cliente.id, 'movido_por_comando', `Lead movido para "${alvo.nome}" por comando`, { comando: alvo.comando, coluna_id: alvo.id }).catch(() => null);
    console.log(`[zapi] Lead ${lead.id} movido para coluna "${alvo.nome}" por comando`);
    return true;
  } catch (e) {
    console.error('[comando-coluna]', e.message);
    return false;
  }
}

function textoPareceComandoInterno(texto, comandos, vendedores, comandoParar, comandoAtivar) {
  const t = String(texto || '').trim();
  if (!t) return false;
  // Segurança: a mensagem deve conter pelo menos um # para ser interpretada como comando.
  // Permite que o código apareça em qualquer posição da mensagem (ex: "Fechado! #rebeka").
  if (!t.includes('#')) return false;
  if (contemComando(t, comandos.followup || [])) return true;
  if (contemComando(t, comandos.convertido || [])) return true;
  if (contemComando(t, comandos.descartar || [])) return true;
  if (contemComando(t, comandos.desfazer || [])) return true;
  if (contemComando(t, comandos.pausar || [])) return true;
  if (textoBateComandoParar(t, comandoParar)) return true;
  if (textoBateComandoAtivar(t, comandoAtivar)) return true;
  return Array.isArray(vendedores) && vendedores.some(v => vendedorBateComando(v, t));
}

function telefoneEhDaEmpresa(telefone, cliente) {
  if (!telefone || !cliente) return false;
  const candidatosEmpresa = [
    cliente.whatsapp,
    cliente.telefone,
    cliente.zapi_phone,
    cliente.numero_whatsapp,
    cliente.connectedPhone
  ].filter(Boolean);
  return candidatosEmpresa.some(n => telefonesEquivalentes(telefone, n));
}

function primeiroTelefoneValido(candidatos, cliente) {
  const vistos = new Set();
  for (const valor of candidatos) {
    const digitos = extrairDigitosTelefone(valor);
    if (!digitos || vistos.has(digitos)) continue;
    vistos.add(digitos);
    if (telefoneEhDaEmpresa(digitos, cliente)) continue;
    return digitos;
  }
  return null;
}

function extrairTelefonePayload(body, cliente = null) {
  const candidatos = body && body.fromMe
    ? [
        body.to,
        body.recipient,
        body.recipientPhone,
        body.chatId,
        body.remoteJid,
        body.key && body.key.remoteJid,
        body.message && body.message.key && body.message.key.remoteJid,
        body.phone,
        body.senderPhone,
        body.from,
        body.participantPhone
      ]
    : [
        body.phone,
        body.senderPhone,
        body.from,
        body.chatId,
        body.remoteJid,
        body.key && body.key.remoteJid,
        body.message && body.message.key && body.message.key.remoteJid,
        body.participantPhone,
        body.to,
        body.recipient,
        body.recipientPhone
      ];

  return primeiroTelefoneValido(candidatos, cliente);
}

function extrairNomeContatoPayloadZapi(body, cliente, telefone) {
  const nomes = body && body.fromMe
    ? [body.contactName, body.chatName, body.pushName, body.notifyName]
    : [body.senderName, body.contactName, body.chatName, body.pushName, body.notifyName];

  for (const nome of nomes) {
    const s = String(nome || '').trim();
    if (!s) continue;
    // Evita salvar o nome da própria empresa como nome do lead em payload fromMe.
    if (cliente && cliente.nome && s.toLowerCase() === String(cliente.nome).trim().toLowerCase()) continue;
    if (telefone && telefoneEhDaEmpresa(telefone, cliente)) continue;
    return s;
  }
  return null;
}

function extrairFotoPayloadZapi(body) {
  if (!body) return null;
  return body.senderPhoto || body.photo || body.chatPhoto || body.profileThumbnail || body.profilePicThumb || null;
}

async function buscarLeadPorTelefone(clienteId, telefone, extraWhere = '', extraParams = []) {
  const variantes = variantesTelefone(telefone);
  if (!variantes.length) return { rows: [] };
  const placeholders = variantes.map((_, i) => '$' + (i + 2)).join(',');
  const sql = `SELECT * FROM movatak_leads
                WHERE cliente_id = $1 AND telefone IN (${placeholders}) ${extraWhere}
                ORDER BY atualizado_em DESC NULLS LAST, criado_em DESC LIMIT 1`;
  return query(sql, [clienteId, ...variantes, ...extraParams]).catch(() => ({ rows: [] }));
}

function extrairTextoPayloadZapi(body) {
  return (body.text && body.text.message) ? String(body.text.message)
    : (typeof body.text === 'string') ? String(body.text)
    : (body.image && body.image.caption) ? String(body.image.caption || '')
    : (body.video && body.video.caption) ? String(body.video.caption || '')
    : (body.document && body.document.caption) ? String(body.document.caption || '')
    : (body.caption ? String(body.caption) : '');
}

function extrairMidiaPayloadZapi(body) {
  if (body.image && (body.image.imageUrl || body.image.url)) return { url: body.image.imageUrl || body.image.url, tipo: 'imagem' };
  if (body.video && (body.video.videoUrl || body.video.url)) return { url: body.video.videoUrl || body.video.url, tipo: 'video' };
  if (body.audio && (body.audio.audioUrl || body.audio.url)) return { url: body.audio.audioUrl || body.audio.url, tipo: 'audio' };
  if (body.document && (body.document.documentUrl || body.document.url)) return { url: body.document.documentUrl || body.document.url, tipo: 'documento' };
  const fallback = body.fileUrl || body.mediaUrl || null;
  return fallback ? { url: fallback, tipo: null } : { url: null, tipo: null };
}

function primeiroValor(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return null;
}

function textoDePossivelMensagem(obj) {
  if (!obj || typeof obj !== 'object') return '';
  return primeiroValor(
    obj.text && obj.text.message,
    typeof obj.text === 'string' ? obj.text : null,
    obj.message,
    obj.caption,
    obj.body,
    obj.conversation,
    obj.extendedTextMessage && obj.extendedTextMessage.text,
    obj.image && obj.image.caption,
    obj.video && obj.video.caption,
    obj.document && (obj.document.caption || obj.document.title || obj.document.fileName),
    obj.audio && 'Áudio',
    obj.image && 'Imagem',
    obj.video && 'Vídeo',
    obj.document && 'Documento'
  ) || '';
}

function tipoMidiaDePossivelMensagem(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.image) return 'imagem';
  if (obj.video) return 'video';
  if (obj.audio) return 'audio';
  if (obj.document) return 'documento';
  if (obj.midia_tipo) return obj.midia_tipo;
  if (obj.type && ['image','imagem'].includes(String(obj.type).toLowerCase())) return 'imagem';
  if (obj.type && ['audio','ptt'].includes(String(obj.type).toLowerCase())) return 'audio';
  if (obj.type && ['video'].includes(String(obj.type).toLowerCase())) return 'video';
  if (obj.type && ['document','documento','file'].includes(String(obj.type).toLowerCase())) return 'documento';
  return null;
}

function urlMidiaDePossivelMensagem(obj) {
  if (!obj || typeof obj !== 'object') return null;
  return primeiroValor(
    obj.midia_url,
    obj.image && (obj.image.imageUrl || obj.image.url),
    obj.video && (obj.video.videoUrl || obj.video.url),
    obj.audio && (obj.audio.audioUrl || obj.audio.url),
    obj.document && (obj.document.documentUrl || obj.document.url),
    obj.fileUrl,
    obj.mediaUrl
  );
}

function extrairReplyPayloadZapi(body) {
  const candidatos = [
    body.quotedMessage,
    body.quotedMsg,
    body.quoted,
    body.replyTo,
    body.reply,
    body.referenceMessage,
    body.referencedMessage,
    body.contextInfo,
    body.message && body.message.contextInfo,
    body.text && body.text.contextInfo,
    body.image && body.image.contextInfo,
    body.video && body.video.contextInfo,
    body.audio && body.audio.contextInfo,
    body.document && body.document.contextInfo,
    body.extendedTextMessage && body.extendedTextMessage.contextInfo
  ].filter(Boolean);

  let ref = candidatos.find(c => typeof c === 'object') || {};
  const quotedMessage = ref.quotedMessage || ref.message || ref.quoted || ref;
  const msgId = primeiroValor(
    body.quotedMessageId,
    body.quotedMsgId,
    body.replyMessageId,
    body.referenceMessageId,
    ref.quotedMessageId,
    ref.quotedMsgId,
    ref.messageId,
    ref.id,
    ref.stanzaId,
    ref.key && ref.key.id,
    quotedMessage && quotedMessage.messageId,
    quotedMessage && quotedMessage.id
  );

  if (!msgId && !textoDePossivelMensagem(quotedMessage) && !urlMidiaDePossivelMensagem(quotedMessage)) return null;
  return {
    reply_to_msg_id: msgId ? String(msgId) : null,
    reply_to_conteudo: textoDePossivelMensagem(quotedMessage) || null,
    reply_to_midia_url: urlMidiaDePossivelMensagem(quotedMessage) || null,
    reply_to_midia_tipo: tipoMidiaDePossivelMensagem(quotedMessage) || null,
    reply_payload: { raw_keys: Object.keys(ref || {}).slice(0, 25), quoted: quotedMessage || null }
  };
}

async function localizarLeadPorPayload(clienteId, telefone, chatLid, permitirFallbackRecente = false) {
  let rl = null;

  if (chatLid) {
    rl = await query(
      'SELECT * FROM movatak_leads WHERE cliente_id = $1 AND chat_lid = $2 ORDER BY atualizado_em DESC NULLS LAST, criado_em DESC LIMIT 1',
      [clienteId, chatLid]
    );
  }

  if ((!rl || !rl.rows.length) && telefone) {
    // Busca tolerante ao 9º dígito do celular (com/sem o 9).
    const variantes = variantesTelefone(telefone);
    const placeholders = variantes.map((_, i) => '$' + (i + 2)).join(',');
    rl = await query(
      `SELECT * FROM movatak_leads WHERE cliente_id = $1 AND telefone IN (${placeholders}) ORDER BY atualizado_em DESC NULLS LAST, criado_em DESC LIMIT 1`,
      [clienteId, ...variantes]
    );
  }

  if ((!rl || !rl.rows.length) && permitirFallbackRecente) {
    const fallback = await query(
      `SELECT * FROM movatak_leads
        WHERE cliente_id = $1
          AND etapa IN ('lead','followup','auto_atendimento','negociacao')
          AND criado_em >= NOW() - INTERVAL '48 hours'
        ORDER BY atualizado_em DESC NULLS LAST, criado_em DESC
        LIMIT 2`,
      [clienteId]
    );
    if (fallback.rows.length === 1) rl = { rows: [fallback.rows[0]] };
  }

  if (rl && rl.rows.length && chatLid && rl.rows[0].chat_lid !== chatLid) {
    await query('UPDATE movatak_leads SET chat_lid = $1, atualizado_em = NOW() WHERE id = $2', [chatLid, rl.rows[0].id]).catch(() => null);
    rl.rows[0].chat_lid = chatLid;
  }

  return rl && rl.rows.length ? rl.rows[0] : null;
}


module.exports = {
  init,
  handleMensagem,
  handleEtiqueta,
  handleResposta,
  handleStatus,
  handleZapiStatus,
  handleZapi,
};
