'use strict';

const { pool } = require('../db');
const { agendarCobranca, lerConfigCobranca } = require('../cobranca');
const { criarDisparo, controlarDisparo, listarDisparos, enviarTesteDisparo } = require('../disparo');
const { garantirEstruturaDisparos } = require('../db');

// ============================================================
// src/routes/admin.js — Fase 5a da refatoracao.
//
// As 142 rotas /movatak/admin/* foram movidas VERBATIM do index.js para
// dentro de register(app, deps). Nenhuma logica foi reescrita: os corpos dos
// handlers sao byte-a-byte identicos aos originais. Todas as dependencias
// (middlewares de auth, helpers ainda no index.js, funcoes de modulos ja
// extraidos) chegam pelo objeto deps e sao desestruturadas abaixo, de modo
// que os call sites dentro dos handlers permanecem exatamente como eram.
// ============================================================

function register(app, deps) {
  const {
    ANEXO_MAX_BYTES, ANEXO_TIPOS_OK, CAPTACAO_COTA_PLACE_DETAILS, CAPTACAO_COTA_TEXT_SEARCH, MOVATAK_ADMIN_WA,
    MOVATAK_DEBUG, MOVATAK_VERSION, NICHO_TEMPLATES, R2_BUCKET, R2_ListBucketsCommand,
    R2_PRONTO, TEMPLATES_FOLLOWUP, ZAPI_ADVANCED_ENDPOINTS, agendarFollowupV2, aplicarTemplateNichoCliente,
    authMovatak, authMovatakOuApp, axios, buscarColunaAgenda, buscarGooglePlaces,
    chamarHaiku, config, conflitoAgenda, csvEscape, emitirLeadFlags, emitirMensagemApagada, emitirMensagemLead,
    enviarFollowupsPendentesDoLead, erroEstruturaBanco, etapaSistemaPorSlug, exigeAgendamento, exigeCampanha,
    exigeColuna, exigeConversa, exigeLead, exigeMsgRapida, exigePlano,
    exigeQuestTemplate, exigeSetor, exigeTemplateFU, exigeVendedor, extrairComandosDoBody,
    followups, forcaClienteIdNaUrl, garantirColunasClientesPortal, garantirColunasVendedoresPortal, garantirEstruturaAgenda,
    garantirEstruturaCampanhasTemplates, garantirEstruturaCaptacao, garantirEstruturaConversas, garantirEstruturaFunil, garantirEstruturaMensagensRapidas,
    garantirEstruturaPlanos, garantirEstruturaQuestionario, garantirFunilPadraoCliente, gerarRespostaIALead, gerarToken,
    getZapiCreds, hashSenha, iniciarQuestionarioPorTemplate, limparPayloadAvancado, limparPedidoAtendente,
    listarTemplatesCustom, localizarCampanhaPorGatilho, marcarChatLidoNoZap, marcarChatNaoLidoNoZap, mesAtualStr, montarRelatorioDiarioCliente,
    moverLeadParaColunaFunil, normalizarGatilho, normalizarListaComandos, normalizarNichoCliente, normalizarPermissoes,
    obterLeadComZapi, obterMensagemComZapi, parseMoedaParaNumero, query, r2Client,
    r2Delete, r2Download, r2Upload, registrarConversa, registrarEventoLead,
    resolverReplyInfoLead, resolverTemplateCampanha, sincronizarColunaComWhatsapp, slugFunilPorEtapa, slugifyFunil,
    textoBateGatilho, tipoMidia, uploadSupabase, variantesTelefone, zapiApagarMensagem,
    zapiBuscarFoto, zapiEditarTexto, zapiEncaminharMensagem, zapiEnviar, zapiEnviarAudio,
    zapiEnviarContato, zapiEnviarDocumento, zapiEnviarImagem, zapiEnviarLink, zapiEnviarLocalizacao,
    zapiEnviarVideo, zapiHeaders, zapiLerMensagem, zapiListarChats, zapiModificarChat,
    zapiPhoneExiste, zapiPost, zapiQrImagem, zapiReagirMensagem, zapiRestart,
    zapiStatus,
  } = deps;
app.get('/movatak/admin/clientes', authMovatakOuApp, async (req, res) => {
  try {
    // Modo cliente (portal): retorna SOMENTE a própria operação.
    const filtroCliente = req.ehCliente ? ' WHERE c.id = $1' : '';
    const params = req.ehCliente ? [req.clienteId] : [];
    const r = await query(
      `SELECT c.id, c.nome, c.whatsapp, c.ativo, c.criado_em,
              COUNT(l.id) AS total_leads,
              COUNT(l.id) FILTER (WHERE l.etapa = 'cliente') AS convertidos,
              COUNT(l.id) FILTER (WHERE l.etapa = 'followup') AS em_followup,
              COUNT(l.id) FILTER (WHERE DATE(l.criado_em) = CURRENT_DATE) AS leads_hoje,
              COUNT(l.id) FILTER (WHERE l.etapa = 'cliente' AND DATE(COALESCE(l.convertido_em, l.atualizado_em)) = CURRENT_DATE) AS vendas_hoje
       FROM movatak_clientes c
       LEFT JOIN movatak_leads l ON l.cliente_id = c.id${filtroCliente}
       GROUP BY c.id
       ORDER BY c.criado_em DESC`,
      params
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/movatak/admin/clientes', authMovatak, async (req, res) => {
  try {
    await garantirColunasClientesPortal();
    const {
      nome, whatsapp, zapi_instance, zapi_token, zapi_client_token,
      trigger_msg, teto_cpl, planos, permissoes_portal, nicho
    } = req.body;

    if (!nome || !whatsapp || !zapi_instance || !zapi_token || !zapi_client_token) {
      return res.status(400).json({ error: 'Campos obrigatorios: nome, whatsapp, zapi_instance, zapi_token, zapi_client_token' });
    }

    const triggerPadrao = (trigger_msg && String(trigger_msg).trim()) ? String(trigger_msg).trim() : 'USAR_GATILHOS_DAS_CAMPANHAS';
    const app_token = gerarToken('mvtk');

    const r = await query(
      `INSERT INTO movatak_clientes
         (nome, whatsapp, zapi_instance, zapi_token, zapi_client_token, trigger_msg, teto_cpl, app_token, permissoes_portal)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       RETURNING id, app_token`,
      [nome, whatsapp, zapi_instance, zapi_token, zapi_client_token, triggerPadrao, teto_cpl || null, app_token, JSON.stringify(normalizarPermissoes(permissoes_portal))]
    );

    const nichoNormalizado = normalizarNichoCliente(nicho);
    if (nichoNormalizado) {
      await query('UPDATE movatak_clientes SET nicho=$1, agenda_ativa=true WHERE id=$2', [nichoNormalizado, r.rows[0].id]).catch(() => null);
      await aplicarTemplateNichoCliente(r.rows[0].id, nichoNormalizado, { sincronizar: false }).catch(e => console.error('[nicho][novo-cliente]', e.message));
    } else {
      await garantirFunilPadraoCliente(r.rows[0].id).catch(() => null);
    }

    const clienteId = r.rows[0].id;

    if (Array.isArray(planos) && planos.length) {
      for (const p of planos) {
        await query(
          'INSERT INTO movatak_planos (cliente_id, nome, valor) VALUES ($1, $2, $3)',
          [clienteId, p.nome, p.valor || null]
        );
      }
    }

    res.json({ id: clienteId, app_token: r.rows[0].app_token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/movatak/admin/clientes/:id/pos-followup', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const acao = ['mover', 'descartar'].includes(req.body && req.body.pos_followup_acao) ? req.body.pos_followup_acao : 'nenhum';
    const colunaId = (acao === 'mover' && req.body.pos_followup_coluna_id) ? parseInt(req.body.pos_followup_coluna_id) : null;
    await query(
      'UPDATE movatak_clientes SET pos_followup_acao = $1, pos_followup_coluna_id = $2 WHERE id = $3',
      [acao, colunaId, req.params.id]
    );
    res.json({ ok: true, pos_followup_acao: acao, pos_followup_coluna_id: colunaId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/admin/clientes/:id/dados', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    await garantirColunasClientesPortal();
    const r = await query(
      `SELECT id, nome, whatsapp, zapi_instance, trigger_msg, teto_cpl, nicho, agenda_ativa, permissoes_portal, acao_arquivar_ao_final, acao_marcar_nao_lido,
              boas_vindas_lead_msg1, boas_vindas_lead_msg2, boas_vindas_lead_delay,
              ia_oferta, ia_tom, ia_resumo, portal_email, portal_senha_trocada_em,
              pos_followup_acao, pos_followup_coluna_id,
              prospeccao_modo, prospeccao_zapi_instance,
              prospeccao_msg_abordagem, prospeccao_throttle_seg, prospeccao_teto_dia, prospeccao_coluna_entrada_id,
              CASE WHEN portal_senha_hash IS NULL OR portal_senha_hash = '' THEN false ELSE true END AS portal_tem_senha,
              CASE WHEN senha_trancar_hash IS NULL OR senha_trancar_hash = '' THEN false ELSE true END AS trancar_tem_senha
       FROM movatak_clientes WHERE id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Cliente nao encontrado.' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/movatak/admin/clientes/:id/credenciais-portal', authMovatak, async (req, res) => {
  try {
    const portal_email = req.body ? req.body.portal_email : undefined;
    const portal_senha = req.body ? req.body.portal_senha : undefined;
    const campos = [], valores = [];
    let idx = 1;
    if (portal_email !== undefined) {
      campos.push('portal_email = $' + idx++);
      valores.push(portal_email ? String(portal_email).trim().toLowerCase() : null);
    }
    if (portal_senha) {
      campos.push('portal_senha_hash = $' + idx++);
      valores.push(hashSenha(portal_senha));
    }
    if (!campos.length) return res.status(400).json({ error: 'Nada para salvar.' });
    valores.push(req.params.id);
    const r = await query(
      `UPDATE movatak_clientes SET ${campos.join(', ')} WHERE id = $${idx} RETURNING id`,
      valores
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/movatak/admin/clientes/:id/dados', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    await garantirColunasClientesPortal();
    let { nome, whatsapp, zapi_instance, zapi_token, zapi_client_token, trigger_msg, teto_cpl, nicho, agenda_ativa, permissoes_portal, acao_arquivar_ao_final, acao_marcar_nao_lido, boas_vindas_lead_msg1, boas_vindas_lead_msg2, boas_vindas_lead_delay, ia_oferta, ia_tom, ia_resumo, portal_email, portal_senha, senha_trancar, senha_trancar_remover, pos_followup_acao, pos_followup_coluna_id, prospeccao_modo, prospeccao_zapi_instance, prospeccao_zapi_token, prospeccao_zapi_client_token } = req.body;

    // Modo cliente (portal): NUNCA altera dados sensíveis (WhatsApp, Z-API, CPL,
    // permissões, credenciais do portal). Preserva os valores atuais do banco e
    // ignora qualquer tentativa de mudá-los, mesmo que venham forjados no corpo.
    if (req.ehCliente) {
      const atual = await query(
        'SELECT nome, whatsapp, zapi_instance, zapi_token, zapi_client_token, teto_cpl FROM movatak_clientes WHERE id = $1',
        [req.params.id]
      );
      if (!atual.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
      const a = atual.rows[0];
      whatsapp = a.whatsapp;
      zapi_instance = a.zapi_instance;
      zapi_token = undefined;          // não troca
      zapi_client_token = undefined;   // não troca
      teto_cpl = a.teto_cpl;
      if (nome === undefined || nome === null || !String(nome).trim()) nome = a.nome;
      // Bloqueia campos administrativos vindos do cliente.
      permissoes_portal = undefined;
      portal_email = undefined;
      portal_senha = undefined;
      // Senha de trancar conversas é administrativa (só o dono define/remove).
      senha_trancar = undefined;
      senha_trancar_remover = undefined;
      // Config de prospeccao (número/instância) é sensível → só admin.
      prospeccao_modo = undefined;
      prospeccao_zapi_instance = undefined;
      prospeccao_zapi_token = undefined;
      prospeccao_zapi_client_token = undefined;
    }

    if (!nome || !whatsapp || !zapi_instance) {
      return res.status(400).json({ error: 'Nome, WhatsApp e Instance ID sao obrigatorios.' });
    }

    const triggerPadrao = (trigger_msg && String(trigger_msg).trim()) ? String(trigger_msg).trim() : 'USAR_GATILHOS_DAS_CAMPANHAS';
    const campos = ['nome = $1', 'whatsapp = $2', 'zapi_instance = $3', 'trigger_msg = $4', 'teto_cpl = $5'];
    const valores = [nome, whatsapp, zapi_instance, triggerPadrao, teto_cpl ? parseFloat(teto_cpl) : null];
    let idx = 6;
    if (nicho !== undefined) { campos.push('nicho = $' + idx); valores.push(normalizarNichoCliente(nicho) || null); idx++; }
    if (agenda_ativa !== undefined) { campos.push('agenda_ativa = $' + idx); valores.push(!!agenda_ativa); idx++; }
    if (permissoes_portal) { campos.push('permissoes_portal = $' + idx + '::jsonb'); valores.push(JSON.stringify(normalizarPermissoes(permissoes_portal))); idx++; }
    if (acao_arquivar_ao_final !== undefined) { campos.push('acao_arquivar_ao_final = $' + idx); valores.push(!!acao_arquivar_ao_final); idx++; }
    if (acao_marcar_nao_lido !== undefined) { campos.push('acao_marcar_nao_lido = $' + idx); valores.push(!!acao_marcar_nao_lido); idx++; }
    if (boas_vindas_lead_msg1 !== undefined) { campos.push('boas_vindas_lead_msg1 = $' + idx); valores.push(boas_vindas_lead_msg1 || null); idx++; }
    if (boas_vindas_lead_msg2 !== undefined) { campos.push('boas_vindas_lead_msg2 = $' + idx); valores.push(boas_vindas_lead_msg2 || null); idx++; }
    if (boas_vindas_lead_delay !== undefined) { campos.push('boas_vindas_lead_delay = $' + idx); valores.push(parseInt(boas_vindas_lead_delay) || 5); idx++; }
    if (ia_oferta !== undefined) { campos.push('ia_oferta = $' + idx); valores.push(ia_oferta || null); idx++; }
    if (ia_tom !== undefined) { campos.push('ia_tom = $' + idx); valores.push(ia_tom || null); idx++; }
    if (ia_resumo !== undefined) { campos.push('ia_resumo = $' + idx); valores.push(ia_resumo || null); idx++; }
    if (pos_followup_acao !== undefined) { campos.push('pos_followup_acao = $' + idx); valores.push(['mover', 'descartar'].includes(pos_followup_acao) ? pos_followup_acao : 'nenhum'); idx++; }
    if (pos_followup_coluna_id !== undefined) { campos.push('pos_followup_coluna_id = $' + idx); valores.push(pos_followup_coluna_id ? parseInt(pos_followup_coluna_id) : null); idx++; }
    if (portal_email !== undefined) { campos.push('portal_email = $' + idx); valores.push(portal_email ? String(portal_email).trim().toLowerCase() : null); idx++; }
    if (portal_senha) { campos.push('portal_senha_hash = $' + idx); valores.push(hashSenha(portal_senha)); idx++; }
    // Senha para trancar/destrancar conversas: define quando vier preenchida; remove
    // quando senha_trancar_remover=true. Não mexe se nenhum dos dois vier.
    if (senha_trancar_remover === true) { campos.push('senha_trancar_hash = $' + idx); valores.push(null); idx++; }
    else if (senha_trancar) { campos.push('senha_trancar_hash = $' + idx); valores.push(hashSenha(String(senha_trancar))); idx++; }

    if (zapi_token && zapi_token.trim()) {
      campos.push('zapi_token = $' + idx);
      valores.push(zapi_token.trim());
      idx++;
    }
    if (zapi_client_token && zapi_client_token.trim()) {
      campos.push('zapi_client_token = $' + idx);
      valores.push(zapi_client_token.trim());
      idx++;
    }
    // [prospeccao] modo do número da prospecção ('dedicada' | 'principal') + credenciais
    // da instância dedicada. Só admin (bloqueado acima no modo cliente).
    if (prospeccao_modo !== undefined) {
      campos.push('prospeccao_modo = $' + idx);
      valores.push(['dedicada', 'principal'].includes(prospeccao_modo) ? prospeccao_modo : 'dedicada');
      idx++;
    }
    if (prospeccao_zapi_instance !== undefined) { campos.push('prospeccao_zapi_instance = $' + idx); valores.push(prospeccao_zapi_instance ? String(prospeccao_zapi_instance).trim() : null); idx++; }
    // Tokens: só sobrescreve se vier preenchido (em branco preserva o atual, igual ao zapi_token principal).
    if (prospeccao_zapi_token && String(prospeccao_zapi_token).trim()) { campos.push('prospeccao_zapi_token = $' + idx); valores.push(String(prospeccao_zapi_token).trim()); idx++; }
    if (prospeccao_zapi_client_token && String(prospeccao_zapi_client_token).trim()) { campos.push('prospeccao_zapi_client_token = $' + idx); valores.push(String(prospeccao_zapi_client_token).trim()); idx++; }

    valores.push(req.params.id);
    await query(
      `UPDATE movatak_clientes SET ${campos.join(', ')} WHERE id = $${idx}`,
      valores
    );
    const nichoAplicar = normalizarNichoCliente(nicho);
    if (nicho !== undefined && nichoAplicar) {
      await aplicarTemplateNichoCliente(req.params.id, nichoAplicar, { sincronizar: false }).catch(e => console.error('[nicho][editar-cliente]', e.message));
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/movatak/admin/clientes/:id/leads', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const r = await query(
      `SELECT l.*, p.nome AS plano_nome, s.nome AS setor_nome, s.cor AS setor_cor
       FROM movatak_leads l
       LEFT JOIN movatak_planos p ON p.id = l.plano_id
       LEFT JOIN movatak_setores s ON s.id = l.setor_id
       WHERE l.cliente_id = $1
       ORDER BY l.criado_em DESC
       LIMIT 200`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/movatak/admin/clientes/:id/ausencia', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const r = await query(
      `SELECT ausencia_msg_padrao, ausencia_horarios, ausencia_datas FROM movatak_clientes WHERE id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const row = r.rows[0];
    res.json({
      ausencia_msg_padrao: row.ausencia_msg_padrao || '',
      ausencia_horarios: Array.isArray(row.ausencia_horarios) ? row.ausencia_horarios : [],
      ausencia_datas: Array.isArray(row.ausencia_datas) ? row.ausencia_datas : []
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/admin/clientes/:id/ausencia', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const { ausencia_msg_padrao, ausencia_horarios, ausencia_datas } = req.body || {};
    const horarios = Array.isArray(ausencia_horarios) ? ausencia_horarios : [];
    const datas = Array.isArray(ausencia_datas) ? ausencia_datas : [];
    await query(
      `UPDATE movatak_clientes
         SET ausencia_msg_padrao = $1, ausencia_horarios = $2::jsonb, ausencia_datas = $3::jsonb
       WHERE id = $4`,
      [ausencia_msg_padrao || null, JSON.stringify(horarios), JSON.stringify(datas), req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/admin/clientes/:id/followup', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const r = await query(
      `SELECT followup_msgs_v2, followup_msgs, boas_vindas_msg, verba_diaria, whatsapp_dono, trigger_msg, comandos, cobranca_v2
       FROM movatak_clientes WHERE id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Cliente nao encontrado.' });

    const row = r.rows[0];

    // Garante compatibilidade com bancos que ainda tenham mensagens no formato antigo.
    const legado = row.followup_msgs || {};
    const padrao = {
      fu1: {
        msg1: 'Oi {nome}! Tudo bem? Passei aqui pra saber se ficou alguma duvida. Estou a disposicao!',
        msg2: '{nome}! Ainda temos disponibilidade pra voce. Se quiser retomar a conversa, e so chamar!'
      },
      fu2: {
        msg1: '',
        msg2: '',
        msg3: ''
      }
    };

    const v2 = row.followup_msgs_v2 || {
      fu1: {
        msg1: legado.msg1 || padrao.fu1.msg1,
        msg2: legado.msg2 || padrao.fu1.msg2
      },
      fu2: {
        msg1: legado.msg3 || padrao.fu2.msg1,
        msg2: legado.msg4 || padrao.fu2.msg2,
        msg3: legado.msg5 || padrao.fu2.msg3
      }
    };

    const followup_v2 = {
      fu1: {
        msg1: (v2.fu1 && v2.fu1.msg1) || padrao.fu1.msg1,
        msg2: (v2.fu1 && v2.fu1.msg2) || padrao.fu1.msg2
      },
      fu2: {
        msg1: (v2.fu2 && v2.fu2.msg1) || '',
        msg2: (v2.fu2 && v2.fu2.msg2) || '',
        msg3: (v2.fu2 && v2.fu2.msg3) || ''
      }
    };

    // Retorna em formatos diferentes para não quebrar o admin.html, mesmo que ele esteja lendo nomes antigos.
    res.json({
      followup_v2,
      followup_msgs_v2: followup_v2,
      fu1: followup_v2.fu1,
      fu2: followup_v2.fu2,
      msg1: followup_v2.fu1.msg1,
      msg2: followup_v2.fu1.msg2,
      msg3: followup_v2.fu2.msg1,
      msg4: followup_v2.fu2.msg2,
      msg5: followup_v2.fu2.msg3,
      boas_vindas_msg: row.boas_vindas_msg || 'Seja bem-vindo(a){nome}! Estamos muito felizes em ter voce conosco. Em breve entraremos em contato com os proximos passos. Qualquer duvida, e so chamar!',
      verba_diaria: row.verba_diaria || null,
      whatsapp_dono: row.whatsapp_dono || null,
      trigger_msg: row.trigger_msg || '',
      comandos: row.comandos || { followup: [], convertido: [], descartar: [], desfazer: [] },
      comando_followup: ((row.comandos || {}).followup || []).join(', '),
      comando_convertido: ((row.comandos || {}).convertido || []).join(', '),
      comando_descartar: ((row.comandos || {}).descartar || []).join(', '),
      comando_desfazer: ((row.comandos || {}).desfazer || []).join(', '),
      cobranca_v2: (row.cobranca_v2 && typeof row.cobranca_v2 === 'object' && Object.keys(row.cobranca_v2).length)
        ? row.cobranca_v2
        : { gatilho: '', ativo: false, msgs: [{ texto: '', horas: 3 }, { texto: '', horas: 24 }, { texto: '', horas: 48 }] }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/admin/clientes/:id/followup', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const { boas_vindas_msg, verba_diaria, whatsapp_dono, trigger_msg } = req.body;

    // O painel pode enviar como followup_v2, followup_msgs_v2, fu1/fu2 ou campos soltos.
    // Esta normalização evita o problema de "aparece na tela, mas não grava".
    const recebido = req.body.followup_v2 || req.body.followup_msgs_v2 || {};
    const followup_v2 = {
      fu1: {
        msg1: String((recebido.fu1 && recebido.fu1.msg1) || (req.body.fu1 && req.body.fu1.msg1) || req.body.fu1_msg1 || req.body.msg1 || '').trim(),
        msg2: String((recebido.fu1 && recebido.fu1.msg2) || (req.body.fu1 && req.body.fu1.msg2) || req.body.fu1_msg2 || req.body.msg2 || '').trim()
      },
      fu2: {
        msg1: String((recebido.fu2 && recebido.fu2.msg1) || (req.body.fu2 && req.body.fu2.msg1) || req.body.fu2_msg1 || req.body.msg3 || '').trim(),
        msg2: String((recebido.fu2 && recebido.fu2.msg2) || (req.body.fu2 && req.body.fu2.msg2) || req.body.fu2_msg2 || req.body.msg4 || '').trim(),
        msg3: String((recebido.fu2 && recebido.fu2.msg3) || (req.body.fu2 && req.body.fu2.msg3) || req.body.fu2_msg3 || req.body.msg5 || '').trim()
      }
    };

    // Recuperação de carrinho / cobrança: { gatilho, ativo, msgs:[{texto,horas}] }.
    // Só grava se o payload trouxe cobranca_v2 (COALESCE preserva o valor atual senão).
    let cobrancaJson = null;
    if (req.body.cobranca_v2 && typeof req.body.cobranca_v2 === 'object') {
      const cb = req.body.cobranca_v2;
      const msgs = Array.isArray(cb.msgs) ? cb.msgs.slice(0, 6) : [];
      cobrancaJson = JSON.stringify({
        gatilho: String(cb.gatilho || '').trim(),
        ativo: !!cb.ativo,
        msgs: msgs.map(m => ({ texto: String((m && m.texto) || '').trim(), horas: Math.max(0, Number((m && m.horas) || 0)) }))
      });
    }

    await query(
      `UPDATE movatak_clientes
         SET followup_msgs_v2 = $1::jsonb,
             boas_vindas_msg = $2,
             verba_diaria = COALESCE($3, verba_diaria),
             whatsapp_dono = COALESCE($4, whatsapp_dono),
             trigger_msg = COALESCE($5, trigger_msg),
             cobranca_v2 = COALESCE($7::jsonb, cobranca_v2)
       WHERE id = $6`,
      [
        JSON.stringify(followup_v2),
        boas_vindas_msg || null,
        verba_diaria ? parseFloat(String(verba_diaria).replace(',', '.')) : null,
        whatsapp_dono ? String(whatsapp_dono).replace(/\D/g, '') : null,
        (trigger_msg && String(trigger_msg).trim()) ? String(trigger_msg).trim() : null,
        req.params.id,
        cobrancaJson
      ]
    );

    // Alguns admin.html salvam todos os blocos pela própria rota /followup.
    // Se vierem comandos no mesmo payload, salva também para não perder o bloco 6 da tela.
    const temComandosNoPayload = req.body.comandos || req.body.followup || req.body.convertido || req.body.descartar || req.body.desfazer ||
      req.body.comando_followup || req.body.comando_convertido || req.body.comando_vendido || req.body.comando_descartar || req.body.comando_desfazer || req.body.comando_estornar;
    let comandosSalvos = null;
    if (temComandosNoPayload) {
      comandosSalvos = extrairComandosDoBody(req.body);
      await query(
        'UPDATE movatak_clientes SET comandos = $1::jsonb WHERE id = $2',
        [JSON.stringify(comandosSalvos), req.params.id]
      );
      console.log('[comandos][salvo-via-followup]', JSON.stringify({ clienteId: req.params.id, comandos: comandosSalvos }));
    }

    console.log('[followup][salvo]', JSON.stringify({ clienteId: req.params.id, followup_v2 }));
    res.json({ ok: true, followup_v2, comandos: comandosSalvos });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Investimento consolidado + WhatsApp do dono para alertas. Vive no menu
// "Campanhas & Operação" (separado do follow-up). Atualiza SÓ esses dois campos.
app.patch('/movatak/admin/clientes/:id/investimento-alertas', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const { verba_diaria, whatsapp_dono } = req.body || {};
    await query(
      `UPDATE movatak_clientes SET verba_diaria = $1, whatsapp_dono = $2 WHERE id = $3`,
      [
        (verba_diaria !== undefined && verba_diaria !== null && String(verba_diaria).trim() !== '') ? parseFloat(String(verba_diaria).replace(',', '.')) : null,
        (whatsapp_dono && String(whatsapp_dono).trim()) ? String(whatsapp_dono).replace(/\D/g, '') : null,
        req.params.id
      ]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/admin/leads/:id/plano', ...exigeLead, async (req, res) => {
  try {
    const { plano_id } = req.body;
    await query(
      'UPDATE movatak_leads SET plano_id = $1, atualizado_em = NOW() WHERE id = $2',
      [plano_id, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/movatak/admin/clientes/:id/vendedores', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    await garantirColunasVendedoresPortal();
    const r = await query(
      `SELECT id, cliente_id, nome, comando, email_acesso, acesso_token, ativo, criado_em,
              CASE WHEN senha_hash IS NULL OR senha_hash = '' THEN false ELSE true END AS tem_senha
         FROM movatak_vendedores
        WHERE cliente_id = $1 AND COALESCE(ativo, true) = true
        ORDER BY nome`,
      [req.params.id]
    );
    // Setores de cada vendedor (pra marcar os checkboxes no cadastro).
    const sv = await query(
      `SELECT sv.vendedor_id, sv.setor_id FROM movatak_setor_vendedores sv
         JOIN movatak_vendedores v ON v.id = sv.vendedor_id
        WHERE v.cliente_id = $1`,
      [req.params.id]
    ).catch(() => ({ rows: [] }));
    const setoresPorVend = {};
    sv.rows.forEach(row => {
      (setoresPorVend[row.vendedor_id] = setoresPorVend[row.vendedor_id] || []).push(Number(row.setor_id));
    });
    const rows = r.rows.map(v => ({ ...v, setor_ids: setoresPorVend[v.id] || [] }));
    res.json(rows);
  } catch(e) {
    console.error('[admin/vendedores:list]', e.message);
    // Fallback para bancos antigos/parcialmente migrados: permite o painel abrir e mostra os dados básicos.
    try {
      const r2 = await query(
        `SELECT id, cliente_id, nome, NULL::text AS comando, NULL::text AS email_acesso,
                NULL::text AS acesso_token, ativo, criado_em, false AS tem_senha
           FROM movatak_vendedores
          WHERE cliente_id = $1 AND COALESCE(ativo, true) = true
          ORDER BY nome`,
        [req.params.id]
      );
      return res.json(r2.rows);
    } catch(e2) {
      console.error('[admin/vendedores:list:fallback]', e2.message);
      res.status(500).json({ error: e.message });
    }
  }
});

app.post('/movatak/admin/clientes/:id/vendedores', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    await garantirColunasVendedoresPortal();
    const { nome, email_acesso, senha_acesso, comando } = req.body;
    if (!nome) return res.status(400).json({ error: 'Nome obrigatorio.' });

    const rc = await query('SELECT * FROM movatak_clientes WHERE id = $1', [req.params.id]);
    if (!rc.rows.length) return res.status(404).json({ error: 'Cliente nao encontrado.' });
    const cliente = rc.rows[0];

    // Salvar vendedor — etiqueta deve ser criada manualmente no WhatsApp Business
    // com o nome exato: 'Vendedor - ' + nome
    const r = await query(
      `INSERT INTO movatak_vendedores (cliente_id, nome, email_acesso, senha_hash, acesso_token, comando)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, cliente_id, nome, comando, email_acesso, acesso_token, ativo, criado_em`,
      [req.params.id, nome, email_acesso || null, hashSenha(senha_acesso), gerarToken('vend'), comando ? String(comando).trim().toLowerCase() : null]
    );
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/movatak/admin/clientes/:clienteId/vendedores/:id', ...exigeVendedor, async (req, res) => {
  try {
    await query('UPDATE movatak_vendedores SET ativo = false WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/admin/clientes/:id/setores', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const r = await query(
      `SELECT s.id, s.cliente_id, s.nome, s.cor, s.mensagem_saudacao, s.ordem_bot, s.ativo, s.criado_em,
              COALESCE(
                json_agg(
                  json_build_object('id', v.id, 'nome', v.nome)
                ) FILTER (WHERE v.id IS NOT NULL), '[]'
              ) AS vendedores
         FROM movatak_setores s
         LEFT JOIN movatak_setor_vendedores sv ON sv.setor_id = s.id
         LEFT JOIN movatak_vendedores v ON v.id = sv.vendedor_id AND COALESCE(v.ativo, true) = true
        WHERE s.cliente_id = $1 AND COALESCE(s.ativo, true) = true
        GROUP BY s.id
        ORDER BY s.ordem_bot, s.nome`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch(e) {
    console.error('[admin/setores:list]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/movatak/admin/clientes/:id/setores', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const { nome, cor, mensagem_saudacao, ordem_bot, vendedor_ids } = req.body;
    if (!nome) return res.status(400).json({ error: 'Nome do setor é obrigatório.' });

    const rc = await query('SELECT id FROM movatak_clientes WHERE id = $1', [req.params.id]);
    if (!rc.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });

    const r = await query(
      `INSERT INTO movatak_setores (cliente_id, nome, cor, mensagem_saudacao, ordem_bot)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, cliente_id, nome, cor, mensagem_saudacao, ordem_bot, ativo, criado_em`,
      [req.params.id, nome, cor || '#3B82F6', mensagem_saudacao || null, parseInt(ordem_bot) || 0]
    );
    const setor = r.rows[0];

    // Vincula vendedores já na criação, se a lista foi enviada
    if (Array.isArray(vendedor_ids) && vendedor_ids.length) {
      for (const vid of vendedor_ids) {
        await query(
          `INSERT INTO movatak_setor_vendedores (setor_id, vendedor_id)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [setor.id, parseInt(vid)]
        );
      }
    }

    res.json(setor);
  } catch(e) {
    console.error('[admin/setores:create]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.patch('/movatak/admin/setores/:id', ...exigeSetor, async (req, res) => {
  try {
    const { nome, cor, mensagem_saudacao, ordem_bot } = req.body;
    const r = await query(
      `UPDATE movatak_setores
          SET nome = COALESCE($1, nome),
              cor = COALESCE($2, cor),
              mensagem_saudacao = COALESCE($3, mensagem_saudacao),
              ordem_bot = COALESCE($4, ordem_bot)
        WHERE id = $5
        RETURNING id, cliente_id, nome, cor, mensagem_saudacao, ordem_bot, ativo, criado_em`,
      [nome || null, cor || null, mensagem_saudacao || null, ordem_bot != null ? parseInt(ordem_bot) : null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Setor não encontrado.' });
    res.json(r.rows[0]);
  } catch(e) {
    console.error('[admin/setores:edit]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/movatak/admin/setores/:id', ...exigeSetor, async (req, res) => {
  try {
    await query('UPDATE movatak_setores SET ativo = false WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) {
    console.error('[admin/setores:delete]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/movatak/admin/setores/:id/vendedores', ...exigeSetor, async (req, res) => {
  try {
    const { vendedor_id } = req.body;
    if (!vendedor_id) return res.status(400).json({ error: 'vendedor_id é obrigatório.' });
    await query(
      `INSERT INTO movatak_setor_vendedores (setor_id, vendedor_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.params.id, parseInt(vendedor_id)]
    );
    res.json({ ok: true });
  } catch(e) {
    console.error('[admin/setores:vincular-vendedor]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/movatak/admin/setores/:id/vendedores/:vendedorId', ...exigeSetor, async (req, res) => {
  try {
    await query(
      'DELETE FROM movatak_setor_vendedores WHERE setor_id = $1 AND vendedor_id = $2',
      [req.params.id, req.params.vendedorId]
    );
    res.json({ ok: true });
  } catch(e) {
    console.error('[admin/setores:desvincular-vendedor]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.patch('/movatak/admin/leads/:id/setor', ...exigeLead, async (req, res) => {
  try {
    const setorDestinoId = req.body && req.body.setor_id ? parseInt(req.body.setor_id) : null;
    const vendedorDestinoId = req.body && req.body.vendedor_id ? parseInt(req.body.vendedor_id) : null;
    if (!setorDestinoId) return res.status(400).json({ error: 'setor_id é obrigatório.' });

    const lead = await query(
      'SELECT id, cliente_id, setor_id, vendedor_id FROM movatak_leads WHERE id = $1',
      [req.params.id]
    );
    if (!lead.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    const leadAtual = lead.rows[0];

    const setorDestino = await query(
      'SELECT id, nome, cliente_id FROM movatak_setores WHERE id = $1',
      [setorDestinoId]
    );
    if (!setorDestino.rows.length) return res.status(404).json({ error: 'Setor de destino não encontrado.' });
    if (setorDestino.rows[0].cliente_id !== leadAtual.cliente_id) {
      return res.status(400).json({ error: 'Setor de destino não pertence ao mesmo cliente do lead.' });
    }

    if (vendedorDestinoId) {
      await query(
        `UPDATE movatak_leads SET setor_id = $1, vendedor_id = $2, atualizado_em = NOW() WHERE id = $3`,
        [setorDestinoId, vendedorDestinoId, req.params.id]
      );
    } else {
      await query(
        `UPDATE movatak_leads SET setor_id = $1, atualizado_em = NOW() WHERE id = $2`,
        [setorDestinoId, req.params.id]
      );
    }

    // Move o lead para a PRIMEIRA coluna do kanban desse setor (menor ordem).
    // Regra do Ronaldo: a 1ª coluna de cada setor é a "lista de leads" daquele setor.
    let colunaDestino = null;
    const primeiraColuna = await query(
      `SELECT id, nome FROM movatak_funil_colunas
        WHERE cliente_id = $1 AND ativo = true AND setor_id = $2
        ORDER BY ordem ASC, id ASC LIMIT 1`,
      [leadAtual.cliente_id, setorDestinoId]
    );
    if (primeiraColuna.rows.length) {
      colunaDestino = primeiraColuna.rows[0];
      await query(
        `UPDATE movatak_leads SET funil_coluna_id = $1, atualizado_em = NOW() WHERE id = $2`,
        [colunaDestino.id, req.params.id]
      );
    }

    // Ao chegar num setor DIFERENTE, marca como não lida pra equipe do destino ver
    // que há um lead novo aguardando (mesma marcação de "mensagem não lida" do inbox).
    // Emite lead:flags pra aparecer na hora nos painéis abertos do destino.
    if (Number(leadAtual.setor_id) !== setorDestinoId) {
      await query(`UPDATE movatak_leads SET nao_lida = true WHERE id = $1`, [req.params.id]).catch(() => null);
      emitirLeadFlags(leadAtual.cliente_id, Number(req.params.id), { nao_lida: true });
    }

    await registrarEventoLead(
      req.params.id,
      leadAtual.cliente_id,
      'transferencia_setor',
      `Lead transferido para o setor ${setorDestino.rows[0].nome}`,
      {
        setor_origem_id: leadAtual.setor_id,
        setor_destino_id: setorDestinoId,
        vendedor_origem_id: leadAtual.vendedor_id,
        vendedor_destino_id: vendedorDestinoId || leadAtual.vendedor_id
      }
    );

    res.json({
      ok: true,
      setor_nome: setorDestino.rows[0].nome,
      coluna_destino: colunaDestino ? colunaDestino.nome : null
    });
  } catch(e) {
    console.error('[admin/leads:transferir-setor]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.patch('/movatak/admin/leads/:id/marcar-lida', ...exigeLead, async (req, res) => {
  try {
    const naoLida = !!(req.body && req.body.nao_lida);
    const upd = await query(`UPDATE movatak_leads SET nao_lida = $1 WHERE id = $2 AND nao_lida IS DISTINCT FROM $1 RETURNING id`, [naoLida, req.params.id]);
    if (!naoLida) {
      // Marcar LIDO: espelha no WhatsApp SEMPRE que o atendente abre/lê — mesmo que o
      // CRM já estivesse nao_lida=false (ex.: automação respondeu antes). A função tem
      // trava anti-spam (zap_lido_msg_id), então só chama a Z-API se há inbound novo.
      marcarChatLidoNoZap(req.params.id);
    } else if (upd.rows.length) {
      // Marcar NÃO LIDO: só quando realmente mudou de estado (ação explícita do usuário).
      marcarChatNaoLidoNoZap(req.params.id);
    }
    res.json({ ok: true, nao_lida: naoLida });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/movatak/admin/leads/:id/foto/expirada', ...exigeLead, async (req, res) => {
  try {
    await query(`UPDATE movatak_leads SET foto_url=NULL WHERE id=$1`, [req.params.id]).catch(() => null);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/admin/leads/:id/foto', ...exigeLead, async (req, res) => {
  try {
    const r = await query(
      `SELECT l.id, l.telefone, l.foto_url, l.foto_atualizada_em,
              c.zapi_instance, c.zapi_token, c.zapi_client_token
         FROM movatak_leads l JOIN movatak_clientes c ON c.id = l.cliente_id
        WHERE l.id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    const lead = r.rows[0];
    const agora = Date.now();
    const idade = lead.foto_atualizada_em ? (agora - new Date(lead.foto_atualizada_em).getTime()) : Infinity;
    const cacheValido = lead.foto_url && idade < 24 * 3600 * 1000;
    if (cacheValido) return res.json({ foto_url: lead.foto_url });

    if (!lead.zapi_instance || !lead.zapi_token || !lead.zapi_client_token || !lead.telefone) {
      return res.json({ foto_url: lead.foto_url || null });
    }
    const foto = await zapiBuscarFoto(lead.zapi_instance, lead.zapi_token, lead.zapi_client_token, lead.telefone);
    if (foto) {
      await query(`UPDATE movatak_leads SET foto_url=$1, foto_atualizada_em=NOW() WHERE id=$2`, [foto, lead.id]).catch(() => null);
    }
    res.json({ foto_url: foto || lead.foto_url || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/admin/leads/:id/arquivar', ...exigeLead, async (req, res) => {
  try {
    const arquivado = req.body && typeof req.body.arquivado === 'boolean' ? req.body.arquivado : true;
    await query(`UPDATE movatak_leads SET arquivado = $1, atualizado_em = NOW() WHERE id = $2`, [arquivado, req.params.id]);
    res.json({ ok: true, arquivado });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Trancar/destrancar conversa: esconde o lead da inbox e do kanban (só visível no
// filtro "Trancadas"). NÃO mexe no WhatsApp — é uma trava local do CRM. Não altera
// atualizado_em pra não reordenar a inbox ao destrancar.
app.patch('/movatak/admin/leads/:id/trancar', ...exigeLead, async (req, res) => {
  try {
    const trancado = req.body && typeof req.body.trancado === 'boolean' ? req.body.trancado : true;
    const senha = req.body ? req.body.senha : undefined;
    // Se o cliente definiu uma senha para trancar conversas, ela é obrigatória e
    // validada aqui (server-side). Sem senha definida, o fluxo segue como antes.
    const cli = await query(
      `SELECT c.senha_trancar_hash FROM movatak_leads l JOIN movatak_clientes c ON c.id = l.cliente_id WHERE l.id = $1`,
      [req.params.id]
    );
    const hash = cli.rows.length ? cli.rows[0].senha_trancar_hash : null;
    if (hash) {
      if (!senha || hashSenha(String(senha)) !== hash) {
        return res.status(403).json({ error: 'Senha incorreta.', senha_requerida: true });
      }
    }
    await query(`UPDATE movatak_leads SET trancado = $1 WHERE id = $2`, [trancado, req.params.id]);
    res.json({ ok: true, trancado });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/movatak/admin/clientes/:id/ranking', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const r = await query(
      `SELECT v.nome, COUNT(l.id) AS vendas, COUNT(l.id) FILTER (WHERE l.etapa = 'cliente') AS fechamentos
       FROM movatak_vendedores v
       LEFT JOIN movatak_leads l ON l.vendedor_id = v.id
       WHERE v.cliente_id = $1 AND COALESCE(v.ativo, true) = true
       GROUP BY v.id, v.nome
       ORDER BY fechamentos DESC`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/admin/clientes/:id/dono', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const { whatsapp_dono } = req.body;
    await query('UPDATE movatak_clientes SET whatsapp_dono = $1 WHERE id = $2', [whatsapp_dono, req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/admin/clientes/:id/comandos', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const r = await query(
      'SELECT comandos FROM movatak_clientes WHERE id = $1', [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Cliente nao encontrado.' });
    res.json(r.rows[0].comandos || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/admin/clientes/:id/comandos', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    // O painel envia os comandos como texto: "#vendido, #fechou".
    // A versão anterior só aceitava arrays, por isso a tela parecia salvar, mas voltava ao padrão.
    const comandos = extrairComandosDoBody(req.body);

    // Validação: nenhum comando pode se repetir entre os campos
    const todos = [
      ...comandos.followup, ...comandos.convertido,
      ...comandos.descartar, ...comandos.desfazer, ...(comandos.pausar || [])
    ];
    const duplicado = todos.find((c, i) => todos.indexOf(c) !== i);
    if (duplicado) {
      return res.status(400).json({ error: 'O comando "' + duplicado + '" esta repetido. Cada comando deve ser unico.' });
    }

    // Validação: não pode colidir com comando de vendedor já cadastrado
    const rv = await query(
      'SELECT comando FROM movatak_vendedores WHERE cliente_id = $1 AND COALESCE(ativo, true) = true AND comando IS NOT NULL',
      [req.params.id]
    );
    const cmdsVendedores = rv.rows
      .flatMap(r => normalizarListaComandos(r.comando))
      .map(c => String(c).trim().toLowerCase());
    const colisao = todos.find(c => cmdsVendedores.includes(c));
    if (colisao) {
      return res.status(400).json({ error: 'O comando "' + colisao + '" ja pertence a um vendedor.' });
    }

    await query(
      'UPDATE movatak_clientes SET comandos = $1::jsonb WHERE id = $2',
      [JSON.stringify(comandos), req.params.id]
    );
    console.log('[comandos][salvo]', JSON.stringify({ clienteId: req.params.id, comandos }));
    res.json({ ok: true, comandos });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/admin/clientes/:id/menu-atendimento', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const r = await query(
      `SELECT menu_atend_ativo, menu_atend_texto, menu_atend_posicao, menu_atend_mapa, menu_atend_marcar_nao_lido
         FROM movatak_clientes WHERE id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const row = r.rows[0];
    res.json({
      ativo: !!row.menu_atend_ativo,
      texto: row.menu_atend_texto || '',
      posicao: row.menu_atend_posicao || 'apos_boas_vindas',
      mapa: Array.isArray(row.menu_atend_mapa) ? row.menu_atend_mapa : [],
      marcar_nao_lido: !!row.menu_atend_marcar_nao_lido
    });
  } catch (e) {
    console.error('[menu-atendimento:get]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.patch('/movatak/admin/clientes/:id/menu-atendimento', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const { ativo, texto, posicao, mapa, marcar_nao_lido } = req.body || {};
    const posicaoValida = ['apos_boas_vindas', 'apos_questionario'].includes(posicao) ? posicao : 'apos_boas_vindas';
    // mapa = lista de { resposta, setor_id, coluna_id }
    const mapaLimpo = Array.isArray(mapa)
      ? mapa
          .filter(m => m && m.resposta != null && String(m.resposta).trim() !== '' && m.setor_id)
          .map(m => ({
            resposta: String(m.resposta).trim().toLowerCase(),
            setor_id: parseInt(m.setor_id),
            coluna_id: m.coluna_id ? parseInt(m.coluna_id) : null,
            template_id: m.template_id ? parseInt(m.template_id) : null
          }))
      : [];

    await query(
      `UPDATE movatak_clientes
          SET menu_atend_ativo = $1,
              menu_atend_texto = $2,
              menu_atend_posicao = $3,
              menu_atend_mapa = $4::jsonb,
              menu_atend_marcar_nao_lido = $5
        WHERE id = $6`,
      [!!ativo, texto || null, posicaoValida, JSON.stringify(mapaLimpo), !!marcar_nao_lido, req.params.id]
    );
    res.json({ ok: true, ativo: !!ativo, texto: texto || '', posicao: posicaoValida, mapa: mapaLimpo, marcar_nao_lido: !!marcar_nao_lido });
  } catch (e) {
    console.error('[menu-atendimento:patch]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.patch('/movatak/admin/vendedores/:id/comando', ...exigeVendedor, async (req, res) => {
  try {
    await garantirColunasVendedoresPortal();
    const comando = req.body.comando ? String(req.body.comando).trim().toLowerCase() : null;

    if (comando) {
      // Descobrir o cliente deste vendedor
      const rv = await query('SELECT cliente_id FROM movatak_vendedores WHERE id = $1', [req.params.id]);
      if (!rv.rows.length) return res.status(404).json({ error: 'Vendedor nao encontrado.' });
      const clienteId = rv.rows[0].cliente_id;

      // Não pode colidir com comandos do cliente
      const rc = await query('SELECT comandos FROM movatak_clientes WHERE id = $1', [clienteId]);
      const cmds = rc.rows[0] && rc.rows[0].comandos ? rc.rows[0].comandos : {};
      const todosCliente = [
        ...(cmds.followup || []), ...(cmds.convertido || []),
        ...(cmds.descartar || []), ...(cmds.desfazer || []), ...(cmds.pausar || [])
      ].map(c => String(c).trim().toLowerCase());
      if (todosCliente.includes(comando)) {
        return res.status(400).json({ error: 'Esse comando ja esta em uso na automacao do cliente.' });
      }

      // Não pode colidir com outro vendedor
      const ro = await query(
        'SELECT comando FROM movatak_vendedores WHERE cliente_id = $1 AND id != $2 AND COALESCE(ativo, true) = true AND comando IS NOT NULL',
        [clienteId, req.params.id]
      );
      if (ro.rows.some(r => String(r.comando).trim().toLowerCase() === comando)) {
        return res.status(400).json({ error: 'Esse comando ja pertence a outro vendedor.' });
      }
    }

    await query(
      'UPDATE movatak_vendedores SET comando = $1 WHERE id = $2',
      [comando, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/admin/vendedores/:id/acesso', ...exigeVendedor, async (req, res) => {
  try {
    await garantirColunasVendedoresPortal();
    const { email_acesso, senha_acesso, nome, comando } = req.body || {};
    const campos = [];
    const valores = [];
    let idx = 1;
    if (nome !== undefined) { campos.push('nome = $' + idx++); valores.push(String(nome).trim()); }
    if (email_acesso !== undefined) { campos.push('email_acesso = $' + idx++); valores.push(email_acesso ? String(email_acesso).trim().toLowerCase() : null); }
    if (senha_acesso) { campos.push('senha_hash = $' + idx++); valores.push(hashSenha(senha_acesso)); }
    if (comando !== undefined) { campos.push('comando = $' + idx++); valores.push(comando ? String(comando).trim().toLowerCase() : null); }
    if (!campos.length) return res.json({ ok: true });
    valores.push(req.params.id);
    const r = await query(`UPDATE movatak_vendedores SET ${campos.join(', ')} WHERE id = $${idx} RETURNING id, nome, comando, email_acesso, acesso_token`, valores);
    if (!r.rows.length) return res.status(404).json({ error: 'Vendedor não encontrado.' });
    res.json({ ok: true, vendedor: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/admin/vendedores/:id/setores', ...exigeVendedor, async (req, res) => {
  try {
    const vendedorId = parseInt(req.params.id, 10);
    const setorIds = Array.isArray(req.body && req.body.setor_ids) ? req.body.setor_ids.map(n => parseInt(n, 10)).filter(Boolean) : [];
    // Confirma que o vendedor existe e pega o cliente, pra só aceitar setores do mesmo cliente.
    const v = await query('SELECT cliente_id FROM movatak_vendedores WHERE id = $1', [vendedorId]);
    if (!v.rows.length) return res.status(404).json({ error: 'Vendedor não encontrado.' });
    const clienteId = v.rows[0].cliente_id;
    // Remove todos os vínculos atuais e recria com os enviados (que sejam do cliente).
    await query('DELETE FROM movatak_setor_vendedores WHERE vendedor_id = $1', [vendedorId]);
    for (const sid of setorIds) {
      const ok = await query('SELECT 1 FROM movatak_setores WHERE id = $1 AND cliente_id = $2 AND COALESCE(ativo,true)=true', [sid, clienteId]);
      if (ok.rows.length) {
        await query('INSERT INTO movatak_setor_vendedores (setor_id, vendedor_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [sid, vendedorId]).catch(() => null);
      }
    }
    res.json({ ok: true, setor_ids: setorIds });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/admin/clientes/:id/resumo', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const id = req.params.id;
    // Período em dias: 0 = hoje, 7, 30, 90. Default 30.
    const dias = [0, 7, 30, 90].includes(parseInt(req.query.dias))
      ? parseInt(req.query.dias) : 30;

    // Períodos reutilizáveis: leads por data de entrada; vendas por data de conversão.
    const leadPeriodoSQL = dias === 0
      ? "DATE(criado_em) = CURRENT_DATE"
      : `criado_em >= NOW() - INTERVAL '${dias} days'`;
    const vendaPeriodoSQL = dias === 0
      ? "DATE(COALESCE(convertido_em, atualizado_em)) = CURRENT_DATE"
      : `COALESCE(convertido_em, atualizado_em) >= NOW() - INTERVAL '${dias} days'`;

    // Métricas do cliente no período
    const m = await query(
      `SELECT
         COUNT(*) FILTER (WHERE etapa != 'descartado' AND ${leadPeriodoSQL})  AS total_leads,
         COUNT(*) FILTER (WHERE etapa = 'cliente' AND ${vendaPeriodoSQL})     AS convertidos,
         COUNT(*) FILTER (WHERE etapa = 'followup')                           AS em_followup,
         COUNT(*) FILTER (WHERE DATE(criado_em) = CURRENT_DATE)               AS leads_hoje,
         COUNT(*) FILTER (WHERE etapa = 'cliente' AND DATE(COALESCE(convertido_em, atualizado_em)) = CURRENT_DATE) AS vendas_hoje
       FROM movatak_leads
       WHERE cliente_id = $1`,
      [id]
    );

    // Leads por hora do dia de hoje (0-23) — sempre do dia atual
    const h = await query(
      `SELECT EXTRACT(HOUR FROM criado_em)::int AS hora, COUNT(*) AS leads
       FROM movatak_leads
       WHERE cliente_id = $1 AND DATE(criado_em) = CURRENT_DATE
       GROUP BY hora ORDER BY hora`,
      [id]
    );
    const leadsPorHora = Array.from({ length: 24 }, (_, i) => {
      const found = h.rows.find(r => r.hora === i);
      return { hora: i, leads: found ? parseInt(found.leads) : 0 };
    });

    // Vendas por vendedor no período
    const v = await query(
      `SELECT vd.nome,
              COUNT(l.id) FILTER (WHERE l.etapa = 'cliente' AND ${vendaPeriodoSQL.replace(/COALESCE\(convertido_em, atualizado_em\)/g, 'COALESCE(l.convertido_em, l.atualizado_em)')}) AS fechamentos,
              COUNT(l.id) FILTER (WHERE ${leadPeriodoSQL.replace(/criado_em/g, 'l.criado_em')}) AS leads_atribuidos
       FROM movatak_vendedores vd
       LEFT JOIN movatak_leads l ON l.vendedor_id = vd.id AND l.cliente_id = $1
       WHERE vd.cliente_id = $1 AND COALESCE(vd.ativo, true) = true
       GROUP BY vd.id, vd.nome
       ORDER BY fechamentos DESC`,
      [id]
    );

    res.json({
      periodo_dias: dias,
      ...m.rows[0],
      leads_por_hora: leadsPorHora,
      vendedores: v.rows
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/movatak/admin/clientes/:id/operacao', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const clienteId = req.params.id;

    const cliente = await query(
      `SELECT id, nome, ativo, zapi_instance, trigger_msg, criado_em, ultimo_webhook_em, ultimo_erro_zapi_em, ultimo_erro_zapi
         FROM movatak_clientes
        WHERE id = $1`,
      [clienteId]
    );
    if (!cliente.rows.length) return res.status(404).json({ error: 'Cliente nao encontrado.' });

    const leads = await query(
      `SELECT
         COUNT(*) FILTER (WHERE etapa != 'descartado') AS total_leads,
         COUNT(*) FILTER (WHERE etapa = 'lead') AS em_atendimento,
         COUNT(*) FILTER (WHERE etapa = 'followup') AS em_followup,
         COUNT(*) FILTER (WHERE etapa = 'cliente') AS clientes,
         COUNT(*) FILTER (WHERE etapa = 'descartado') AS descartados,
         MAX(criado_em) AS ultimo_lead_em,
         MAX(atualizado_em) AS ultima_atualizacao_em
       FROM movatak_leads
       WHERE cliente_id = $1`,
      [clienteId]
    );

    const fila = await query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pendente') AS pendentes,
         COUNT(*) FILTER (WHERE status = 'pendente' AND COALESCE(sequencia_fu,1) = 1) AS pendentes_fu1,
         COUNT(*) FILTER (WHERE status = 'pendente' AND COALESCE(sequencia_fu,1) = 2) AS pendentes_fu2,
         COUNT(*) FILTER (WHERE status = 'pendente' AND proximo_envio <= NOW()) AS pendentes_atrasadas,
         COUNT(*) FILTER (WHERE status = 'enviado') AS enviadas,
         COUNT(*) FILTER (WHERE status = 'pausado') AS pausadas,
         MAX(COALESCE(enviado_em, proximo_envio)) FILTER (WHERE status = 'enviado') AS ultimo_envio_em,
         MIN(proximo_envio) FILTER (WHERE status = 'pendente') AS proximo_envio_em
       FROM movatak_followup
       WHERE cliente_id = $1`,
      [clienteId]
    );

    const ultimoLead = await query(
      `SELECT id, nome, telefone, etapa, criado_em, atualizado_em
       FROM movatak_leads
       WHERE cliente_id = $1
       ORDER BY criado_em DESC
       LIMIT 1`,
      [clienteId]
    );

    const proximo = await query(
      `SELECT f.id, f.lead_id, f.sequencia_fu, f.etapa_seq, f.proximo_envio, f.status,
              l.nome, l.telefone, l.etapa
       FROM movatak_followup f
       JOIN movatak_leads l ON l.id = f.lead_id
       WHERE f.cliente_id = $1 AND f.status = 'pendente'
       ORDER BY f.proximo_envio ASC
       LIMIT 1`,
      [clienteId]
    );

    res.json({
      cliente: cliente.rows[0],
      leads: leads.rows[0],
      fila: fila.rows[0],
      ultimo_lead: ultimoLead.rows[0] || null,
      proxima_mensagem: proximo.rows[0] || null,
      debug_ativo: MOVATAK_DEBUG,
      relatorio_diario_ativo: String(process.env.MOVATAK_RELATORIO_DIARIO || '').toLowerCase() === 'true',
      version: MOVATAK_VERSION
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/movatak/admin/clientes/:id/fila-followup', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const status = String(req.query.status || '').trim();
    const limit = Math.min(Math.max(parseInt(req.query.limit || '80'), 1), 200);
    const params = [req.params.id, limit];
    let filtroStatus = '';
    if (status) {
      params.push(status);
      filtroStatus = ' AND f.status = $3';
    }

    const r = await query(
      `SELECT f.id, f.lead_id, f.etapa_seq, COALESCE(f.sequencia_fu, 1) AS sequencia_fu,
              f.proximo_envio, f.status, f.data_entrada,
              l.nome, l.telefone, l.etapa, l.criado_em, l.atualizado_em,
              v.nome AS vendedor_nome
       FROM movatak_followup f
       JOIN movatak_leads l ON l.id = f.lead_id
       LEFT JOIN movatak_vendedores v ON v.id = l.vendedor_id
       WHERE f.cliente_id = $1 ${filtroStatus}
       ORDER BY
         CASE WHEN f.status = 'pendente' THEN 0 ELSE 1 END,
         f.proximo_envio ASC
       LIMIT $2`,
      params
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/movatak/admin/leads/:id/followup/pausar', ...exigeLead, async (req, res) => {
  try {
    const leadId = req.params.id;
    const lead = await query('SELECT id, cliente_id FROM movatak_leads WHERE id = $1', [leadId]);
    await query(`UPDATE movatak_leads SET etapa = 'lead', atualizado_em = NOW() WHERE id = $1`, [leadId]);
    await query(`UPDATE movatak_followup SET status = 'pausado' WHERE lead_id = $1 AND status = 'pendente'`, [leadId]);
    if (lead.rows.length) await registrarEventoLead(leadId, lead.rows[0].cliente_id, 'followup_pausado_manual', 'Follow-up pausado manualmente pelo painel');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/movatak/admin/leads/:id/followup/reativar', ...exigeLead, async (req, res) => {
  try {
    const leadId = req.params.id;
    const sequencia = parseInt(req.body && req.body.sequencia_fu ? req.body.sequencia_fu : 2);
    const enviarImediato = !!(req.body && req.body.enviar_imediato);
    if (![1, 2].includes(sequencia)) return res.status(400).json({ error: 'sequencia_fu deve ser 1 ou 2.' });

    const lead = await query('SELECT id, cliente_id FROM movatak_leads WHERE id = $1', [leadId]);
    if (!lead.rows.length) return res.status(404).json({ error: 'Lead nao encontrado.' });

    await query(`UPDATE movatak_leads SET etapa = 'followup', atualizado_em = NOW() WHERE id = $1`, [leadId]);
    await agendarFollowupV2(leadId, lead.rows[0].cliente_id, sequencia, true);
    await registrarEventoLead(leadId, lead.rows[0].cliente_id, 'followup_reativado_manual', `Follow-up FU${sequencia} reativado pelo painel`, { enviar_imediato: enviarImediato });
    if (enviarImediato) await enviarFollowupsPendentesDoLead(leadId, sequencia);
    res.json({ ok: true, sequencia_fu: sequencia });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/movatak/admin/clientes/:id/testar-gatilho', authMovatak, async (req, res) => {
  try {
    const texto = req.body && req.body.texto ? String(req.body.texto) : '';
    const r = await query('SELECT trigger_msg FROM movatak_clientes WHERE id = $1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Cliente nao encontrado.' });
    const campanha = await localizarCampanhaPorGatilho(req.params.id, texto);
    const bateuGeral = textoBateGatilho(texto, r.rows[0].trigger_msg);
    res.json({
      texto_original: texto,
      trigger_original: campanha ? campanha.gatilho : r.rows[0].trigger_msg,
      texto_normalizado: normalizarGatilho(texto),
      trigger_normalizado: normalizarGatilho(campanha ? campanha.gatilho : r.rows[0].trigger_msg),
      bateu: !!campanha || bateuGeral,
      campanha: campanha ? { id: campanha.id, nome: campanha.nome, template_id: campanha.template_id || null, template_nome: campanha.template_nome || null } : null,
      origem: campanha ? 'campanha' : (bateuGeral ? 'gatilho_geral' : null)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/movatak/admin/leads/:id/conversas', ...exigeLead, async (req, res) => {
  try {
    await garantirEstruturaConversas();
    // Fonte única da verdade: o banco. Pegamos as 500 mensagens MAIS RECENTES
    // (ORDER BY ... DESC) e depois reordenamos em ordem cronológica para exibir.
    // ⚠️ Antes era ORDER BY criado_em ASC LIMIT 500 — isso pegava as 500 mais ANTIGAS,
    // e em leads com +500 mensagens as recém-enviadas caíam fora do limite e sumiam da tela.
    const r = await query(
      `SELECT * FROM (
         SELECT id, direcao, conteudo, midia_url, midia_tipo, midia_nome, msg_id,
                reply_to_conversa_id, reply_to_msg_id, reply_to_direcao, reply_to_conteudo,
                reply_to_midia_url, reply_to_midia_tipo, msg_status, msg_status_em, criado_em, 'banco' AS fonte
           FROM movatak_conversas WHERE lead_id = $1
           ORDER BY criado_em DESC LIMIT 500
       ) sub ORDER BY criado_em ASC`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/transcrever-audio', authMovatakOuApp, async (req, res) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(400).json({ error: 'Transcrição não configurada (falta OPENAI_API_KEY).' });
    const url = (req.body && req.body.url) ? String(req.body.url) : '';
    if (!url || !/^https?:\/\//.test(url)) return res.status(400).json({ error: 'URL de áudio inválida.' });

    // Baixa o áudio da URL pública (Supabase/Z-API).
    const audioResp = await fetch(url);
    if (!audioResp.ok) return res.status(502).json({ error: 'Não foi possível baixar o áudio.' });
    const audioBuffer = Buffer.from(await audioResp.arrayBuffer());
    if (audioBuffer.length > 24 * 1024 * 1024) return res.status(413).json({ error: 'Áudio muito grande para transcrever.' });

    // Monta multipart/form-data para o Whisper.
    const nomeArq = (url.split('/').pop() || 'audio.ogg').split('?')[0] || 'audio.ogg';
    const form = new FormData();
    form.append('file', new Blob([audioBuffer]), nomeArq);
    form.append('model', 'whisper-1');
    form.append('language', 'pt');

    const wResp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey },
      body: form
    });
    if (!wResp.ok) {
      // Loga o detalhe técnico para você, mas mostra mensagem amigável ao usuário.
      const detalhe = await wResp.text().catch(() => '');
      console.error('[transcricao] OpenAI ' + wResp.status + ': ' + detalhe.slice(0, 200));
      let amigavel = 'Transcrição temporariamente indisponível. Tente novamente em instantes.';
      if (wResp.status === 429) amigavel = 'Transcrição temporariamente indisponível.';
      else if (wResp.status === 401) amigavel = 'Transcrição indisponível (configuração).';
      else if (wResp.status === 413) amigavel = 'Áudio muito longo para transcrever.';
      return res.status(502).json({ error: amigavel });
    }
    const data = await wResp.json();
    const texto = (data.text || '').trim();
    if (!texto) return res.status(502).json({ error: 'Não foi possível transcrever este áudio.' });
    res.json({ texto });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/movatak/admin/leads/:id/dispensar-prioridade', ...exigeLead, async (req, res) => {
  try {
    const r = await query(
      'UPDATE movatak_leads SET prioridade_dispensada_em = NOW() WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/admin/leads/:id/resumo-ia', ...exigeLead, async (req, res) => {
  try {
    await garantirEstruturaConversas();
    const leadId = req.params.id;
    const convR = await query(
      `SELECT * FROM (
         SELECT direcao, conteudo, criado_em FROM movatak_conversas
          WHERE lead_id = $1 AND conteudo IS NOT NULL AND conteudo <> ''
          ORDER BY criado_em DESC LIMIT 40
       ) sub ORDER BY criado_em ASC`,
      [leadId]
    );
    if (!convR.rows.length) return res.json({ ok: true, resumo: 'Ainda não há mensagens nesta conversa para resumir.' });
    const conversaTxt = convR.rows.map(m =>
      (m.direcao === 'entrada' ? 'CLIENTE: ' : 'ATENDENTE: ') + (m.conteudo || '')
    ).join('\n');
    const systemPrompt =
      'Você resume conversas de atendimento no WhatsApp para um vendedor que vai assumir o atendimento. ' +
      'Faça um resumo curto e objetivo em português brasileiro, em no máximo 5 tópicos curtos, cobrindo: o que o cliente quer, ' +
      'dúvidas ou objeções levantadas, o que já foi respondido e qual o próximo passo pendente. ' +
      'Não invente informação que não esteja na conversa; se algo não apareceu, não cite. Sem saudação nem despedida.';
    const userPrompt = 'CONVERSA:\n' + conversaTxt + '\n\nResumo:';
    const resumo = await chamarHaiku(systemPrompt, userPrompt);
    if (!resumo) return res.status(502).json({ error: 'A IA não retornou resumo. Tente novamente.' });
    res.json({ ok: true, resumo });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/admin/leads/:id/sugerir-resposta', ...exigeLead, async (req, res) => {
  try {
    const r = await gerarRespostaIALead(req.params.id);
    if (r.erro) return res.status(r.erro.includes('não retornou') ? 502 : 400).json({ error: r.erro });
    res.json({ sugestao: r.sugestao });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/movatak/admin/conversas/:id', ...exigeConversa, async (req, res) => {
  try {
    const r = await query(
      `SELECT cv.*, l.telefone, c.zapi_instance, c.zapi_token, c.zapi_client_token
         FROM movatak_conversas cv
         JOIN movatak_leads l ON l.id = cv.lead_id
         JOIN movatak_clientes c ON c.id = cv.cliente_id
        WHERE cv.id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Mensagem não encontrada.' });
    const msg = r.rows[0];

    let apagadaNoZap = false;
    let avisoZap = null;
    if (msg.direcao === 'saida' && msg.msg_id) {
      try {
        await zapiApagarMensagem(msg.zapi_instance, msg.zapi_token, msg.zapi_client_token, msg.telefone, msg.msg_id);
        apagadaNoZap = true;
      } catch (e) {
        avisoZap = e.response?.data?.error || e.response?.data?.message || e.message;
        console.warn('[conversas][apagar] falha ao apagar no WhatsApp. status:', e.response?.status, 'body:', JSON.stringify(e.response?.data || {}), 'msgId usado:', msg.msg_id);
      }
    } else if (msg.direcao === 'entrada') {
      avisoZap = 'Mensagem recebida do lead — não é possível apagar do lado dele, só do seu painel.';
    } else {
      avisoZap = 'Esta mensagem foi enviada antes desse recurso existir, sem referência pra apagar no WhatsApp.';
    }

    await query('DELETE FROM movatak_conversas WHERE id = $1', [req.params.id]);
    emitirMensagemApagada(msg.cliente_id, msg.lead_id, Number(req.params.id));
    res.json({ ok: true, apagadaNoZap, avisoZap });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/conversas/:id/reagir', ...exigeConversa, async (req, res) => {
  try {
    const { reaction } = req.body || {};
    if (!reaction) return res.status(400).json({ error: 'Informe o emoji da reação.' });
    const msg = await obterMensagemComZapi(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Mensagem não encontrada.' });
    if (!msg.msg_id) return res.status(400).json({ error: 'Mensagem sem messageId do WhatsApp.' });
    const data = await zapiReagirMensagem(msg.zapi_instance, msg.zapi_token, msg.zapi_client_token, msg.telefone, msg.msg_id, reaction);
    await registrarEventoLead(msg.lead_id, msg.cliente_id, 'whatsapp_reacao', 'Reação enviada pelo CRM', { conversa_id: msg.id, reaction });
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
});

app.post('/movatak/admin/conversas/:id/encaminhar', ...exigeConversa, async (req, res) => {
  try {
    const { destino } = req.body || {};
    if (!destino) return res.status(400).json({ error: 'Informe o destino.' });
    const msg = await obterMensagemComZapi(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Mensagem não encontrada.' });
    if (!msg.msg_id) return res.status(400).json({ error: 'Mensagem sem messageId do WhatsApp.' });
    const data = await zapiEncaminharMensagem(msg.zapi_instance, msg.zapi_token, msg.zapi_client_token, String(destino).replace(/\D/g, ''), msg.msg_id, msg.telefone);
    await registrarEventoLead(msg.lead_id, msg.cliente_id, 'whatsapp_encaminhamento', 'Mensagem encaminhada pelo CRM', { conversa_id: msg.id, destino });
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
});

app.post('/movatak/admin/conversas/:id/marcar-lida-zap', ...exigeConversa, async (req, res) => {
  try {
    const msg = await obterMensagemComZapi(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Mensagem não encontrada.' });
    if (!msg.msg_id) return res.status(400).json({ error: 'Mensagem sem messageId do WhatsApp.' });
    const data = await zapiLerMensagem(msg.zapi_instance, msg.zapi_token, msg.zapi_client_token, msg.telefone, msg.msg_id);
    await query(`UPDATE movatak_conversas SET msg_status='read', msg_status_em=NOW() WHERE id=$1`, [msg.id]).catch(() => null);
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
});

app.post('/movatak/admin/conversas/:id/editar', ...exigeConversa, async (req, res) => {
  try {
    const { texto } = req.body || {};
    if (!String(texto || '').trim()) return res.status(400).json({ error: 'Informe o novo texto.' });
    const msg = await obterMensagemComZapi(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Mensagem não encontrada.' });
    if (msg.direcao !== 'saida') return res.status(400).json({ error: 'Só é possível editar mensagens enviadas pelo CRM/WhatsApp.' });
    if (!msg.msg_id) return res.status(400).json({ error: 'Mensagem sem messageId do WhatsApp.' });
    const data = await zapiEditarTexto(msg.zapi_instance, msg.zapi_token, msg.zapi_client_token, msg.telefone, msg.msg_id, texto);
    await query(`UPDATE movatak_conversas SET conteudo=$1 WHERE id=$2`, [texto, msg.id]);
    await registrarEventoLead(msg.lead_id, msg.cliente_id, 'whatsapp_edicao', 'Mensagem editada pelo CRM', { conversa_id: msg.id });
    emitirMensagemLead(msg.cliente_id, msg.lead_id, { ...msg, conteudo: texto, editada: true });
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
});

app.post('/movatak/admin/leads/:id/zapi/chat-action', ...exigeLead, async (req, res) => {
  try {
    const { action } = req.body || {};
    const allowed = ['read','unread','pin','unpin','mute','unmute','archive','unarchive'];
    if (!allowed.includes(action)) return res.status(400).json({ error: 'Ação inválida.' });
    const lead = await obterLeadComZapi(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado.' });
    let data;
    if (action === 'archive' || action === 'unarchive') {
      const url = `${ZAPI_BASE}/${lead.zapi_instance}/token/${lead.zapi_token}/archive-chat`;
      const resp = await axios.post(url, { phone: lead.telefone, archive: action === 'archive' }, { headers: zapiHeaders(lead.zapi_client_token) });
      data = resp.data || {};
      await query(`UPDATE movatak_leads SET arquivado=$1 WHERE id=$2`, [action === 'archive', lead.id]).catch(() => null);
    } else {
      data = await zapiModificarChat(lead.zapi_instance, lead.zapi_token, lead.zapi_client_token, lead.telefone, action);
      if (action === 'read') await query(`UPDATE movatak_leads SET nao_lida=false WHERE id=$1`, [lead.id]).catch(() => null);
      if (action === 'unread') await query(`UPDATE movatak_leads SET nao_lida=true WHERE id=$1`, [lead.id]).catch(() => null);
    }
    await registrarEventoLead(lead.id, lead.cliente_id, 'whatsapp_chat_action', 'Ação aplicada no chat do WhatsApp', { action });
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
});

app.post('/movatak/admin/leads/:id/zapi/send-advanced', ...exigeLead, async (req, res) => {
  try {
    const { recurso, payload, reply_to_conversa_id, reply_to_msg_id } = req.body || {};
    const lead = await obterLeadComZapi(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado.' });
    const replyResolvido = await resolverReplyInfoLead(lead.id, reply_to_conversa_id, reply_to_msg_id, null);
    const replyMsgIdZap = replyResolvido.msgId || null;
    const p = payload || {};
    let msgId = null;
    let conteudo = '';
    let midiaUrl = null;
    let midiaTipo = null;

    let midiaNome = null;
    if (recurso === 'document') {
      msgId = await zapiEnviarDocumento(lead.zapi_instance, lead.zapi_token, lead.zapi_client_token, lead.telefone, p.document || p.url, p.fileName || p.nome, p.caption || '', p.extension || p.ext, replyMsgIdZap);
      conteudo = p.caption || p.fileName || 'Documento enviado'; midiaUrl = p.document || p.url; midiaTipo = 'documento'; midiaNome = p.fileName || p.nome || null;
    } else if (recurso === 'location') {
      msgId = await zapiEnviarLocalizacao(lead.zapi_instance, lead.zapi_token, lead.zapi_client_token, lead.telefone, p.title, p.address, p.latitude, p.longitude, replyMsgIdZap);
      conteudo = `Localização: ${p.title || ''}`.trim(); midiaTipo = 'localizacao';
    } else if (recurso === 'link') {
      msgId = await zapiEnviarLink(lead.zapi_instance, lead.zapi_token, lead.zapi_client_token, lead.telefone, p.linkUrl || p.url, p.message || p.texto || '', p.title || '', p.image || '', replyMsgIdZap);
      conteudo = p.message || p.texto || p.linkUrl || p.url || 'Link enviado'; midiaUrl = p.linkUrl || p.url || null; midiaTipo = 'link';
    } else if (recurso === 'contact') {
      msgId = await zapiEnviarContato(lead.zapi_instance, lead.zapi_token, lead.zapi_client_token, lead.telefone, p.contactName || p.nome, p.contactPhone || p.telefone, !!p.contactBusiness, replyMsgIdZap);
      conteudo = `Contato: ${p.contactName || p.nome || ''}`.trim(); midiaTipo = 'contato';
    } else {
      const endpoint = ZAPI_ADVANCED_ENDPOINTS[recurso];
      if (!endpoint) return res.status(400).json({ error: 'Recurso não liberado ou não reconhecido.' });
      const clean = limparPayloadAvancado(p);
      clean.phone = lead.telefone;
      if (replyMsgIdZap) clean.messageId = replyMsgIdZap;
      const data = await zapiPost(lead.zapi_instance, lead.zapi_token, lead.zapi_client_token, endpoint, clean);
      msgId = data.messageId || data.id || data.zaapId || null;
      conteudo = p.message || p.text || p.caption || p.title || ('Recurso enviado: ' + recurso);
      midiaUrl = p.image || p.video || p.gif || p.sticker || null;
      midiaTipo = recurso;
    }
    const conversaId = await registrarConversa(lead.id, lead.cliente_id, 'saida', conteudo || '', midiaUrl || null, midiaTipo || recurso, msgId, replyResolvido.info, undefined, midiaNome).catch(() => null);
    await registrarEventoLead(lead.id, lead.cliente_id, 'whatsapp_recurso_avancado', 'Recurso avançado enviado pelo CRM', { recurso, conversaId });
    res.json({ ok: true, conversaId, messageId: msgId, criado_em: new Date().toISOString() });
  } catch(e) { res.status(500).json({ error: e.response?.data?.message || JSON.stringify(e.response?.data || {}) || e.message }); }
});

app.get('/movatak/admin/clientes/:id/zapi/chats', authMovatak, async (req, res) => {
  try {
    const c = await query('SELECT id, zapi_instance, zapi_token, zapi_client_token FROM movatak_clientes WHERE id=$1', [req.params.id]);
    if (!c.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const cli = c.rows[0];
    const data = await zapiListarChats(cli.zapi_instance, cli.zapi_token, cli.zapi_client_token);
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
});

app.post('/movatak/admin/clientes/:id/zapi/sincronizar-chats', authMovatak, async (req, res) => {
  try {
    await garantirEstruturaQuestionario();
    const c = await query('SELECT id, zapi_instance, zapi_token, zapi_client_token FROM movatak_clientes WHERE id=$1', [req.params.id]);
    if (!c.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const cli = c.rows[0];
    const data = await zapiListarChats(cli.zapi_instance, cli.zapi_token, cli.zapi_client_token);
    const chats = Array.isArray(data) ? data : (Array.isArray(data.chats) ? data.chats : []);
    let criados = 0, atualizados = 0, ignorados = 0;
    for (const ch of chats) {
      const phone = String(ch.phone || ch.id || '').replace(/\D/g, '');
      if (!phone || ch.isGroup) { ignorados++; continue; }
      const existe = await query('SELECT id FROM movatak_leads WHERE cliente_id=$1 AND telefone=$2 LIMIT 1', [cli.id, phone]).catch(() => ({ rows: [] }));
      if (existe.rows.length) {
        await query(`UPDATE movatak_leads SET nome=COALESCE(NULLIF($1,''),nome), nao_lida=COALESCE($2,nao_lida), atualizado_em=NOW() WHERE id=$3`, [ch.name || null, !!ch.unread, existe.rows[0].id]).catch(() => null);
        atualizados++;
      } else {
        await query(`INSERT INTO movatak_leads (cliente_id, nome, telefone, etapa, origem, nao_lida, criado_em, atualizado_em)
                    VALUES ($1,$2,$3,'lead','whatsapp_sync',$4,NOW(),NOW())`, [cli.id, ch.name || phone, phone, !!ch.unread]).catch(() => null);
        criados++;
      }
    }
    res.json({ ok: true, total: chats.length, criados, atualizados, ignorados });
  } catch(e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
});

app.get('/movatak/admin/leads/:id/historico', ...exigeLead, async (req, res) => {
  const _t0 = Date.now();
  try {
    const leadId = req.params.id;
    const lead = await query(
      `SELECT l.*, c.nome AS cliente_nome, v.nome AS vendedor_nome,
              fc.nome AS funil_coluna_nome, fc.cor AS funil_coluna_cor
         FROM movatak_leads l
         JOIN movatak_clientes c ON c.id = l.cliente_id
         LEFT JOIN movatak_vendedores v ON v.id = l.vendedor_id
         LEFT JOIN movatak_funil_colunas fc ON fc.id = l.funil_coluna_id
        WHERE l.id = $1`,
      [leadId]
    );
    if (!lead.rows.length) return res.status(404).json({ error: 'Lead nao encontrado.' });
    const _tLead = Date.now();

    const eventos = await query(
      `SELECT id, tipo, descricao, dados, criado_em
         FROM movatak_lead_eventos
        WHERE lead_id = $1
        ORDER BY criado_em DESC
        LIMIT 100`,
      [leadId]
    );
    const _tEventos = Date.now();

    const fila = await query(
      `SELECT id, etapa_seq, COALESCE(sequencia_fu, 1) AS sequencia_fu, proximo_envio,
              status, data_entrada, enviado_em, tentativas_envio, erro_envio
         FROM movatak_followup
        WHERE lead_id = $1
        ORDER BY proximo_envio DESC
        LIMIT 100`,
      [leadId]
    );
    const _tFila = Date.now();

    const totalMs = _tFila - _t0;
    if (totalMs > 3000) {
      console.log(`[DIAG-HIST] lead ${leadId} LENTO total=${totalMs}ms | lead=${_tLead - _t0}ms eventos=${_tEventos - _tLead}ms fila=${_tFila - _tEventos}ms`);
    }

    res.json({ lead: lead.rows[0], eventos: eventos.rows, fila: fila.rows });
  } catch (e) {
    console.error(`[DIAG-HIST] lead ${req.params.id} ERRO após ${Date.now() - _t0}ms:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/movatak/admin/teste-r2', authMovatak, async (req, res) => {
  // Diagnóstico: mostra exatamente o que o processo carregou do ambiente.
  const diag = {
    bucket_variavel: R2_BUCKET || '(vazio)',
    bucket_real_descoberto: config.R2_BUCKET_REAL || '(vazio)',
    endpoint_carregado: (process.env.R2_ENDPOINT || '(vazio)').trim(),
    tem_access_key: !!process.env.R2_ACCESS_KEY_ID,
    tem_secret: !!process.env.R2_SECRET_ACCESS_KEY,
    r2_pronto: R2_PRONTO,
    cliente_inicializado: !!r2Client
  };
  try {
    if (!r2Client) {
      return res.json({ ok: false, motivo: 'R2 não configurado', diag });
    }
    // Lista os buckets reais (confirma o que o token enxerga).
    try {
      const lista = await r2Client.send(new R2_ListBucketsCommand({}));
      diag.buckets_visiveis = (lista.Buckets || []).map(b => b.Name);
    } catch (eList) {
      diag.buckets_visiveis = 'erro ao listar: ' + eList.message;
    }
    // Usa as funções r2* que já operam no bucket REAL auto-descoberto.
    const chave = 'teste/movatak-' + Date.now() + '.txt';
    const conteudo = Buffer.from('teste movatak r2 ' + new Date().toISOString(), 'utf8');
    await r2Upload(chave, conteudo, 'text/plain');
    const baixado = await r2Download(chave);
    const textoBaixado = baixado.buffer.toString('utf8');
    await r2Delete(chave);
    res.json({ ok: true, mensagem: 'R2 funcionando: upload, download e delete OK', diag, conteudo_baixado: textoBaixado });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message, diag });
  }
});

app.get('/movatak/admin/leads/:id/anexos', ...exigeLead, async (req, res) => {
  try {
    const r = await query(
      `SELECT id, nome_arquivo, tipo, tamanho, autor, criado_em, comentario
         FROM movatak_lead_anexos WHERE lead_id = $1 ORDER BY criado_em DESC`,
      [req.params.id]
    );
    res.json({ anexos: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/leads/:id/anexos', ...exigeLead, async (req, res) => {
  try {
    if (!r2Client) return res.status(503).json({ error: 'Armazenamento de anexos indisponível.' });
    const leadId = req.params.id;
    const { nome_arquivo, tipo, base64 } = req.body || {};
    if (!nome_arquivo || !base64) return res.status(400).json({ error: 'Arquivo inválido.' });
    if (tipo && !ANEXO_TIPOS_OK.includes(tipo)) {
      return res.status(400).json({ error: 'Tipo de arquivo não permitido.' });
    }
    // Decodifica o base64 (aceita com ou sem prefixo data:).
    const limpo = String(base64).replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(limpo, 'base64');
    if (!buffer.length) return res.status(400).json({ error: 'Arquivo vazio.' });
    if (buffer.length > ANEXO_MAX_BYTES) {
      return res.status(400).json({ error: 'Arquivo muito grande (máx. 10MB).' });
    }
    const lead = await query('SELECT cliente_id FROM movatak_leads WHERE id = $1', [leadId]);
    if (!lead.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    const clienteId = lead.rows[0].cliente_id;
    // Chave no R2: organiza por cliente/lead e evita colisão com timestamp.
    // Nome ORIGINAL preservado para exibição/download (só remove separadores de caminho e controle).
    // Não usa \w (que descarta acentos) — assim "Comprovação.pdf" continua "Comprovação.pdf".
    const nomeOriginal = (String(nome_arquivo).replace(/[\/\\\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 200)) || 'arquivo';
    // Versão ASCII-segura usada SOMENTE na chave do R2 (evita problemas de encoding na chave).
    const nomeChaveSafe = nomeOriginal.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w.\- ]/g, '_').slice(0, 120);
    const chave = `anexos/cliente_${clienteId}/lead_${leadId}/${Date.now()}_${nomeChaveSafe}`;
    await r2Upload(chave, buffer, tipo || 'application/octet-stream');
    const autor = (req.vendedor && req.vendedor.nome) ? req.vendedor.nome : 'Gestor';
    const ins = await query(
      `INSERT INTO movatak_lead_anexos (lead_id, cliente_id, nome_arquivo, tipo, tamanho, r2_chave, autor)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, nome_arquivo, tipo, tamanho, autor, criado_em`,
      [leadId, clienteId, nomeOriginal, tipo || null, buffer.length, chave, autor]
    );
    res.json({ ok: true, anexo: ins.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/admin/leads/:id/anexos/:anexoId/download', ...exigeLead, async (req, res) => {
  try {
    if (!r2Client) return res.status(503).json({ error: 'Armazenamento indisponível.' });
    const r = await query(
      'SELECT nome_arquivo, tipo, r2_chave FROM movatak_lead_anexos WHERE id = $1 AND lead_id = $2',
      [req.params.anexoId, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Anexo não encontrado.' });
    const anexo = r.rows[0];
    const baixado = await r2Download(anexo.r2_chave);
    res.setHeader('Content-Type', anexo.tipo || baixado.contentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(anexo.nome_arquivo) + '"');
    res.send(baixado.buffer);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/movatak/admin/leads/:id/anexos/:anexoId', ...exigeLead, async (req, res) => {
  try {
    const r = await query(
      'SELECT r2_chave FROM movatak_lead_anexos WHERE id = $1 AND lead_id = $2',
      [req.params.anexoId, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Anexo não encontrado.' });
    if (r2Client) { await r2Delete(r.rows[0].r2_chave).catch(() => null); }
    await query('DELETE FROM movatak_lead_anexos WHERE id = $1', [req.params.anexoId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/movatak/admin/leads/:id/anexos/:anexoId/comentario', ...exigeLead, async (req, res) => {
  try {
    const texto = String((req.body && req.body.comentario) || '').trim().slice(0, 2000);
    const r = await query(
      'UPDATE movatak_lead_anexos SET comentario = $1 WHERE id = $2 AND lead_id = $3 RETURNING id',
      [texto || null, req.params.anexoId, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Anexo não encontrado.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Salva o anexo de UMA mensagem da conversa direto nos Documentos do histórico,
// sem o usuário precisar baixar e reanexar: o servidor busca a mídia na URL da
// Z-API/WhatsApp e a espelha no R2, criando um movatak_lead_anexos (que já ganha
// o botão "Comentar" existente na aba Histórico).
app.post('/movatak/admin/leads/:id/anexos/da-conversa', ...exigeLead, async (req, res) => {
  try {
    if (!r2Client) return res.status(503).json({ error: 'Armazenamento de anexos indisponível.' });
    const leadId = req.params.id;
    const conversaId = (req.body && (req.body.conversa_id || req.body.conversaId)) || null;
    if (!conversaId) return res.status(400).json({ error: 'conversa_id é obrigatório.' });

    // Carrega a mensagem e confirma que pertence a ESTE lead (defesa extra além do exigeLead).
    const msg = await obterMensagemComZapi(conversaId);
    if (!msg) return res.status(404).json({ error: 'Mensagem não encontrada.' });
    if (String(msg.lead_id) !== String(leadId)) {
      return res.status(403).json({ error: 'Esta mensagem não pertence a este lead.' });
    }
    if (!msg.midia_url) return res.status(400).json({ error: 'Esta mensagem não tem anexo.' });

    // Baixa a mídia server-side (o usuário não precisa baixar/reanexar).
    let resp;
    try {
      resp = await axios.get(msg.midia_url, {
        responseType: 'arraybuffer',
        maxContentLength: ANEXO_MAX_BYTES,
        maxBodyLength: ANEXO_MAX_BYTES,
        timeout: 20000
      });
    } catch (e) {
      const detalhe = /maxContentLength|exceeded/i.test(e.message || '')
        ? 'Arquivo muito grande (máx. 10MB).'
        : ('Não foi possível baixar o anexo da conversa: ' + (e.message || 'erro'));
      return res.status(502).json({ error: detalhe });
    }
    const buffer = Buffer.from(resp.data);
    if (!buffer.length) return res.status(400).json({ error: 'Anexo vazio.' });
    if (buffer.length > ANEXO_MAX_BYTES) {
      return res.status(400).json({ error: 'Arquivo muito grande (máx. 10MB).' });
    }

    // Content-type: prioriza o header HTTP; cai pra um palpite pela categoria interna.
    const catParaMime = { imagem: 'image/jpeg', audio: 'audio/ogg', video: 'video/mp4', documento: 'application/octet-stream' };
    const ctHeader = String(resp.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const contentType = ctHeader || catParaMime[msg.midia_tipo] || 'application/octet-stream';

    // Nome do arquivo: tenta o basename da URL; senão monta um nome amigável com a data.
    const mimeExt = {
      'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
      'audio/ogg': 'ogg', 'audio/opus': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac',
      'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
      'application/pdf': 'pdf'
    };
    let nomeOriginal = '';
    try {
      const semQuery = String(msg.midia_url).split('?')[0].split('#')[0];
      const base = decodeURIComponent(semQuery.substring(semQuery.lastIndexOf('/') + 1) || '');
      if (base && /\.[a-z0-9]{2,5}$/i.test(base)) nomeOriginal = base;
    } catch (e) { /* URL exótica: cai no nome montado abaixo */ }
    if (!nomeOriginal) {
      const rotulo = { imagem: 'Foto', audio: 'Áudio', video: 'Vídeo', documento: 'Documento' }[msg.midia_tipo] || 'Anexo';
      const ext = mimeExt[contentType] || 'bin';
      const carimbo = new Date().toLocaleString('pt-BR', {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
      }).replace(/[/:]/g, '-').replace(', ', '_');
      nomeOriginal = `${rotulo} da conversa ${carimbo}.${ext}`;
    }
    nomeOriginal = (nomeOriginal.replace(/[\/\\\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 200)) || 'arquivo';

    const clienteId = msg.cliente_id;
    const nomeChaveSafe = nomeOriginal.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w.\- ]/g, '_').slice(0, 120);
    const chave = `anexos/cliente_${clienteId}/lead_${leadId}/${Date.now()}_${nomeChaveSafe}`;
    await r2Upload(chave, buffer, contentType);
    const autor = (req.vendedor && req.vendedor.nome) ? req.vendedor.nome : 'Gestor';
    const ins = await query(
      `INSERT INTO movatak_lead_anexos (lead_id, cliente_id, nome_arquivo, tipo, tamanho, r2_chave, autor)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, nome_arquivo, tipo, tamanho, autor, criado_em, comentario`,
      [leadId, clienteId, nomeOriginal, contentType, buffer.length, chave, autor]
    );
    res.json({ ok: true, anexo: ins.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/leads/:id/anotacao', ...exigeLead, async (req, res) => {
  try {
    const leadId = req.params.id;
    const texto = String((req.body && req.body.texto) || '').trim();
    if (!texto) return res.status(400).json({ error: 'Texto da anotação vazio.' });
    if (texto.length > 4000) return res.status(400).json({ error: 'Anotação muito longa (máx. 4000 caracteres).' });
    const lead = await query('SELECT cliente_id FROM movatak_leads WHERE id = $1', [leadId]);
    if (!lead.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    const autor = (req.vendedor && req.vendedor.nome) ? req.vendedor.nome : 'Gestor';
    await registrarEventoLead(leadId, lead.rows[0].cliente_id, 'anotacao', texto, { autor });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/movatak/admin/leads/:id/anotacao/:eventoId', ...exigeLead, async (req, res) => {
  try {
    const { id: leadId, eventoId } = req.params;
    const r = await query(
      `DELETE FROM movatak_lead_eventos WHERE id = $1 AND lead_id = $2 AND tipo = 'anotacao'`,
      [eventoId, leadId]
    );
    res.json({ ok: true, removidos: r.rowCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/movatak/admin/clientes/:id/leads-operacao', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit || '80'), 1), 200);
    const etapa = String(req.query.etapa || '').trim();
    const busca = String(req.query.busca || '').trim();
    const params = [req.params.id, limit];
    let where = 'WHERE l.cliente_id = $1';
    if (etapa) { params.push(etapa); where += ` AND l.etapa = $${params.length}`; }
    if (busca) { params.push('%' + busca + '%'); where += ` AND (l.telefone ILIKE $${params.length} OR l.nome ILIKE $${params.length})`; }

    const r = await query(
      `SELECT l.id, l.nome, l.telefone, l.etapa, l.criado_em, l.atualizado_em,
              v.nome AS vendedor_nome,
              COUNT(f.id) FILTER (WHERE f.status = 'pendente') AS pendentes
         FROM movatak_leads l
         LEFT JOIN movatak_vendedores v ON v.id = l.vendedor_id
         LEFT JOIN movatak_followup f ON f.lead_id = l.id
        ${where}
        GROUP BY l.id, v.nome
        ORDER BY l.atualizado_em DESC NULLS LAST, l.criado_em DESC
        LIMIT $2`,
      params
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/movatak/admin/clientes/:id/leads.csv', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const r = await query(
      `SELECT l.id, l.nome, l.telefone, l.etapa, v.nome AS vendedor_nome, l.criado_em, l.atualizado_em
         FROM movatak_leads l
         LEFT JOIN movatak_vendedores v ON v.id = l.vendedor_id
        WHERE l.cliente_id = $1
        ORDER BY l.criado_em DESC`,
      [req.params.id]
    );
    const header = ['id','nome','telefone','etapa','vendedor','criado_em','atualizado_em'];
    const linhas = [header.map(csvEscape).join(',')].concat(r.rows.map(row => [
      row.id, row.nome, row.telefone, row.etapa, row.vendedor_nome, row.criado_em, row.atualizado_em
    ].map(csvEscape).join(',')));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="leads-movatak.csv"');
    res.send('\ufeff' + linhas.join('\n'));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Ativar/desativar cliente (soft delete): sai da lista do painel, mas os dados
// continuam no banco e dá pra reativar. Admin-only (nunca o portal do cliente).
app.patch('/movatak/admin/clientes/:id/ativo', authMovatak, async (req, res) => {
  try {
    const ativo = !!(req.body && req.body.ativo);
    const r = await query('UPDATE movatak_clientes SET ativo=$1 WHERE id=$2 RETURNING id', [ativo, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    res.json({ ok: true, ativo });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Excluir cliente DE VEZ (hard delete): apaga TODOS os dados do cliente em todas as
// tabelas com cliente_id (+ movatak_leads_captacao, ligada por lead_id), numa única
// transação (ou apaga tudo ou nada). Admin-only e exige `confirmar_nome` batendo com
// o nome do cliente — trava de segurança contra exclusão acidental. Irreversível.
app.delete('/movatak/admin/clientes/:id', authMovatak, async (req, res) => {
  const clienteId = req.params.id;
  try {
    const cli = await query('SELECT id, nome FROM movatak_clientes WHERE id=$1', [clienteId]);
    if (!cli.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const nome = cli.rows[0].nome || '';
    const confirmar = req.body && req.body.confirmar_nome;
    if (String(confirmar || '').trim() !== String(nome).trim()) {
      return res.status(400).json({ error: 'Confirmação inválida: o nome digitado não confere com o do cliente.' });
    }
    // Descobre dinamicamente as tabelas com cliente_id (mesma lógica do backup), então
    // tabelas novas entram automaticamente no delete.
    const tabsRes = await query(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema='public' AND column_name='cliente_id' AND table_name LIKE 'movatak_%'
        GROUP BY table_name ORDER BY table_name`
    );
    const tabelas = tabsRes.rows
      .map(r => r.table_name)
      .filter(t => /^movatak_[a-z_]+$/.test(t) && t !== 'movatak_clientes' && t !== 'movatak_leads');
    const temCaptacao = (await query(`SELECT to_regclass('public.movatak_leads_captacao') AS t`)).rows[0].t;

    const client = await pool.connect();
    const contagens = {};
    try {
      await client.query('BEGIN');
      // 1) leads_captacao liga por lead_id (não tem cliente_id).
      if (temCaptacao) {
        const capt = await client.query(
          'DELETE FROM movatak_leads_captacao WHERE lead_id IN (SELECT id FROM movatak_leads WHERE cliente_id=$1)',
          [clienteId]
        );
        contagens['movatak_leads_captacao'] = capt.rowCount || 0;
      }
      // 2) leads primeiro: cascateia filhos com FK e libera os FKs NO ACTION que
      //    apontam de leads -> planos/setores/vendedores.
      const leadsDel = await client.query('DELETE FROM movatak_leads WHERE cliente_id=$1', [clienteId]);
      contagens['movatak_leads'] = leadsDel.rowCount || 0;
      // 3) demais tabelas com cliente_id (ordem indiferente: sem FK NO ACTION entre elas).
      for (const t of tabelas) {
        const dr = await client.query(`DELETE FROM ${t} WHERE cliente_id=$1`, [clienteId]);
        contagens[t] = dr.rowCount || 0;
      }
      // 4) o próprio cliente.
      const cliDel = await client.query('DELETE FROM movatak_clientes WHERE id=$1', [clienteId]);
      contagens['movatak_clientes'] = cliDel.rowCount || 0;
      await client.query('COMMIT');
      res.json({ ok: true, cliente_id: Number(clienteId), nome, contagens });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => null);
      res.status(500).json({ error: 'Falha ao excluir (nada foi apagado): ' + e.message });
    } finally {
      client.release();
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/admin/clientes/:id/backup', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const clienteId = req.params.id;
    // Log/dedupe/transientes ficam de fora (sem valor de restore e podem inchar demais).
    const IGNORAR = new Set(['movatak_webhook_eventos', 'movatak_etiqueta_log', 'movatak_ausencia_enviada']);

    const tabsRes = await query(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema='public' AND column_name='cliente_id' AND table_name LIKE 'movatak_%'
        GROUP BY table_name ORDER BY table_name`
    );

    const tabelas = {};
    const contagens = {};

    // Config do próprio cliente (movatak_clientes tem PK id, não cliente_id).
    const cliRes = await query('SELECT * FROM movatak_clientes WHERE id = $1', [clienteId]);
    if (!cliRes.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    tabelas['movatak_clientes'] = cliRes.rows;
    contagens['movatak_clientes'] = cliRes.rows.length;
    const clienteNome = cliRes.rows[0].nome || ('cliente_' + clienteId);

    for (const row of tabsRes.rows) {
      const t = row.table_name;
      if (IGNORAR.has(t)) continue;
      if (!/^movatak_[a-z_]+$/.test(t)) continue; // defesa extra contra nome inesperado
      const r = await query(`SELECT * FROM ${t} WHERE cliente_id = $1`, [clienteId]);
      tabelas[t] = r.rows;
      contagens[t] = r.rows.length;
    }

    const backup = {
      movatak_backup: true,
      versao: MOVATAK_VERSION,
      gerado_em: new Date().toISOString(),
      cliente_id: Number(clienteId),
      cliente_nome: clienteNome,
      contagens,
      tabelas
    };

    const slug = String(clienteNome).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 40) || 'cliente';
    const dataStr = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="movatak-backup-${slug}-${dataStr}.json"`);
    res.send(JSON.stringify(backup));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/movatak/admin/clientes/:id/conexao/status', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const creds = await getZapiCreds(req.params.id);
    if (!creds) return res.json({ ok: true, configurado: false, conectado: false, detalhe: 'Instância Z-API não configurada.' });
    const st = await zapiStatus(creds.instance, creds.token, creds.clientToken);
    const conectado = st.connected === true;
    res.json({
      ok: true, configurado: true, conectado,
      detalhe: st.error || (conectado ? 'Conectado' : (st.smartphoneConnected === false ? 'Celular desconectado' : 'Desconectado'))
    });
  } catch (e) {
    res.json({ ok: false, configurado: true, conectado: false, detalhe: 'Erro ao consultar: ' + (e.response?.data?.error || e.message) });
  }
});

app.post('/movatak/admin/clientes/:id/conexao/restart', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const creds = await getZapiCreds(req.params.id);
    if (!creds) return res.status(400).json({ error: 'Instância não configurada.' });
    await zapiRestart(creds.instance, creds.token, creds.clientToken);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.response?.data?.error || e.message });
  }
});

app.get('/movatak/admin/clientes/:id/conexao/qr', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const creds = await getZapiCreds(req.params.id);
    if (!creds) return res.status(400).json({ error: 'Instância não configurada.' });
    try {
      const st = await zapiStatus(creds.instance, creds.token, creds.clientToken);
      if (st.connected === true) return res.json({ ok: true, conectado: true, qr: null });
    } catch (_) {}
    const data = await zapiQrImagem(creds.instance, creds.token, creds.clientToken);
    let img = null;
    if (data) img = data.value || data.qrcode || (typeof data === 'string' ? data : null);
    if (!img) return res.json({ ok: true, conectado: false, qr: null, detalhe: 'QR indisponível no momento, tente novamente.' });
    const qr = String(img).startsWith('data:') ? img : ('data:image/png;base64,' + img);
    res.json({ ok: true, conectado: false, qr });
  } catch (e) {
    res.status(500).json({ error: e.response?.data?.error || e.message });
  }
});

app.post('/movatak/admin/clientes/:id/relatorio-diario/enviar', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const rel = await montarRelatorioDiarioCliente(req.params.id);
    if (!rel) return res.status(404).json({ error: 'Cliente nao encontrado.' });
    if (!rel.cliente.whatsapp_dono) return res.status(400).json({ error: 'WhatsApp do dono nao configurado.' });
    await zapiEnviar(rel.cliente.zapi_instance, rel.cliente.zapi_token, rel.cliente.zapi_client_token, rel.cliente.whatsapp_dono, rel.mensagem);
    res.json({ ok: true, mensagem: rel.mensagem });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/movatak/admin/clientes/:id/campanhas', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    await garantirEstruturaCampanhasTemplates();
    const r = await query(
      `WITH camp AS (
           SELECT c.*,
                  COUNT(*) OVER (PARTITION BY c.cliente_id, LOWER(TRIM(COALESCE(c.gatilho,'')))) AS qtd_mesmo_gatilho
             FROM movatak_campanhas c
            WHERE c.cliente_id = $1
              AND c.excluida_em IS NULL
        )
        SELECT c.id, c.cliente_id, c.nome, c.apelido, c.gatilho, c.verba_diaria, c.investimento_tipo, c.investimento_valor, c.template_id, c.ativo, c.questionario_ativo, c.questionario_template_id, c.criado_em, c.atualizado_em,
              t.nome AS template_nome,
              qt.nome AS questionario_template_nome,
              c.qtd_mesmo_gatilho::int AS campanhas_mesmo_gatilho,
              (c.qtd_mesmo_gatilho > 1) AS gatilho_compartilhado,
              COUNT(l.id)::int AS leads,
              COUNT(l.id) FILTER (WHERE l.etapa = 'cliente')::int AS vendas,
              COALESCE(ROUND((100.0 * COUNT(l.id) FILTER (WHERE l.etapa = 'cliente') / NULLIF(COUNT(l.id),0))::numeric, 1), 0) AS conversao,
              COALESCE(c.investimento_valor, c.verba_diaria, 0) AS investimento,
              CASE WHEN COUNT(l.id) > 0 THEN ROUND((COALESCE(c.investimento_valor, c.verba_diaria, 0) / NULLIF(COUNT(l.id),0))::numeric, 2) ELSE NULL END AS cpl,
              CASE WHEN COUNT(l.id) FILTER (WHERE l.etapa = 'cliente') > 0 THEN ROUND((COALESCE(c.investimento_valor, c.verba_diaria, 0) / NULLIF(COUNT(l.id) FILTER (WHERE l.etapa = 'cliente'),0))::numeric, 2) ELSE NULL END AS custo_venda
         FROM camp c
         LEFT JOIN movatak_followup_templates t ON t.id = c.template_id
         LEFT JOIN movatak_questionario_templates qt ON qt.id = c.questionario_template_id
         LEFT JOIN movatak_leads l
           ON (CASE WHEN c.qtd_mesmo_gatilho > 1
                    THEN LOWER(TRIM(COALESCE(l.gatilho_detectado,''))) = LOWER(TRIM(COALESCE(c.gatilho,'')))
                    ELSE l.campanha_id = c.id
               END)
        GROUP BY c.id, c.cliente_id, c.nome, c.apelido, c.gatilho, c.verba_diaria, c.investimento_tipo, c.investimento_valor, c.template_id, c.ativo, c.questionario_ativo, c.questionario_template_id, c.criado_em, c.atualizado_em, c.qtd_mesmo_gatilho, t.nome, qt.nome
        ORDER BY c.ativo DESC, c.criado_em DESC`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (e) {
    console.error('[campanhas][listar]', e.message);
    // Não quebra o painel se a migração de campanhas ainda não foi executada.
    if (erroEstruturaBanco(e)) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

app.post('/movatak/admin/clientes/:id/campanhas', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    await garantirEstruturaCampanhasTemplates();
    const { nome, apelido, gatilho, verba_diaria, investimento_tipo, investimento_valor, template_id, questionario_ativo, questionario_template_id } = req.body || {};
    if (!nome) return res.status(400).json({ error: 'Nome da campanha é obrigatório.' });
    const apelidoFinal = apelido ? String(apelido).trim().slice(0, 60) || null : null;
    const gatilhoFinal = gatilho ? String(gatilho).trim() : null;
    if (!gatilhoFinal) return res.status(400).json({ error: 'Frase-gatilho da campanha é obrigatória para atribuição confiável.' });
    const investimentoTipo = ['diario','total'].includes(String(investimento_tipo || '').toLowerCase()) ? String(investimento_tipo).toLowerCase() : 'diario';
    const investimentoValor = parseMoedaParaNumero(investimento_valor !== undefined ? investimento_valor : verba_diaria);
    // A partir da v2.1.3 permitimos o mesmo gatilho em mais de uma campanha.
    // Observação: quando isso acontece, a atribuição exata por campanha fica compartilhada pelo gatilho.
    const templateDbId = await resolverTemplateCampanha(req.params.id, template_id);
    const questTplId = (questionario_template_id !== undefined && questionario_template_id !== null && String(questionario_template_id) !== '') ? parseInt(questionario_template_id, 10) : null;
    const r = await query(
      `INSERT INTO movatak_campanhas (cliente_id, nome, apelido, gatilho, verba_diaria, investimento_tipo, investimento_valor, template_id, questionario_ativo, questionario_template_id, ativo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true) RETURNING *`,
      [req.params.id, String(nome).trim(), apelidoFinal, gatilhoFinal, investimentoValor, investimentoTipo, investimentoValor, templateDbId, typeof questionario_ativo === 'boolean' ? questionario_ativo : true, questTplId]
    );
    res.json(r.rows[0]);
  } catch (e) {
    console.error('[campanhas][criar]', e.message);
    if (erroEstruturaBanco(e)) return res.status(400).json({ error: 'Tabela de campanhas não existe ou está desatualizada. Rode a MIGRACOES-v2.1.1.sql no PostgreSQL do Railway.' });
    res.status(500).json({ error: e.message });
  }
});

app.patch('/movatak/admin/campanhas/:id', ...exigeCampanha, async (req, res) => {
  try {
    await garantirEstruturaCampanhasTemplates();
    const { nome, apelido, gatilho, verba_diaria, investimento_tipo, investimento_valor, template_id, ativo, questionario_ativo, questionario_template_id } = req.body || {};
    // apelido: undefined = preserva; string vazia = limpa (volta a usar o nome); valor = define.
    const apelidoParam = apelido === undefined ? null : String(apelido).trim().slice(0, 60);
    const investimentoValor = investimento_valor !== undefined ? parseMoedaParaNumero(investimento_valor) : (verba_diaria !== undefined ? parseMoedaParaNumero(verba_diaria) : null);
    const investimentoTipo = investimento_tipo === undefined ? null : (['diario','total'].includes(String(investimento_tipo).toLowerCase()) ? String(investimento_tipo).toLowerCase() : 'diario');
    // template_id: quando enviado (mesmo null), sobrescreve — permite DESVINCULAR o follow-up
    // (ex.: campanha que passa a ser só autoatendimento). Quando ausente (undefined), preserva.
    const templateProvided = template_id !== undefined;
    const templateDbId = templateProvided ? await resolverTemplateCampanha(null, template_id) : null;
    const questTplProvided = questionario_template_id !== undefined;
    const questTplId = questTplProvided ? ((questionario_template_id === null || String(questionario_template_id) === '') ? null : parseInt(questionario_template_id, 10)) : null;
    const r = await query(
      `UPDATE movatak_campanhas
          SET nome = COALESCE($1, nome),
              gatilho = CASE WHEN $2::text IS NULL THEN gatilho ELSE $2 END,
              verba_diaria = CASE WHEN $3::text IS NULL THEN verba_diaria ELSE $3::numeric END,
              investimento_valor = CASE WHEN $3::text IS NULL THEN investimento_valor ELSE $3::numeric END,
              investimento_tipo = COALESCE($4, investimento_tipo),
              template_id = CASE WHEN $11::boolean THEN $5::int ELSE template_id END,
              ativo = COALESCE($6, ativo),
              questionario_ativo = COALESCE($8, questionario_ativo),
              questionario_template_id = CASE WHEN $9::boolean THEN $10::int ELSE questionario_template_id END,
              apelido = CASE WHEN $12::text IS NULL THEN apelido ELSE NULLIF($12, '') END,
              atualizado_em = NOW()
        WHERE id = $7 RETURNING *`,
      [nome ? String(nome).trim() : null, gatilho === undefined ? null : String(gatilho || '').trim(), investimentoValor, investimentoTipo, templateDbId, typeof ativo === 'boolean' ? ativo : null, req.params.id, typeof questionario_ativo === 'boolean' ? questionario_ativo : null, questTplProvided, questTplId, templateProvided, apelidoParam]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Campanha não encontrada.' });
    // Propaga a etiqueta (apelido, ou o nome se sem apelido) para os leads já
    // atribuídos a esta campanha, para a mudança refletir nos cards existentes.
    const camp = r.rows[0];
    const rotulo = camp.apelido || camp.nome || null;
    await query('UPDATE movatak_leads SET anuncio_apelido = $1 WHERE campanha_id = $2', [rotulo, camp.id]).catch(() => null);
    res.json(camp);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/movatak/admin/campanhas/:id', ...exigeCampanha, async (req, res) => {
  try {
    await garantirEstruturaCampanhasTemplates();
    const r = await query(
      `UPDATE movatak_campanhas
          SET ativo = false,
              excluida_em = NOW(),
              atualizado_em = NOW()
        WHERE id = $1 AND excluida_em IS NULL
        RETURNING id, nome`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Campanha não encontrada ou já excluída.' });
    res.json({ ok: true, campanha: r.rows[0] });
  } catch (e) {
    console.error('[campanhas][excluir]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/movatak/admin/templates-followup/:id', ...exigeTemplateFU, async (req, res) => {
  try {
    await garantirEstruturaCampanhasTemplates();
    const templateId = String(req.params.id || '').replace(/\D/g, '');
    if (!templateId) return res.status(400).json({ error: 'Template inválido.' });

    const usado = await query(
      `SELECT COUNT(*)::int AS total
         FROM movatak_campanhas
        WHERE template_id = $1
          AND ativo = true
          AND excluida_em IS NULL`,
      [templateId]
    );
    if (parseInt((usado.rows[0] || {}).total || 0, 10) > 0) {
      return res.status(400).json({ error: 'Este template está vinculado a campanha ativa. Exclua a campanha ou troque o template antes.' });
    }

    const r = await query(
      `UPDATE movatak_followup_templates
          SET ativo = false
        WHERE id = $1 AND ativo = true
        RETURNING id, nome`,
      [templateId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Template personalizado não encontrado.' });
    res.json({ ok: true, template: r.rows[0] });
  } catch (e) {
    console.error('[templates][excluir]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/movatak/admin/templates-followup', authMovatakOuApp, async (req, res) => {
  try {
    await garantirEstruturaCampanhasTemplates();
    // Cliente só vê os próprios templates: força o cliente_id do token.
    const clienteId = req.ehCliente ? req.clienteId : (req.query.cliente_id || req.query.clienteId || null);
    const padroes = Object.entries(TEMPLATES_FOLLOWUP).map(([id, t]) => ({
      id,
      nome: t.nome,
      tipo: 'padrao'
    }));
    if (!clienteId) return res.json(padroes);

    let custom = [];
    try {
      custom = (await listarTemplatesCustom(clienteId)).map(t => ({
        id: 'custom:' + t.id,
        nome: t.nome,
        tipo: 'cliente'
      }));
    } catch (e) {
      if (!erroEstruturaBanco(e)) throw e;
      console.error('[templates][listar-custom]', e.message);
    }

    res.json([...padroes, ...custom]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/admin/clientes/:id/template-followup-mensagens', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    await garantirEstruturaCampanhasTemplates();
    const templateRef = String(req.body.template || '').trim();
    const recebido = req.body.followup_v2 || {};
    const followup_v2 = {
      fu1: {
        msg1: String((recebido.fu1 && recebido.fu1.msg1) || '').trim(),
        msg2: String((recebido.fu1 && recebido.fu1.msg2) || '').trim()
      },
      fu2: {
        msg1: String((recebido.fu2 && recebido.fu2.msg1) || '').trim(),
        msg2: String((recebido.fu2 && recebido.fu2.msg2) || '').trim(),
        msg3: String((recebido.fu2 && recebido.fu2.msg3) || '').trim()
      }
    };

    if (!templateRef) {
      return res.status(400).json({ error: 'SEM_TEMPLATE' });
    }

    // Templates padrão (constantes no código) não podem ser editados.
    if (!templateRef.startsWith('custom:')) {
      return res.status(400).json({ error: 'TEMPLATE_PADRAO' });
    }

    const templateDbId = templateRef.replace('custom:', '').replace(/\D/g, '');
    const upd = await query(
      `UPDATE movatak_followup_templates
          SET followup_v2 = $1::jsonb
        WHERE id = $2 AND cliente_id = $3 AND ativo = true
        RETURNING id, nome`,
      [JSON.stringify(followup_v2), templateDbId, req.params.id]
    );
    if (!upd.rows.length) return res.status(404).json({ error: 'Template não encontrado.' });

    // Conta uso para informar o alcance.
    const usoCamp = await query(
      `SELECT COUNT(*)::int AS total FROM movatak_campanhas WHERE template_id = $1 AND ativo = true AND excluida_em IS NULL`,
      [templateDbId]
    ).catch(() => ({ rows: [{ total: 0 }] }));

    res.json({ ok: true, template: upd.rows[0], usado_em_campanhas: usoCamp.rows[0].total });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/movatak/admin/clientes/:id/templates-followup', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    await garantirEstruturaCampanhasTemplates();
    const body = req.body || {};
    const nome = String(body.nome || '').trim();
    const followup = body.followup_v2 || body.followup || {};
    if (!nome) return res.status(400).json({ error: 'Informe o nome do template.' });
    if (!followup || typeof followup !== 'object') return res.status(400).json({ error: 'Template sem mensagens de follow-up.' });

    const r = await query(
      `INSERT INTO movatak_followup_templates
         (cliente_id, nome, trigger_msg, followup_v2, boas_vindas_msg, comandos, ativo)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, true)
       RETURNING id, nome`,
      [
        req.params.id,
        nome,
        body.trigger_msg ? String(body.trigger_msg).trim() : null,
        JSON.stringify(followup),
        body.boas_vindas_msg || null,
        JSON.stringify(body.comandos || {})
      ]
    );
    res.json({ ok: true, id: 'custom:' + r.rows[0].id, nome: r.rows[0].nome });
  } catch (e) {
    console.error('[templates][criar]', e.message);
    if (erroEstruturaBanco(e)) return res.status(400).json({ error: 'Tabela de templates não existe no banco. Rode a MIGRACOES-v2.1.1.sql no PostgreSQL do Railway.' });
    res.status(500).json({ error: e.message });
  }
});

app.get('/movatak/admin/clientes/:id/template-conteudo', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    await garantirEstruturaCampanhasTemplates();
    const templateId = String(req.query.template || '').trim();
    if (!templateId) return res.status(400).json({ error: 'Informe o template.' });
    let t = null;

    if (templateId.startsWith('custom:')) {
      const templateDbId = templateId.replace('custom:', '').replace(/\D/g, '');
      const r = await query(
        `SELECT nome, trigger_msg, followup_v2, boas_vindas_msg, comandos
           FROM movatak_followup_templates
          WHERE id = $1 AND cliente_id = $2 AND ativo = true`,
        [templateDbId, req.params.id]
      );
      if (!r.rows.length) return res.status(404).json({ error: 'Template personalizado não encontrado.' });
      const row = r.rows[0];
      t = {
        nome: row.nome,
        trigger_msg: row.trigger_msg || '',
        followup_v2: row.followup_v2 || {},
        boas_vindas_msg: row.boas_vindas_msg || '',
        comandos: row.comandos || {}
      };
    } else {
      const base = TEMPLATES_FOLLOWUP[templateId];
      if (!base) return res.status(404).json({ error: 'Template não encontrado.' });
      t = {
        nome: base.nome,
        trigger_msg: base.trigger_msg || '',
        followup_v2: base.followup_v2 || {},
        boas_vindas_msg: base.boas_vindas_msg || '',
        comandos: base.comandos || {}
      };
    }
    res.json(t);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/clientes/:id/aplicar-template', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    await garantirEstruturaCampanhasTemplates();
    const templateId = String((req.body || {}).template || '').trim();
    let t = null;

    if (templateId.startsWith('custom:')) {
      const templateDbId = templateId.replace('custom:', '').replace(/\D/g, '');
      const r = await query(
        `SELECT * FROM movatak_followup_templates
          WHERE id = $1 AND cliente_id = $2 AND ativo = true`,
        [templateDbId, req.params.id]
      );
      if (!r.rows.length) return res.status(400).json({ error: 'Template personalizado não encontrado.' });
      const row = r.rows[0];
      t = {
        nome: row.nome,
        trigger_msg: row.trigger_msg,
        followup_v2: row.followup_v2 || {},
        boas_vindas_msg: row.boas_vindas_msg || '',
        comandos: row.comandos || null
      };
    } else {
      t = TEMPLATES_FOLLOWUP[templateId];
    }

    if (!t) return res.status(400).json({ error: 'Template inválido.' });

    const comandosJson = t.comandos ? JSON.stringify(t.comandos) : null;
    await query(
      `UPDATE movatak_clientes
          SET followup_msgs_v2 = $1::jsonb,
              boas_vindas_msg = $2,
              trigger_msg = COALESCE(NULLIF($3,''), trigger_msg),
              comandos = COALESCE($4::jsonb, comandos)
        WHERE id = $5`,
      [JSON.stringify(t.followup_v2), t.boas_vindas_msg, t.trigger_msg || '', comandosJson, req.params.id]
    );
    res.json({ ok: true, template: templateId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/clientes/:id/testar-zapi', authMovatak, async (req, res) => {
  try {
    const r = await query('SELECT * FROM movatak_clientes WHERE id = $1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const c = r.rows[0];
    const destino = String((req.body || {}).telefone || c.whatsapp_dono || MOVATAK_ADMIN_WA).replace(/\D/g, '');
    if (!destino) return res.status(400).json({ error: 'Informe um telefone para teste.' });
    const msg = `Teste Z-API Movatak CRM ${MOVATAK_VERSION} — ${new Date().toLocaleString('pt-BR')}`;
    await zapiEnviar(c.zapi_instance, c.zapi_token, c.zapi_client_token, destino, msg);
    res.json({ ok: true, telefone: destino });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Cobrar = inicia a régua de recuperação de carrinho manualmente (o antigo
// disparo por palavra-gatilho, agora num botão do card). Reusa agendarCobranca.
app.patch('/movatak/admin/leads/:id/cobrar', ...exigeLead, async (req, res) => {
  try {
    const lr = await query('SELECT id, nome, cliente_id FROM movatak_leads WHERE id = $1', [req.params.id]);
    if (!lr.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    const lead = lr.rows[0];
    const cr = await query('SELECT id, cobranca_v2 FROM movatak_clientes WHERE id = $1', [lead.cliente_id]);
    if (!cr.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const cliente = cr.rows[0];
    const cfg = lerConfigCobranca(cliente);
    if (!cfg.msgs.some(m => m.texto)) {
      return res.status(400).json({ error: 'Configure a régua de recuperação de carrinho primeiro (menu Follow-up).' });
    }
    await agendarCobranca(cliente, lead);
    await registrarEventoLead(lead.id, cliente.id, 'cobranca_manual', 'Recuperação de carrinho iniciada pelo painel');
    res.json({ ok: true, lembretes: cfg.msgs.filter(m => m.texto).length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Chamar atendente = sinaliza que um humano precisa assumir (pausa automação,
// acende o chip de atendente e marca não lida). O antigo #ATENDENTE num botão.
app.patch('/movatak/admin/leads/:id/atendente', ...exigeLead, async (req, res) => {
  try {
    const lr = await query('SELECT id, cliente_id FROM movatak_leads WHERE id = $1', [req.params.id]);
    if (!lr.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    const lead = lr.rows[0];
    await query(`UPDATE movatak_leads SET automacao_pausada = true, pediu_atendente = true, pediu_atendente_em = NOW(), nao_lida = true, atualizado_em = NOW() WHERE id = $1`, [lead.id]);
    await query(`UPDATE movatak_followup SET status = 'pausado' WHERE lead_id = $1 AND status = 'pendente'`, [lead.id]).catch(() => null);
    try { emitirLeadFlags(lead.cliente_id, lead.id, { pediu_atendente: true, nao_lida: true, automacao_pausada: true }); } catch (e) {}
    await registrarEventoLead(lead.id, lead.cliente_id, 'atendente_manual', 'Atendente humano acionado pelo painel');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Desfazer venda = reverte a conversão (só se o lead estiver como cliente).
app.patch('/movatak/admin/leads/:id/desfazer-venda', ...exigeLead, async (req, res) => {
  try {
    const lr = await query('SELECT id, cliente_id, etapa FROM movatak_leads WHERE id = $1', [req.params.id]);
    if (!lr.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    const lead = lr.rows[0];
    if (lead.etapa !== 'cliente') return res.status(400).json({ error: 'Este lead não está marcado como cliente.' });
    await query(`UPDATE movatak_leads SET etapa = 'lead', vendedor_id = NULL, convertido_em = NULL, atualizado_em = NOW() WHERE id = $1`, [lead.id]);
    await registrarEventoLead(lead.id, lead.cliente_id, 'venda_desfeita', 'Conversão revertida pelo painel');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/admin/leads/:id/cliente', ...exigeLead, async (req, res) => {
  try {
    const lead = await query('SELECT id, cliente_id FROM movatak_leads WHERE id = $1', [req.params.id]);
    if (!lead.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    await query(`UPDATE movatak_leads SET etapa = 'cliente', convertido_em = NOW(), atualizado_em = NOW() WHERE id = $1`, [req.params.id]);
    await query(`UPDATE movatak_followup SET status = 'pausado' WHERE lead_id = $1 AND status = 'pendente'`, [req.params.id]);
    await registrarEventoLead(req.params.id, lead.rows[0].cliente_id, 'cliente_manual', 'Lead marcado como cliente pelo painel');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/admin/leads/:id/descartar', ...exigeLead, async (req, res) => {
  try {
    const lead = await query('SELECT id, cliente_id FROM movatak_leads WHERE id = $1', [req.params.id]);
    if (!lead.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    await query(`UPDATE movatak_leads SET etapa = 'descartado', atualizado_em = NOW() WHERE id = $1`, [req.params.id]);
    await query(`UPDATE movatak_followup SET status = 'pausado' WHERE lead_id = $1 AND status = 'pendente'`, [req.params.id]);
    await registrarEventoLead(req.params.id, lead.rows[0].cliente_id, 'descartado_manual', 'Lead descartado pelo painel');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/admin/leads/:id/vendedor', ...exigeLead, async (req, res) => {
  try {
    const vendedorId = req.body && req.body.vendedor_id ? parseInt(req.body.vendedor_id) : null;
    const lead = await query('SELECT id, cliente_id FROM movatak_leads WHERE id = $1', [req.params.id]);
    if (!lead.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    await query(`UPDATE movatak_leads SET vendedor_id = $1, atualizado_em = NOW() WHERE id = $2`, [vendedorId, req.params.id]);
    await registrarEventoLead(req.params.id, lead.rows[0].cliente_id, 'vendedor_atribuido_manual', 'Vendedor atribuído manualmente pelo painel', { vendedor_id: vendedorId });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/movatak/admin/leads/:id', ...exigeLead, async (req, res) => {
  try {
    const lead = await query('SELECT id, cliente_id FROM movatak_leads WHERE id = $1', [req.params.id]);
    if (!lead.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    const leadId = req.params.id;
    // Apaga tudo que referencia o lead antes de apagar o lead em si, pra não deixar órfãos.
    await query('DELETE FROM movatak_conversas WHERE lead_id = $1', [leadId]).catch(() => null);
    await query('DELETE FROM movatak_followup WHERE lead_id = $1', [leadId]).catch(() => null);
    await query('DELETE FROM movatak_lead_eventos WHERE lead_id = $1', [leadId]).catch(() => null);
    await query('DELETE FROM movatak_mensagens WHERE lead_id = $1', [leadId]).catch(() => null);
    await query('DELETE FROM movatak_menu_estado WHERE lead_id = $1', [leadId]).catch(() => null);
    await query('DELETE FROM movatak_questionario_estado WHERE lead_id = $1', [leadId]).catch(() => null);
    await query('DELETE FROM movatak_leads WHERE id = $1', [leadId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/upload-imagem', authMovatakOuApp, async (req, res) => {
  try {
    const dataUrl = (req.body && req.body.dataUrl) || '';
    const nomeArquivo = String((req.body && req.body.fileName) || '').trim();
    // O navegador pode mandar parâmetros extras no content-type (ex: "audio/webm;codecs=opus")
    // antes do ";base64," — por isso o (?:;[^;,]+)* aceita qualquer quantidade deles no meio.
    const m = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)(?:;[^;,]+)*;base64,(.+)$/i.exec(dataUrl);
    if (!m) return res.status(400).json({ error: 'Arquivo inválido.' });
    const contentType = m[1].toLowerCase();
    // Qualquer extensão é aceita: mídia (imagem/vídeo/áudio) vai como mídia; o resto vai
    // como DOCUMENTO. Só o TAMANHO limita (não há mais allowlist de tipos).
    const ehVideo = contentType.startsWith('video/');
    const ehAudio = contentType.startsWith('audio/');
    const ehImagem = contentType.startsWith('image/');
    const tipo = ehVideo ? 'video' : (ehAudio ? 'audio' : (ehImagem ? 'imagem' : 'documento'));
    const extMap = {
      'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
      'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
      'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac'
    };
    // Extensão: p/ documento usa a do nome do arquivo; senão o mapa de mídia; senão o subtipo do content-type.
    const extDoNome = (nomeArquivo.match(/\.([a-z0-9]{1,8})$/i) || [])[1];
    const ext = (tipo === 'documento' ? (extDoNome || (contentType.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '')) : (extMap[contentType] || (ehVideo ? 'mp4' : (ehAudio ? 'webm' : 'jpg')))).toLowerCase().slice(0, 8) || 'bin';
    const buffer = Buffer.from(m[2], 'base64');
    // Limite só por TAMANHO. Cabe no body de 30mb (base64 infla ~33%): teto ~20MB reais.
    const limite = 20 * 1024 * 1024;
    if (buffer.length > limite) {
      return res.status(413).json({ error: 'Arquivo muito grande (máx. 20MB).' });
    }
    const url = await uploadSupabase(buffer, contentType || 'application/octet-stream', ext);
    res.json({ ok: true, url, tipo, fileName: nomeArquivo || ('arquivo.' + ext), ext });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/admin/clientes/:id/questionario', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    await garantirEstruturaQuestionario();
    const r = await query(
      `SELECT questionario_ativo, questionario_intro, questionario_final,
              questionario_intro_imagem, questionario_final_imagem,
              questionario_passos, questionario_recomendacao,
              questionario_comando_parar, questionario_comando_ativar,
              questionario_msg_parar,
              acao_arquivar_ao_final, acao_marcar_nao_lido, enviar_msg_final,
              quest_lembrete_msg, quest_lembrete_minutos, questionario_coluna_destino_id,
              ligacao_perdida_ativo, ligacao_perdida_msg, ligacao_coluna_destino_id, ligacao_antispam_horas
         FROM movatak_clientes WHERE id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const rp = await query('SELECT id, nome, valor, nota_minima FROM movatak_planos WHERE cliente_id = $1 ORDER BY nota_minima ASC, valor ASC NULLS LAST, id ASC', [req.params.id]);
    const colr = await query('SELECT id, nome FROM movatak_funil_colunas WHERE cliente_id = $1 AND ativo = true ORDER BY ordem ASC, id ASC', [req.params.id]).catch(() => ({ rows: [] }));
    res.json({
      ativo: !!r.rows[0].questionario_ativo,
      intro: r.rows[0].questionario_intro || '',
      final: r.rows[0].questionario_final || '',
      intro_imagem: r.rows[0].questionario_intro_imagem || '',
      final_imagem: r.rows[0].questionario_final_imagem || '',
      passos: r.rows[0].questionario_passos || [],
      recomendacao: r.rows[0].questionario_recomendacao || [],
      comando_parar: r.rows[0].questionario_comando_parar || '',
      comando_ativar: r.rows[0].questionario_comando_ativar || '',
      msg_parar: r.rows[0].questionario_msg_parar || '',
      planos: rp.rows,
      acao_arquivar_ao_final: !!r.rows[0].acao_arquivar_ao_final,
      acao_marcar_nao_lido: !!r.rows[0].acao_marcar_nao_lido,
      enviar_msg_final: r.rows[0].enviar_msg_final !== false,
      quest_lembrete_msg: r.rows[0].quest_lembrete_msg || '',
      quest_lembrete_minutos: r.rows[0].quest_lembrete_minutos || null,
      questionario_coluna_destino_id: r.rows[0].questionario_coluna_destino_id || null,
      ligacao_perdida_ativo: !!r.rows[0].ligacao_perdida_ativo,
      ligacao_perdida_msg: r.rows[0].ligacao_perdida_msg || '',
      ligacao_coluna_destino_id: r.rows[0].ligacao_coluna_destino_id || null,
      ligacao_antispam_horas: r.rows[0].ligacao_antispam_horas || 12,
      colunas: colr.rows
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/admin/clientes/:id/questionario', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    await garantirEstruturaQuestionario();
    const { ativo, intro, final, intro_imagem, final_imagem, passos, recomendacao, comando_parar, comando_ativar, msg_parar, acao_arquivar_ao_final, acao_marcar_nao_lido, enviar_msg_final, quest_lembrete_msg, quest_lembrete_minutos } = req.body || {};
    await query(
      `UPDATE movatak_clientes
          SET questionario_ativo = COALESCE($1, questionario_ativo),
              questionario_intro = COALESCE($2, questionario_intro),
              questionario_final = COALESCE($3, questionario_final),
              questionario_intro_imagem = COALESCE($4, questionario_intro_imagem),
              questionario_final_imagem = COALESCE($5, questionario_final_imagem),
              questionario_passos = COALESCE($6::jsonb, questionario_passos),
              questionario_recomendacao = COALESCE($7::jsonb, questionario_recomendacao),
              acao_arquivar_ao_final = COALESCE($8, acao_arquivar_ao_final),
              acao_marcar_nao_lido = COALESCE($9, acao_marcar_nao_lido),
              questionario_comando_parar = COALESCE($10, questionario_comando_parar),
              questionario_comando_ativar = COALESCE($11, questionario_comando_ativar),
              quest_lembrete_msg = COALESCE($12, quest_lembrete_msg),
              quest_lembrete_minutos = COALESCE($13, quest_lembrete_minutos),
              enviar_msg_final = COALESCE($15, enviar_msg_final),
              questionario_msg_parar = COALESCE($16, questionario_msg_parar)
        WHERE id = $14`,
      [
        typeof ativo === 'boolean' ? ativo : null,
        intro !== undefined ? (intro || '') : null,
        final !== undefined ? (final || '') : null,
        intro_imagem !== undefined ? (intro_imagem || '') : null,
        final_imagem !== undefined ? (final_imagem || '') : null,
        passos !== undefined ? JSON.stringify(Array.isArray(passos) ? passos : []) : null,
        recomendacao !== undefined ? JSON.stringify(Array.isArray(recomendacao) ? recomendacao : []) : null,
        typeof acao_arquivar_ao_final === 'boolean' ? acao_arquivar_ao_final : null,
        typeof acao_marcar_nao_lido === 'boolean' ? acao_marcar_nao_lido : null,
        (typeof comando_parar === 'string') ? comando_parar.trim() : null,
        (typeof comando_ativar === 'string') ? comando_ativar.trim() : null,
        (typeof quest_lembrete_msg === 'string') ? quest_lembrete_msg.trim() : null,
        (Number.isInteger(quest_lembrete_minutos) && quest_lembrete_minutos > 0) ? quest_lembrete_minutos : null,
        req.params.id,
        typeof enviar_msg_final === 'boolean' ? enviar_msg_final : null,
        (typeof msg_parar === 'string') ? msg_parar.trim() : null
      ]
    );
    // Coluna de destino ao fim do questionario: atualizada a parte (fora do COALESCE),
    // pois precisa permitir LIMPAR (voltar ao padrao "em_negociacao") enviando vazio.
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'questionario_coluna_destino_id')) {
      const raw = req.body.questionario_coluna_destino_id;
      const colDestino = (raw === '' || raw === null || raw === undefined) ? null : (parseInt(raw, 10) || null);
      await query('UPDATE movatak_clientes SET questionario_coluna_destino_id = $1 WHERE id = $2', [colDestino, req.params.id]);
    }
    // Ligação perdida → auto-resposta + lead (config vive no menu Auto Atendimento).
    // Campos independentes, atualizados à parte pra ligar/desligar e limpar cada um.
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'ligacao_perdida_ativo')) {
      await query('UPDATE movatak_clientes SET ligacao_perdida_ativo = $1 WHERE id = $2', [!!req.body.ligacao_perdida_ativo, req.params.id]);
    }
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'ligacao_perdida_msg')) {
      const m = req.body.ligacao_perdida_msg;
      await query('UPDATE movatak_clientes SET ligacao_perdida_msg = $1 WHERE id = $2', [(typeof m === 'string' ? m : ''), req.params.id]);
    }
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'ligacao_coluna_destino_id')) {
      const raw = req.body.ligacao_coluna_destino_id;
      const col = (raw === '' || raw === null || raw === undefined) ? null : (parseInt(raw, 10) || null);
      await query('UPDATE movatak_clientes SET ligacao_coluna_destino_id = $1 WHERE id = $2', [col, req.params.id]);
    }
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'ligacao_antispam_horas')) {
      const n = parseInt(req.body.ligacao_antispam_horas, 10);
      const horas = Number.isFinite(n) ? Math.max(0, Math.min(168, n)) : 12;
      await query('UPDATE movatak_clientes SET ligacao_antispam_horas = $1 WHERE id = $2', [horas, req.params.id]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Disparo em massa (broadcast p/ leads de uma coluna do kanban) ──────────
// Colunas do kanban + contagem de leads elegíveis (com telefone, não arquivados).
app.get('/movatak/admin/clientes/:id/disparo-colunas', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    await garantirEstruturaDisparos();
    const r = await query(
      `SELECT c.id, c.nome,
              (SELECT count(*)::int FROM movatak_leads l
                WHERE l.cliente_id = $1 AND l.funil_coluna_id = c.id
                  AND l.telefone IS NOT NULL AND l.telefone <> '' AND COALESCE(l.arquivado,false)=false) AS leads
         FROM movatak_funil_colunas c
        WHERE c.cliente_id = $1 AND c.ativo = true
        ORDER BY c.ordem ASC NULLS LAST, c.id ASC`, [req.params.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/admin/clientes/:id/disparos', ...forcaClienteIdNaUrl, async (req, res) => {
  try { await garantirEstruturaDisparos(); res.json(await listarDisparos(req.params.id)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/clientes/:id/disparos', ...forcaClienteIdNaUrl, async (req, res) => {
  try { await garantirEstruturaDisparos(); res.json({ ok: true, ...(await criarDisparo(req.params.id, req.body || {})) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/movatak/admin/clientes/:id/disparos/teste', ...forcaClienteIdNaUrl, async (req, res) => {
  try { await garantirEstruturaDisparos(); await enviarTesteDisparo(req.params.id, req.body || {}); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/movatak/admin/clientes/:id/disparos/:did/:acao', ...forcaClienteIdNaUrl, async (req, res) => {
  try { await garantirEstruturaDisparos(); res.json({ ok: true, ...(await controlarDisparo(req.params.id, parseInt(req.params.did, 10), req.params.acao)) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Modelos de mensagem de disparo (salvar / listar / excluir).
app.get('/movatak/admin/clientes/:id/disparo-templates', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    await garantirEstruturaDisparos();
    const r = await query('SELECT id, nome, tipo, texto, midia_url, midia_nome FROM movatak_disparo_templates WHERE cliente_id=$1 ORDER BY criado_em DESC LIMIT 50', [req.params.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/movatak/admin/clientes/:id/disparo-templates', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    await garantirEstruturaDisparos();
    const { nome, tipo, texto, midia_url, midia_nome } = req.body || {};
    const t = ['texto', 'imagem', 'video', 'audio', 'documento'].includes(tipo) ? tipo : 'texto';
    if ((!texto || !String(texto).trim()) && !midia_url) return res.status(400).json({ error: 'Escreva a mensagem ou anexe uma mídia antes de salvar o modelo.' });
    const r = await query(
      'INSERT INTO movatak_disparo_templates (cliente_id, nome, tipo, texto, midia_url, midia_nome) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [req.params.id, (nome || 'Modelo').toString().slice(0, 80), t, texto || '', midia_url || null, midia_nome || null]);
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/movatak/admin/clientes/:id/disparo-templates/:tid', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    await garantirEstruturaDisparos();
    await query('DELETE FROM movatak_disparo_templates WHERE id=$1 AND cliente_id=$2', [parseInt(req.params.tid, 10), req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/admin/clientes/:id/questionario-templates', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    await garantirEstruturaQuestionario();
    const r = await query(
      `SELECT id, nome, criado_em, atualizado_em,
              COALESCE(jsonb_array_length(passos), 0) AS qtd_passos
         FROM movatak_questionario_templates
        WHERE cliente_id = $1 AND ativo = true
        ORDER BY criado_em DESC`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/admin/questionario-templates/:tid', ...exigeQuestTemplate, async (req, res) => {
  try {
    await garantirEstruturaQuestionario();
    const r = await query(`SELECT * FROM movatak_questionario_templates WHERE id = $1`, [req.params.tid]);
    if (!r.rows.length) return res.status(404).json({ error: 'Template de questionário não encontrado.' });
    const t = r.rows[0];
    res.json({
      id: t.id,
      nome: t.nome,
      intro: t.intro || '',
      final: t.final || '',
      intro_imagem: t.intro_imagem || '',
      final_imagem: t.final_imagem || '',
      passos: t.passos || [],
      recomendacao: t.recomendacao || [],
      comando_parar: t.comando_parar || '',
      comando_ativar: t.comando_ativar || ''
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/clientes/:id/questionario-templates', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    await garantirEstruturaQuestionario();
    const { nome, intro, final, intro_imagem, final_imagem, passos, recomendacao, comando_parar, comando_ativar } = req.body || {};
    if (!nome || !String(nome).trim()) return res.status(400).json({ error: 'Informe o nome do template de autoatendimento.' });
    const r = await query(
      `INSERT INTO movatak_questionario_templates
         (cliente_id, nome, intro, final, intro_imagem, final_imagem, passos, recomendacao, comando_parar, comando_ativar)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10) RETURNING id`,
      [
        req.params.id, String(nome).trim(), intro || null, final || null, intro_imagem || null, final_imagem || null,
        JSON.stringify(Array.isArray(passos) ? passos : []),
        JSON.stringify(Array.isArray(recomendacao) ? recomendacao : []),
        (typeof comando_parar === 'string' && comando_parar.trim()) ? comando_parar.trim() : null,
        (typeof comando_ativar === 'string' && comando_ativar.trim()) ? comando_ativar.trim() : null
      ]
    );
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/admin/questionario-templates/:tid', ...exigeQuestTemplate, async (req, res) => {
  try {
    await garantirEstruturaQuestionario();
    const { nome, intro, final, intro_imagem, final_imagem, passos, recomendacao, comando_parar, comando_ativar } = req.body || {};
    const r = await query(
      `UPDATE movatak_questionario_templates
          SET nome = COALESCE($1, nome),
              intro = $2, final = $3, intro_imagem = $4, final_imagem = $5,
              passos = $6::jsonb, recomendacao = $7::jsonb,
              comando_parar = $8, comando_ativar = $9,
              atualizado_em = NOW()
        WHERE id = $10 RETURNING id`,
      [
        nome ? String(nome).trim() : null, intro || null, final || null, intro_imagem || null, final_imagem || null,
        JSON.stringify(Array.isArray(passos) ? passos : []),
        JSON.stringify(Array.isArray(recomendacao) ? recomendacao : []),
        (typeof comando_parar === 'string' && comando_parar.trim()) ? comando_parar.trim() : null,
        (typeof comando_ativar === 'string' && comando_ativar.trim()) ? comando_ativar.trim() : null,
        req.params.tid
      ]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Template de questionário não encontrado.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/movatak/admin/questionario-templates/:tid', ...exigeQuestTemplate, async (req, res) => {
  try {
    await garantirEstruturaQuestionario();
    // Desvincula das campanhas que o usavam (elas voltam ao questionário do cliente).
    await query(`UPDATE movatak_campanhas SET questionario_template_id = NULL WHERE questionario_template_id = $1`, [req.params.tid]).catch(() => null);
    await query(`UPDATE movatak_questionario_templates SET ativo = false, atualizado_em = NOW() WHERE id = $1`, [req.params.tid]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/admin/clientes/:id/mensagens-rapidas', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    await garantirEstruturaMensagensRapidas();
    const r = await query('SELECT id, titulo, texto, midia_url, vezes_usado, ordem, itens, template_id FROM movatak_mensagens_rapidas WHERE cliente_id=$1 ORDER BY vezes_usado DESC, ordem ASC, id ASC', [req.params.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/clientes/:id/mensagens-rapidas', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    await garantirEstruturaMensagensRapidas();
    const { titulo, texto, midia_url, itens, template_id } = req.body || {};
    const sequencia = Array.isArray(itens) ? itens.filter(it => it && (it.texto || it.midia_url)) : [];
    if (!titulo) return res.status(400).json({ error: 'Título obrigatório.' });
    if (!sequencia.length && !texto) return res.status(400).json({ error: 'Texto obrigatório.' });
    // Quando é uma sequência, "texto" guarda um resumo (usado em listagem/busca);
    // o conteúdo real que será disparado mensagem por mensagem fica em "itens".
    const textoFinal = sequencia.length
      ? (texto || sequencia.map(it => it.texto || '').filter(Boolean).join(' ')).trim().slice(0, 500) || titulo.trim()
      : texto.trim();
    const r = await query(
      'INSERT INTO movatak_mensagens_rapidas (cliente_id, titulo, texto, midia_url, itens, template_id) VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING id, titulo, texto, midia_url, ordem, itens, template_id',
      [req.params.id, titulo.trim(), textoFinal, sequencia.length ? null : (midia_url || null), JSON.stringify(sequencia), template_id ? parseInt(template_id, 10) : null]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/admin/mensagens-rapidas/:id', ...exigeMsgRapida, async (req, res) => {
  try {
    const { titulo, texto, midia_url, itens } = req.body || {};
    await query(
      `UPDATE movatak_mensagens_rapidas SET
         titulo = COALESCE($1, titulo),
         texto = COALESCE($2, texto),
         midia_url = CASE WHEN $3::text IS NULL THEN midia_url ELSE $3 END,
         itens = CASE WHEN $4::jsonb IS NULL THEN itens ELSE $4::jsonb END
       WHERE id=$5`,
      [
        titulo || null, texto || null,
        midia_url !== undefined ? (midia_url || null) : null,
        Array.isArray(itens) ? JSON.stringify(itens) : null,
        req.params.id
      ]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/movatak/admin/mensagens-rapidas/:id', ...exigeMsgRapida, async (req, res) => {
  try {
    await query('DELETE FROM movatak_mensagens_rapidas WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/mensagens-rapidas/:id/usar', ...exigeMsgRapida, async (req, res) => {
  try {
    await query('UPDATE movatak_mensagens_rapidas SET vezes_usado = COALESCE(vezes_usado,0)+1 WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/leads/:id/iniciar-autoatendimento', ...exigeLead, async (req, res) => {
  try {
    const templateId = req.body && req.body.template_id ? parseInt(req.body.template_id, 10) : null;
    if (!templateId) return res.status(400).json({ error: 'template_id é obrigatório.' });
    const rl = await query(
      `SELECT l.*, c.* FROM movatak_leads l JOIN movatak_clientes c ON c.id = l.cliente_id WHERE l.id = $1`,
      [req.params.id]
    );
    if (!rl.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    // Despausa a automação deste lead: se estiver pausado, o webhook ignora as
    // respostas dele e o autoatendimento trava na primeira pergunta que espera resposta.
    await query('UPDATE movatak_leads SET automacao_pausada = false, pediu_atendente = false WHERE id = $1', [req.params.id]).catch(() => null);
    // Separa lead e cliente do JOIN (ambos têm colunas; reconsultamos pra ter objetos limpos)
    const leadRow = await query('SELECT * FROM movatak_leads WHERE id = $1', [req.params.id]);
    const lead = leadRow.rows[0];
    const cliRow = await query('SELECT * FROM movatak_clientes WHERE id = $1', [lead.cliente_id]);
    const cliente = cliRow.rows[0];
    // Cancela qualquer questionário em andamento desse lead antes de reiniciar,
    // pra não embolar dois fluxos ao mesmo tempo.
    await query(
      `UPDATE movatak_questionario_estado SET status='cancelado', atualizado_em=NOW()
        WHERE cliente_id=$1 AND telefone=$2 AND status IN ('em_andamento','aguardando')`,
      [cliente.id, lead.telefone]
    ).catch(() => null);
    await iniciarQuestionarioPorTemplate(cliente, lead, templateId);
    await registrarEventoLead(lead.id, cliente.id, 'autoatendimento_manual', 'Autoatendimento iniciado manualmente pelo painel', { template_id: templateId });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/leads/:id/mensagem-rapida', ...exigeLead, async (req, res) => {
  try {
    const { texto, midia_url, midia_tipo, midia_nome, midia_ext, reply_to_conversa_id, reply_to_msg_id } = req.body || {};
    if (!texto && !midia_url) return res.status(400).json({ error: 'Texto ou mídia obrigatório.' });
    const rl = await query('SELECT l.id, l.telefone, l.cliente_id, c.zapi_instance, c.zapi_token, c.zapi_client_token FROM movatak_leads l JOIN movatak_clientes c ON c.id=l.cliente_id WHERE l.id=$1', [req.params.id]);
    if (!rl.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    const row = rl.rows[0];
    let tipoFinal = null;
    let msgId = null;
    const replyResolvido = await resolverReplyInfoLead(row.id, reply_to_conversa_id, reply_to_msg_id, null);
    const replyMsgIdZap = replyResolvido.msgId || null;
    if (midia_url) {
      // Documento (qualquer extensão que não seja imagem/vídeo/áudio) → send-document.
      if (midia_tipo === 'documento') {
        tipoFinal = 'documento';
        const ext = (midia_ext || (String(midia_url).match(/\.([a-z0-9]{1,8})(?:\?|$)/i) || [])[1] || 'bin').toLowerCase();
        const fileName = midia_nome || ('arquivo.' + ext);
        msgId = await zapiEnviarDocumento(row.zapi_instance, row.zapi_token, row.zapi_client_token, row.telefone, midia_url, fileName, texto || '', ext, replyMsgIdZap);
      } else {
        tipoFinal = tipoMidia(midia_url, midia_tipo);
        if (tipoFinal === 'video') {
          msgId = await zapiEnviarVideo(row.zapi_instance, row.zapi_token, row.zapi_client_token, row.telefone, midia_url, texto || '', replyMsgIdZap);
        } else if (tipoFinal === 'audio') {
          msgId = await zapiEnviarAudio(row.zapi_instance, row.zapi_token, row.zapi_client_token, row.telefone, midia_url, replyMsgIdZap);
        } else {
          msgId = await zapiEnviarImagem(row.zapi_instance, row.zapi_token, row.zapi_client_token, row.telefone, midia_url, texto || '', replyMsgIdZap);
        }
      }
    } else {
      msgId = await zapiEnviar(row.zapi_instance, row.zapi_token, row.zapi_client_token, row.telefone, texto, replyMsgIdZap);
    }
    const conversaId = await registrarConversa(row.id, row.cliente_id, 'saida', texto || '', midia_url || null, tipoFinal, msgId, replyResolvido.info, undefined, tipoFinal === 'documento' ? (midia_nome || null) : null).catch(() => null);
    await registrarEventoLead(row.id, row.cliente_id, 'mensagem_manual', 'Mensagem rápida enviada pelo kanban', { texto: (texto||'').slice(0, 100), midia: !!midia_url });
    await limparPedidoAtendente(row.id); // atendente respondeu → apaga o chip "pediu atendente"
    // Incrementa contador de uso se o texto bate com uma mensagem rápida cadastrada
    if (texto) {
      query('UPDATE movatak_mensagens_rapidas SET vezes_usado = COALESCE(vezes_usado,0)+1 WHERE cliente_id=$1 AND texto=$2', [row.cliente_id, texto]).catch(() => null);
    }
    res.json({ ok: true, conversaId, criado_em: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/leads/:id/mensagem-kanban', ...exigeLead, async (req, res) => {
  try {
    const { texto, midia_url } = req.body || {};
    if (!texto && !midia_url) return res.status(400).json({ error: 'Texto ou mídia obrigatório.' });
    const rl = await query('SELECT l.id, l.telefone, l.cliente_id, c.zapi_instance, c.zapi_token, c.zapi_client_token FROM movatak_leads l JOIN movatak_clientes c ON c.id=l.cliente_id WHERE l.id=$1', [req.params.id]);
    if (!rl.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    const row = rl.rows[0];

    if (midia_url) {
      const tipo = tipoMidia(midia_url);
      if (tipo === 'video') {
        await zapiEnviarVideo(row.zapi_instance, row.zapi_token, row.zapi_client_token, row.telefone, midia_url, texto || '');
      } else {
        await zapiEnviarImagem(row.zapi_instance, row.zapi_token, row.zapi_client_token, row.telefone, midia_url, texto || '');
      }
    } else {
      await zapiEnviar(row.zapi_instance, row.zapi_token, row.zapi_client_token, row.telefone, texto);
    }

    await registrarConversa(row.id, row.cliente_id, 'saida', texto || '', midia_url || null).catch(() => null);
    await registrarEventoLead(row.id, row.cliente_id, 'mensagem_manual_kanban', 'Mensagem enviada manualmente pelo Kanban', { texto: (texto||'').slice(0, 100), midia: !!midia_url });
    await limparPedidoAtendente(row.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/leads/:id/reativar-followup', ...exigeLead, async (req, res) => {
  try {
    const seq = (req.body && Number(req.body.sequencia) === 2) ? 2 : 1;
    const rl = await query('SELECT id, cliente_id, etapa FROM movatak_leads WHERE id=$1', [req.params.id]);
    if (!rl.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    const lead = rl.rows[0];
    await query(`UPDATE movatak_leads SET etapa='followup', atualizado_em=NOW() WHERE id=$1`, [lead.id]);
    await agendarFollowupV2(lead.id, lead.cliente_id, seq, true);
    await enviarFollowupsPendentesDoLead(lead.id, seq);
    await registrarEventoLead(lead.id, lead.cliente_id, 'followup_reativado', 'Follow-up ' + seq + ' disparado manualmente', { sequencia: seq });
    res.json({ ok: true, sequencia: seq });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/clientes/:id/reconciliar-setores', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const clienteId = parseInt(req.params.id, 10);
    const r = await query(
      `UPDATE movatak_leads l
          SET setor_id = fc.setor_id, atualizado_em = NOW()
         FROM movatak_funil_colunas fc
        WHERE l.funil_coluna_id = fc.id
          AND l.cliente_id = $1
          AND fc.setor_id IS NOT NULL
          AND (l.setor_id IS DISTINCT FROM fc.setor_id)
        RETURNING l.id`,
      [clienteId]
    );
    res.json({ ok: true, leads_corrigidos: r.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/admin/clientes/:id/diagnostico', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const clienteId = parseInt(req.params.id, 10);
    const telefoneRaw = String(req.query.telefone || '').trim();
    if (!telefoneRaw) return res.status(400).json({ error: 'Informe o telefone.' });
    const variantes = variantesTelefone(telefoneRaw);
    if (!variantes.length) return res.status(400).json({ error: 'Telefone inválido.' });

    const ph = variantes.map((_, i) => '$' + (i + 2)).join(',');
    const rl = await query(
      `SELECT l.*, camp.nome AS campanha_nome, camp.template_id AS camp_template_id,
              camp.questionario_ativo AS camp_quest_ativo, camp.questionario_template_id AS camp_quest_template_id,
              ft.nome AS template_followup_nome, qt.nome AS template_quest_nome
         FROM movatak_leads l
         LEFT JOIN movatak_campanhas camp ON camp.id = l.campanha_id
         LEFT JOIN movatak_followup_templates ft ON ft.id = COALESCE(camp.template_id, l.template_id_origem)
         LEFT JOIN movatak_questionario_templates qt ON qt.id = camp.questionario_template_id
        WHERE l.cliente_id = $1 AND l.telefone IN (${ph})
        ORDER BY l.atualizado_em DESC NULLS LAST, l.criado_em DESC LIMIT 1`,
      [clienteId, ...variantes]
    );
    if (!rl.rows.length) return res.json({ encontrado: false, variantes_buscadas: variantes });
    const lead = rl.rows[0];

    const [estado, eventos, followups] = await Promise.all([
      query(`SELECT id, passo_idx, tentativas_invalidas, status, atualizado_em FROM movatak_questionario_estado WHERE lead_id = $1 ORDER BY id DESC LIMIT 3`, [lead.id]).catch(() => ({ rows: [] })),
      query(`SELECT tipo, descricao, criado_em FROM movatak_lead_eventos WHERE lead_id = $1 ORDER BY id DESC LIMIT 15`, [lead.id]).catch(() => ({ rows: [] })),
      query(`SELECT sequencia_fu, etapa_seq, status, proximo_envio FROM movatak_followup WHERE lead_id = $1 ORDER BY COALESCE(sequencia_fu,1), etapa_seq`, [lead.id]).catch(() => ({ rows: [] }))
    ]);

    // Qual fonte de questionário este lead usa?
    let fonteQuest = 'Questionário do cliente (padrão)';
    if (lead.camp_quest_ativo === false) fonteQuest = 'Sem autoatendimento (vai direto ao follow-up)';
    else if (lead.camp_quest_template_id) fonteQuest = 'Modelo: ' + (lead.template_quest_nome || ('#' + lead.camp_quest_template_id));

    res.json({
      encontrado: true,
      variantes_buscadas: variantes,
      lead: {
        id: lead.id, nome: lead.nome, telefone: lead.telefone, etapa: lead.etapa,
        automacao_pausada: lead.automacao_pausada,
        campanha: lead.campanha_nome || null,
        gatilho_detectado: lead.gatilho_detectado || null,
        template_followup: lead.template_followup_nome || 'Padrão do cliente',
        fonte_questionario: fonteQuest,
        criado_em: lead.criado_em, atualizado_em: lead.atualizado_em
      },
      questionario_estado: estado.rows,
      eventos: eventos.rows,
      followups: followups.rows
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/admin/clientes/:id/sla', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    await garantirEstruturaConversas();
    const clienteId = parseInt(req.params.id, 10);
    const dias = Math.max(1, Math.min(parseInt(req.query.dias || '30', 10), 180));

    // Para cada mensagem de entrada, acha a próxima saída do mesmo lead (a "resposta").
    // gap_seg = segundos entre a entrada e essa resposta.
    // primeira = true se é a primeira resposta após uma sequência de entradas (1ª resposta).
    const r = await query(
      `WITH msgs AS (
         SELECT c.id, c.lead_id, c.direcao, c.origem, c.criado_em,
                l.setor_id, l.vendedor_id
           FROM movatak_conversas c
           JOIN movatak_leads l ON l.id = c.lead_id
          WHERE c.cliente_id = $1
            AND c.criado_em >= NOW() - ($2 || ' days')::INTERVAL
       ),
       entradas AS (
         SELECT m.*,
                LAG(direcao) OVER (PARTITION BY lead_id ORDER BY criado_em) AS dir_anterior
           FROM msgs m
       ),
       respostas AS (
         SELECT e.lead_id, e.setor_id, e.vendedor_id, e.criado_em AS entrada_em,
                (e.dir_anterior IS DISTINCT FROM 'entrada') AS primeira_da_sequencia,
                (SELECT s.criado_em FROM msgs s
                   WHERE s.lead_id = e.lead_id AND s.direcao = 'saida' AND s.criado_em > e.criado_em
                   ORDER BY s.criado_em ASC LIMIT 1) AS resposta_em,
                (SELECT s.origem FROM msgs s
                   WHERE s.lead_id = e.lead_id AND s.direcao = 'saida' AND s.criado_em > e.criado_em
                   ORDER BY s.criado_em ASC LIMIT 1) AS resposta_origem
           FROM entradas e
          WHERE e.direcao = 'entrada'
       )
       SELECT setor_id, vendedor_id,
              resposta_origem,
              primeira_da_sequencia,
              COUNT(*) FILTER (WHERE resposta_em IS NOT NULL)::int AS respondidas,
              COUNT(*) FILTER (WHERE resposta_em IS NULL)::int AS sem_resposta,
              AVG(EXTRACT(EPOCH FROM (resposta_em - entrada_em))) FILTER (WHERE resposta_em IS NOT NULL) AS gap_medio_seg
         FROM respostas
        GROUP BY setor_id, vendedor_id, resposta_origem, primeira_da_sequencia`,
      [clienteId, dias]
    );

    // Nomes de setores e vendedores
    const setoresR = await query('SELECT id, nome, cor FROM movatak_setores WHERE cliente_id=$1', [clienteId]).catch(() => ({ rows: [] }));
    const vendedoresR = await query('SELECT id, nome FROM movatak_vendedores WHERE cliente_id=$1', [clienteId]).catch(() => ({ rows: [] }));
    const setorNome = new Map(setoresR.rows.map(s => [Number(s.id), s]));
    const vendNome = new Map(vendedoresR.rows.map(v => [Number(v.id), v.nome]));

    // Quantos leads estão esperando AGORA (última msg foi do lead, sem resposta).
    const esperandoR = await query(
      `WITH ult AS (
         SELECT DISTINCT ON (c.lead_id) c.lead_id, c.direcao, l.setor_id, l.vendedor_id
           FROM movatak_conversas c
           JOIN movatak_leads l ON l.id = c.lead_id
          WHERE c.cliente_id = $1 AND COALESCE(l.arquivado,false) = false
          ORDER BY c.lead_id, c.criado_em DESC
       )
       SELECT setor_id, vendedor_id, COUNT(*)::int AS esperando
         FROM ult WHERE direcao = 'entrada'
        GROUP BY setor_id, vendedor_id`,
      [clienteId]
    ).catch(() => ({ rows: [] }));

    // Monta estrutura hierárquica: setor → vendedores → métricas.
    const ehAuto = (o) => ['followup', 'ausencia', 'menu', 'questionario', 'recomendacao', 'bot'].includes(o);
    const setores = {};
    function getSetor(sid) {
      const k = sid == null ? 0 : Number(sid);
      if (!setores[k]) {
        const s = setorNome.get(k);
        setores[k] = { setor_id: k, setor_nome: s ? s.nome : 'Sem setor', setor_cor: s ? s.cor : null, vendedores: {} };
      }
      return setores[k];
    }
    function getVend(setor, vid) {
      const k = vid == null ? 0 : Number(vid);
      if (!setor.vendedores[k]) {
        setor.vendedores[k] = {
          vendedor_id: k, vendedor_nome: vid ? (vendNome.get(k) || 'Vendedor') : 'Sem vendedor',
          primeira_humano_seg: null, primeira_humano_n: 0,
          primeira_auto_seg: null, primeira_auto_n: 0,
          geral_humano_seg: null, geral_humano_n: 0,
          geral_auto_seg: null, geral_auto_n: 0,
          sem_resposta: 0, esperando: 0
        };
      }
      return setor.vendedores[k];
    }
    function acumular(alvoSeg, alvoN, gap, n) {
      // média ponderada incremental
      const totalN = alvoN + n;
      if (totalN === 0) return [alvoSeg, alvoN];
      const somaAtual = (alvoSeg || 0) * alvoN;
      const novaSoma = somaAtual + gap * n;
      return [novaSoma / totalN, totalN];
    }

    for (const row of r.rows) {
      const setor = getSetor(row.setor_id);
      const v = getVend(setor, row.vendedor_id);
      const auto = ehAuto(row.resposta_origem);
      const gap = row.gap_medio_seg != null ? Number(row.gap_medio_seg) : null;
      const n = Number(row.respondidas) || 0;
      v.sem_resposta += Number(row.sem_resposta) || 0;
      if (gap != null && n > 0) {
        if (row.primeira_da_sequencia) {
          if (auto) { [v.primeira_auto_seg, v.primeira_auto_n] = acumular(v.primeira_auto_seg, v.primeira_auto_n, gap, n); }
          else { [v.primeira_humano_seg, v.primeira_humano_n] = acumular(v.primeira_humano_seg, v.primeira_humano_n, gap, n); }
        }
        if (auto) { [v.geral_auto_seg, v.geral_auto_n] = acumular(v.geral_auto_seg, v.geral_auto_n, gap, n); }
        else { [v.geral_humano_seg, v.geral_humano_n] = acumular(v.geral_humano_seg, v.geral_humano_n, gap, n); }
      }
    }
    for (const row of esperandoR.rows) {
      const setor = getSetor(row.setor_id);
      const v = getVend(setor, row.vendedor_id);
      v.esperando += Number(row.esperando) || 0;
    }

    // Converte para arrays e arredonda.
    const out = Object.values(setores).map(s => {
      const vends = Object.values(s.vendedores).map(v => ({
        ...v,
        primeira_humano_seg: v.primeira_humano_seg != null ? Math.round(v.primeira_humano_seg) : null,
        primeira_auto_seg: v.primeira_auto_seg != null ? Math.round(v.primeira_auto_seg) : null,
        geral_humano_seg: v.geral_humano_seg != null ? Math.round(v.geral_humano_seg) : null,
        geral_auto_seg: v.geral_auto_seg != null ? Math.round(v.geral_auto_seg) : null
      }));
      return { ...s, vendedores: vends };
    });

    res.json({ dias, setores: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/admin/clientes/:id/funil', authMovatakOuApp, async (req, res) => {
  try {
    // Segurança: se for o cliente (portal), força o cliente_id do token —
    // ignora o :id da URL para ele nunca acessar outro cliente.
    const clienteId = req.ehCliente ? req.clienteId : parseInt(req.params.id, 10);
    const setorFiltro = req.query.setor ? parseInt(req.query.setor, 10) : null;
    await garantirFunilPadraoCliente(clienteId);
    // Garante a coluna do avatar antes da query referenciá-la (no-op se já existe).
    await query(`ALTER TABLE movatak_leads ADD COLUMN IF NOT EXISTS foto_url TEXT`).catch(() => null);

    // "Todos" mostra todas as colunas. Um setor específico mostra só as colunas
    // atribuídas a ele (configurado pelo seletor de setor no cabeçalho da coluna).
    const colunasParams = [clienteId];
    let filtroColunaSetorSql = '';
    if (setorFiltro) {
      colunasParams.push(setorFiltro);
      filtroColunaSetorSql = ' AND setor_id = $2';
    }
    const colunasRes = await query(
      `SELECT id, nome, slug, ordem, cor, etapa_sistema, sincronizar_whatsapp, zapi_tag_id, zapi_sync_erro, comando, setor_id, ausencia_ativa, ia_ativa, nicho_template, agenda_tipo, agenda_status, transfere_para_cliente_id
         FROM movatak_funil_colunas
        WHERE cliente_id=$1 AND ativo=true${filtroColunaSetorSql}
        ORDER BY ordem ASC, id ASC`,
      colunasParams
    );
    const colunas = colunasRes.rows.map(c => ({ ...c, leads: [] }));
    const colById = new Map(colunas.map(c => [Number(c.id), c]));
    const colBySlug = new Map(colunas.map(c => [c.slug, c]));

    const params = [clienteId];
    let filtroSetorSql = '';
    if (setorFiltro) {
      params.push(setorFiltro);
      filtroSetorSql = ' AND l.setor_id = $2';
    }
    const leads = await query(
      `SELECT lb.*, ult.conteudo AS ultima_msg, ult.direcao AS ultima_msg_direcao, ult.criado_em AS ultima_msg_em, ult.midia_tipo AS ultima_msg_midia
         FROM (
           SELECT l.id, l.nome, l.telefone, l.etapa, l.funil_coluna_id, l.vendedor_id, l.setor_id,
                  l.nao_lida, l.arquivado, COALESCE(l.trancado,false) AS trancado, l.foto_url,
                  COALESCE(l.pediu_atendente,false) AS pediu_atendente, l.pediu_atendente_em,
                  s.nome AS setor_nome, s.cor AS setor_cor,
                  l.criado_em, l.atualizado_em, l.convertido_em, l.prioridade_dispensada_em,
                  v.nome AS vendedor_nome,
                  p.nome AS plano_nome, p.valor AS plano_valor,
                  COUNT(f.id) FILTER (WHERE f.status='pendente')::int AS followups_pendentes,
                  MIN(COALESCE(f.sequencia_fu,1)) FILTER (WHERE f.status='pendente')::int AS fu_sequencia_ativa
             FROM movatak_leads l
             LEFT JOIN movatak_vendedores v ON v.id = l.vendedor_id
             LEFT JOIN movatak_planos p ON p.id = l.plano_id
             LEFT JOIN movatak_setores s ON s.id = l.setor_id
             LEFT JOIN movatak_followup f ON f.lead_id = l.id
            WHERE l.cliente_id=$1${filtroSetorSql}
            GROUP BY l.id, v.nome, p.nome, p.valor, s.nome, s.cor
         ) lb
         LEFT JOIN LATERAL (
           SELECT conteudo, direcao, criado_em, midia_tipo FROM movatak_conversas c
            WHERE c.lead_id = lb.id ORDER BY c.criado_em DESC LIMIT 1
         ) ult ON true
        ORDER BY lb.atualizado_em DESC NULLS LAST, lb.criado_em DESC
        LIMIT 500`,
      params
    );

    // Leads ativos (não arquivados nem trancados) — vão para o kanban central.
    const leadsAtivos = leads.rows.filter(l => !l.arquivado && !l.trancado);
    for (const lead of leadsAtivos) {
      let coluna = lead.funil_coluna_id ? colById.get(Number(lead.funil_coluna_id)) : null;
      if (!coluna) coluna = colBySlug.get(slugFunilPorEtapa(lead.etapa));
      if (!coluna) coluna = colunas[0];
      if (coluna) coluna.leads.push(lead);
    }

    // Colunas de vendedores (sempre as últimas — leads atribuídos de qualquer etapa)
    const vRes = await query(
      `SELECT id, nome FROM movatak_vendedores WHERE cliente_id=$1 AND COALESCE(ativo,true)=true ORDER BY nome ASC`,
      [clienteId]
    );
    const colunasVendedores = vRes.rows.map(v => ({
      id: `vendedor_${v.id}`,
      vendedor_id: v.id,
      nome: v.nome,
      leads: leadsAtivos.filter(l => l.vendedor_id === v.id)
    }));

    // Setores do cliente + contagem ao vivo (independente do filtro atual,
    // pra mostrar "Financeiro 5 / Negociação 4" nas abas mesmo trocando de aba).
    const clienteInfoRes = await query(
      `SELECT nicho, agenda_ativa,
              CASE WHEN senha_trancar_hash IS NULL OR senha_trancar_hash = '' THEN false ELSE true END AS trancar_protegido
         FROM movatak_clientes WHERE id=$1`,
      [clienteId]
    ).catch(() => ({ rows: [] }));
    const clienteInfo = clienteInfoRes.rows[0] || {};

    const setoresRes = await query(
      `SELECT id, nome, cor FROM movatak_setores
        WHERE cliente_id=$1 AND COALESCE(ativo,true)=true
        ORDER BY ordem_bot ASC, nome ASC`,
      [clienteId]
    );
    const contagemSetoresRes = await query(
      `SELECT setor_id, COUNT(*)::int AS cnt, COUNT(*) FILTER (WHERE nao_lida = true)::int AS nao_lidas
         FROM movatak_leads
        WHERE cliente_id=$1 AND COALESCE(arquivado,false)=false AND COALESCE(trancado,false)=false
        GROUP BY setor_id`,
      [clienteId]
    );
    const contagemPorSetor = new Map(contagemSetoresRes.rows.map(r => [r.setor_id, r.cnt]));
    const naoLidasPorSetor = new Map(contagemSetoresRes.rows.map(r => [r.setor_id, r.nao_lidas]));
    const setores = setoresRes.rows.map(s => ({
      ...s,
      leads_count: contagemPorSetor.get(s.id) || 0,
      nao_lidas: naoLidasPorSetor.get(s.id) || 0
    }));
    const totalGeral = contagemSetoresRes.rows.reduce((acc, r) => acc + r.cnt, 0);
    const totalNaoLidas = contagemSetoresRes.rows.reduce((acc, r) => acc + r.nao_lidas, 0);

    res.json({
      colunas, colunasVendedores,
      setores, setorAtivo: setorFiltro, totalGeral, totalNaoLidas,
      nicho: clienteInfo.nicho || null, agenda_ativa: !!clienteInfo.agenda_ativa,
      trancar_protegido: !!clienteInfo.trancar_protegido,
      leads: leads.rows // lista completa (inclui arquivados) — usada pela caixa de entrada (coluna esquerda)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/admin/clientes/:id/funil/metricas', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const clienteId = parseInt(req.params.id, 10);
    const setorFiltro = req.query.setor ? parseInt(req.query.setor, 10) : null;
    const params = [clienteId];
    let filtroSetorSql = '';
    if (setorFiltro) { params.push(setorFiltro); filtroSetorSql = ' AND l.setor_id = $2'; }

    const totaisR = await query(
      `SELECT
         COUNT(*)::int AS total_leads,
         COUNT(*) FILTER (WHERE l.nao_lida = true)::int AS novas_mensagens,
         COUNT(*) FILTER (WHERE l.criado_em >= date_trunc('month', now()))::int AS criados_mes,
         COUNT(*) FILTER (WHERE l.convertido_em >= date_trunc('month', now()))::int AS convertidos_mes
       FROM movatak_leads l
       WHERE l.cliente_id=$1 AND COALESCE(l.arquivado,false)=false${filtroSetorSql}`,
      params
    );
    const negociacaoR = await query(
      `SELECT COUNT(*)::int AS n
         FROM movatak_leads l
         LEFT JOIN movatak_funil_colunas c ON c.id = l.funil_coluna_id
        WHERE l.cliente_id=$1 AND COALESCE(l.arquivado,false)=false${filtroSetorSql}
          AND COALESCE(c.etapa_sistema, l.etapa) = 'negociacao'`,
      params
    );
    const t = totaisR.rows[0] || {};
    const conversaoMes = t.criados_mes > 0 ? Math.round((t.convertidos_mes / t.criados_mes) * 100) : 0;
    res.json({
      totalLeads: t.total_leads || 0,
      novasMensagens: t.novas_mensagens || 0,
      emNegociacao: (negociacaoR.rows[0] || {}).n || 0,
      conversaoMes
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/admin/nichos-templates', authMovatak, async (req, res) => {
  try {
    res.json(Object.entries(NICHO_TEMPLATES).map(([key, tpl]) => ({
      key,
      label: tpl.label,
      agendaTipos: tpl.agendaTipos || [],
      colunas: (tpl.colunas || []).map(c => ({ nome: c[0], slug: c[1], etapa: c[2], agenda_tipo: c[3] || null }))
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/clientes/:id/funil/aplicar-nicho', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const clienteId = parseInt(req.params.id, 10);
    const nicho = normalizarNichoCliente(req.body?.nicho);
    if (!nicho) return res.status(400).json({ error: 'Nicho inválido.' });
    const result = await aplicarTemplateNichoCliente(clienteId, nicho, { sincronizar: req.body?.sincronizar_whatsapp !== false });
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/admin/clientes/:id/agendamentos', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    await garantirEstruturaAgenda();
    const clienteId = parseInt(req.params.id, 10);
    const dias = Math.max(1, Math.min(parseInt(req.query.dias || '30', 10), 120));
    const r = await query(
      `SELECT a.*, l.nome AS lead_nome, l.telefone AS lead_telefone, c.nome AS coluna_nome
         FROM movatak_agendamentos a
         LEFT JOIN movatak_leads l ON l.id = a.lead_id
         LEFT JOIN movatak_funil_colunas c ON c.id = a.funil_coluna_id
        WHERE a.cliente_id=$1
          AND a.inicio >= NOW() - INTERVAL '1 day'
          AND a.inicio <= NOW() + ($2 || ' days')::INTERVAL
        ORDER BY a.inicio ASC
        LIMIT 200`,
      [clienteId, dias]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/clientes/:id/agendamentos', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    await garantirEstruturaAgenda();
    const clienteId = parseInt(req.params.id, 10);
    const { lead_id, titulo, tipo, inicio, fim, status, observacao, coluna_id, mover_kanban, lembrete_min } = req.body || {};
    if (!titulo || !inicio) return res.status(400).json({ error: 'Título e data/horário são obrigatórios.' });
    const tipoNorm = String(tipo || 'atendimento').trim().toLowerCase();
    const lembreteNorm = [5, 15, 30, 60].includes(Number(lembrete_min)) ? Number(lembrete_min) : 0;
    const colunaDestino = await buscarColunaAgenda(clienteId, tipoNorm, coluna_id || null);
    if (await conflitoAgenda(clienteId, inicio, colunaDestino, null)) {
      return res.status(409).json({ error: 'Já existe um agendamento neste horário nesta coluna. Escolha outro horário ou outra coluna.' });
    }
    const ins = await query(
      `INSERT INTO movatak_agendamentos (cliente_id, lead_id, titulo, tipo, status, inicio, fim, observacao, funil_coluna_id, lembrete_min)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [clienteId, lead_id || null, titulo, tipoNorm, status || 'agendado', inicio, fim || null, observacao || null, colunaDestino, lembreteNorm]
    );
    if (lead_id && colunaDestino && mover_kanban !== false) {
      await moverLeadParaColunaFunil(lead_id, colunaDestino, true).catch(e => console.error('[agenda][mover-kanban]', e.message));
      await registrarEventoLead(lead_id, clienteId, 'agendamento_criado', 'Agendamento criado e lead movido no kanban', { agendamento_id: ins.rows[0].id, tipo: tipoNorm, inicio, coluna_id: colunaDestino }).catch(() => null);
    }
    res.json({ ok: true, agendamento: ins.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/admin/agendamentos/:id', ...exigeAgendamento, async (req, res) => {
  try {
    await garantirEstruturaAgenda();
    const { status, observacao, inicio, fim, funil_coluna_id } = req.body || {};
    const r = await query(
      `UPDATE movatak_agendamentos SET
         status = COALESCE($1, status),
         observacao = CASE WHEN $2::text IS NULL THEN observacao ELSE $2 END,
         inicio = COALESCE($3::timestamptz, inicio),
         fim = COALESCE($4::timestamptz, fim),
         funil_coluna_id = COALESCE($5, funil_coluna_id),
         atualizado_em = NOW()
       WHERE id=$6 RETURNING *`,
      [status || null, observacao !== undefined ? observacao : null, inicio || null, fim || null, funil_coluna_id || null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Agendamento não encontrado.' });
    res.json({ ok: true, agendamento: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/admin/agendamentos/:id/status', ...exigeAgendamento, async (req, res) => {
  try {
    await garantirEstruturaAgenda();
    const { status, mover_para_coluna_id } = req.body || {};
    if (!status) return res.status(400).json({ error: 'Informe o status.' });
    const r = await query(
      `UPDATE movatak_agendamentos SET status=$1, atualizado_em=NOW() WHERE id=$2 RETURNING *`,
      [status, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Agendamento não encontrado.' });
    const ag = r.rows[0];
    let leadMovido = false;
    // Se foi pedido pra mover o lead, valida que a coluna é do mesmo cliente e ativa.
    if (mover_para_coluna_id && ag.lead_id) {
      const col = await query(
        'SELECT id FROM movatak_funil_colunas WHERE id=$1 AND cliente_id=$2 AND ativo=true',
        [mover_para_coluna_id, ag.cliente_id]
      );
      if (col.rows.length) {
        await moverLeadParaColunaFunil(ag.lead_id, mover_para_coluna_id).catch(() => null);
        await registrarEventoLead(ag.lead_id, ag.cliente_id, 'agenda_status', `Agendamento "${ag.titulo || ''}" → ${status}`, { agendamento_id: ag.id, status }).catch(() => null);
        leadMovido = true;
      }
    }
    res.json({ ok: true, agendamento: ag, lead_movido: leadMovido });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/movatak/admin/agendamentos/:id', ...exigeAgendamento, async (req, res) => {
  try {
    await garantirEstruturaAgenda();
    const r = await query(
      `DELETE FROM movatak_agendamentos WHERE id=$1 RETURNING id, lead_id, cliente_id, titulo`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Agendamento não encontrado.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/clientes/:id/funil/colunas', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const clienteId = parseInt(req.params.id, 10);
    await garantirFunilPadraoCliente(clienteId);
    const nome = String((req.body && req.body.nome) || '').trim();
    if (!nome) return res.status(400).json({ error: 'Informe o nome da etapa.' });
    const slugBase = slugifyFunil(nome);
    const ordemR = await query('SELECT COALESCE(MAX(ordem),0)+1 AS ordem FROM movatak_funil_colunas WHERE cliente_id=$1', [clienteId]);
    const etapa = etapaSistemaPorSlug(slugBase);
    const ins = await query(
      `INSERT INTO movatak_funil_colunas (cliente_id, nome, slug, ordem, etapa_sistema, sincronizar_whatsapp)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [clienteId, nome, slugBase, ordemR.rows[0].ordem, etapa, req.body?.sincronizar_whatsapp !== false]
    );
    let col = ins.rows[0];
    if (col.sincronizar_whatsapp) {
      try {
        await sincronizarColunaComWhatsapp(col.id);
        const rr = await query('SELECT * FROM movatak_funil_colunas WHERE id=$1', [col.id]);
        col = rr.rows[0] || col;
      } catch (e) {
        await query(`UPDATE movatak_funil_colunas SET zapi_sync_erro=$1 WHERE id=$2`, [String(e.message || e).slice(0, 500), col.id]).catch(() => null);
        col.zapi_sync_erro = e.message;
      }
    }
    res.json({ ok: true, coluna: col });
  } catch (e) {
    if (String(e.message || '').includes('duplicate')) return res.status(409).json({ error: 'Já existe uma etapa/lista com esse nome.' });
    res.status(500).json({ error: e.message });
  }
});

app.patch('/movatak/admin/funil/colunas/:id', ...exigeColuna, async (req, res) => {
  try {
    await garantirEstruturaFunil();
    const { nome, ordem, ativo, cor, comando } = req.body || {};
    const r = await query(
      `UPDATE movatak_funil_colunas
          SET nome = COALESCE($1, nome),
              ordem = COALESCE($2, ordem),
              ativo = COALESCE($3, ativo),
              cor = CASE WHEN $5::text IS NULL THEN cor ELSE $5 END,
              comando = CASE WHEN $6::text IS NULL THEN comando ELSE NULLIF($6, '') END,
              atualizado_em = NOW()
        WHERE id = $4
        RETURNING *`,
      [nome || null, Number.isFinite(Number(ordem)) ? Number(ordem) : null, typeof ativo === 'boolean' ? ativo : null, req.params.id, cor !== undefined ? (cor || null) : null, comando !== undefined ? String(comando).trim() : null]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Coluna não encontrada.' });
    res.json({ ok: true, coluna: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/admin/funil/colunas/:id/setor', ...exigeColuna, async (req, res) => {
  try {
    const setorId = req.body && req.body.setor_id ? parseInt(req.body.setor_id, 10) : null;
    const r = await query(
      `UPDATE movatak_funil_colunas SET setor_id = $1, atualizado_em = NOW() WHERE id = $2 RETURNING *`,
      [setorId, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Coluna não encontrada.' });
    res.json({ ok: true, coluna: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/admin/funil/colunas/:id/ausencia', ...exigeColuna, async (req, res) => {
  try {
    const ativa = !!(req.body && req.body.ausencia_ativa);
    const r = await query(
      `UPDATE movatak_funil_colunas SET ausencia_ativa = $1, atualizado_em = NOW() WHERE id = $2 RETURNING *`,
      [ativa, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Coluna não encontrada.' });
    res.json({ ok: true, coluna: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/admin/funil/colunas/:id/ia', ...exigeColuna, async (req, res) => {
  try {
    const ativa = !!(req.body && req.body.ia_ativa);
    const r = await query(
      `UPDATE movatak_funil_colunas SET ia_ativa = $1, atualizado_em = NOW() WHERE id = $2 RETURNING *`,
      [ativa, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Coluna não encontrada.' });
    res.json({ ok: true, coluna: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// [prospeccao] Marca (ou desmarca) uma coluna como "gatilho de transferencia":
// leads que entram nela sao transferidos para o cliente destino. NULL = desligado.
app.patch('/movatak/admin/funil/colunas/:id/transferir', ...exigeColuna, async (req, res) => {
  try {
    const raw = req.body ? req.body.transfere_para_cliente_id : null;
    const destino = (raw === '' || raw == null) ? null : Number(raw);
    if (destino != null && !Number.isFinite(destino)) return res.status(400).json({ error: 'Cliente destino inválido.' });
    if (destino != null) {
      const c = await query('SELECT id FROM movatak_clientes WHERE id=$1', [destino]);
      if (!c.rows.length) return res.status(400).json({ error: 'Cliente destino não existe.' });
    }
    const r = await query(
      `UPDATE movatak_funil_colunas SET transfere_para_cliente_id = $1, atualizado_em = NOW() WHERE id = $2 RETURNING *`,
      [destino, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Coluna não encontrada.' });
    res.json({ ok: true, coluna: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/movatak/admin/funil/colunas/:id', ...exigeColuna, async (req, res) => {
  try {
    await garantirEstruturaFunil();
    // Colunas de vendedor são virtuais no front (ex: "vendedor_12") — nunca chegam
    // como ID numérico real. Se vier algo não-numérico, rejeita explicitamente.
    const idRaw = String(req.params.id || '');
    if (idRaw.startsWith('vendedor_') || idRaw.startsWith('vendedor-')) {
      return res.status(400).json({ error: 'Colunas de vendedor não podem ser excluídas pelo kanban. Remova ou desative o vendedor no menu de vendedores.' });
    }
    const colId = parseInt(idRaw, 10);
    if (!Number.isFinite(colId)) return res.status(400).json({ error: 'ID inválido.' });

    // Confirmação e destino são obrigatórios (regra do briefing).
    const { confirmar, destino_coluna_id } = req.body || {};
    if (!confirmar) return res.status(400).json({ error: 'Confirmação obrigatória para excluir a coluna.' });
    if (!destino_coluna_id) return res.status(400).json({ error: 'Escolha uma coluna de destino para realocar os leads.' });

    const cr = await query('SELECT id, cliente_id, nome FROM movatak_funil_colunas WHERE id=$1 AND ativo=true', [colId]);
    if (!cr.rows.length) return res.status(404).json({ error: 'Coluna não encontrada.' });
    const col = cr.rows[0];

    // O destino precisa ser uma coluna ativa do MESMO cliente e diferente da que será excluída.
    const destId = parseInt(destino_coluna_id, 10);
    if (destId === colId) return res.status(400).json({ error: 'A coluna de destino não pode ser a mesma que está sendo excluída.' });
    const dest = await query('SELECT id FROM movatak_funil_colunas WHERE id=$1 AND cliente_id=$2 AND ativo=true', [destId, col.cliente_id]);
    if (!dest.rows.length) return res.status(400).json({ error: 'Coluna de destino inválida.' });

    // Conta e realoca os leads desta coluna para o destino, registrando o evento.
    const leadsR = await query('SELECT id FROM movatak_leads WHERE funil_coluna_id=$1', [colId]);
    const qtdLeads = leadsR.rows.length;
    if (qtdLeads) {
      await query(
        `UPDATE movatak_leads SET funil_coluna_id=$1, atualizado_em=NOW() WHERE funil_coluna_id=$2`,
        [destId, colId]
      );
      for (const l of leadsR.rows) {
        registrarEventoLead(l.id, col.cliente_id, 'coluna_excluida', `Lead realocado: coluna "${col.nome}" excluída`, { de: colId, para: destId }).catch(() => null);
      }
    }

    // Soft delete — nunca apaga a linha.
    await query('UPDATE movatak_funil_colunas SET ativo=false, atualizado_em=NOW() WHERE id=$1', [colId]);
    res.json({ ok: true, leads_realocados: qtdLeads, destino_coluna_id: destId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/clientes/:id/funil/colunas/reordenar', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    await garantirEstruturaFunil();
    const clienteId = parseInt(req.params.id, 10);
    const ordem = Array.isArray(req.body?.ordem) ? req.body.ordem : null;
    if (!ordem || !ordem.length) return res.status(400).json({ error: 'Envie ordem: [ids...] na sequência desejada.' });
    let pos = 1;
    for (const colId of ordem) {
      const id = parseInt(colId, 10);
      if (!Number.isFinite(id)) continue;
      await query(
        `UPDATE movatak_funil_colunas SET ordem=$1, atualizado_em=NOW() WHERE id=$2 AND cliente_id=$3`,
        [pos, id, clienteId]
      ).catch(() => null);
      pos++;
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/funil/colunas/:id/sincronizar-whatsapp', ...exigeColuna, async (req, res) => {
  try {
    const tagId = await sincronizarColunaComWhatsapp(req.params.id);
    res.json({ ok: true, zapi_tag_id: tagId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/admin/leads/:id/vendedor', ...exigeLead, async (req, res) => {
  try {
    const { vendedor_id } = req.body || {};
    await query(
      `UPDATE movatak_leads SET vendedor_id=$1, atualizado_em=NOW() WHERE id=$2`,
      [vendedor_id || null, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/leads/:id/mensagem-kanban', ...exigeLead, async (req, res) => {
  try {
    const leadId = parseInt(req.params.id, 10);
    const mensagem = String((req.body && req.body.mensagem) || '').trim();
    if (!leadId) return res.status(400).json({ error: 'Lead inválido.' });
    if (!mensagem) return res.status(400).json({ error: 'Digite a mensagem.' });
    if (mensagem.length > 2000) return res.status(400).json({ error: 'Mensagem muito longa. Limite: 2000 caracteres.' });

    const r = await query(
      `SELECT l.id, l.cliente_id, l.nome, l.telefone, l.vendedor_id,
              c.zapi_instance, c.zapi_token, c.zapi_client_token
         FROM movatak_leads l
         JOIN movatak_clientes c ON c.id = l.cliente_id
        WHERE l.id = $1 AND c.ativo = true`,
      [leadId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    const lead = r.rows[0];
    if (!lead.telefone) return res.status(400).json({ error: 'Lead sem telefone cadastrado.' });
    if (!lead.zapi_instance || !lead.zapi_token || !lead.zapi_client_token) {
      return res.status(400).json({ error: 'Z-API não configurada para este cliente.' });
    }

    await zapiEnviar(lead.zapi_instance, lead.zapi_token, lead.zapi_client_token, lead.telefone, mensagem);
    await registrarEventoLead(
      lead.id,
      lead.cliente_id,
      'mensagem_manual_kanban',
      'Mensagem manual enviada pelo Funil de Atendimento',
      { origem: 'funil_kanban', vendedor_id: lead.vendedor_id || null, tamanho: mensagem.length }
    );
    await limparPedidoAtendente(lead.id);
    res.json({ ok: true });
  } catch (e) {
    console.error('[funil][mensagem-kanban]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.patch('/movatak/admin/leads/:id/funil', ...exigeLead, async (req, res) => {
  try {
    const colunaId = parseInt(req.body?.coluna_id, 10);
    if (!colunaId) return res.status(400).json({ error: 'Informe a coluna de destino.' });
    const result = await moverLeadParaColunaFunil(req.params.id, colunaId, true);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/reset-lead', authMovatakOuApp, async (req, res) => {
  try {
    const tel = String((req.body && req.body.telefone) || '').replace(/\D/g, '');
    if (tel.length < 8) return res.status(400).json({ error: 'Telefone inválido.' });

    // Tolerância ao 9º dígito do celular (com/sem o 9).
    const variantes = variantesTelefone(tel);

    // Atualização @lid do WhatsApp: contatos podem estar salvos pelo LID (id anônimo),
    // não pelo número. Resolve o(s) LID(s) associados a esse número pelo histórico de
    // webhooks (o payload traz o número real E o chatLid juntos) para achar o lead
    // mesmo quando o operador digita o número real de teste, e não o LID.
    const lidRows = await query(
      `SELECT DISTINCT payload->>'chatLid' AS lid FROM movatak_webhook_eventos
        WHERE regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g') = ANY($1)
          AND payload->>'chatLid' ILIKE '%@lid%'`,
      [variantes]
    ).catch(() => ({ rows: [] }));
    const lids = lidRows.rows.map(r => r.lid).filter(Boolean);

    // Segurança: o cliente só pode resetar leads da PRÓPRIA operação.
    // Para admin, opera em todos. Para cliente, restringe ao cliente_id do token.
    // Casa por: telefone (dígitos, variantes) OU chat_lid (dígitos, variantes) OU
    // chat_lid exato (LIDs resolvidos pelo histórico do número digitado).
    const params = [variantes, lids];
    const filtroCliente = req.ehCliente ? ' AND cliente_id = $3' : '';
    if (req.ehCliente) params.push(req.clienteId);

    const sel = `SELECT id FROM movatak_leads
       WHERE (
         regexp_replace(COALESCE(telefone,''), '[^0-9]', '', 'g') = ANY($1)
         OR regexp_replace(COALESCE(chat_lid,''), '[^0-9]', '', 'g') = ANY($1)
         OR ( array_length($2::text[], 1) IS NOT NULL AND chat_lid = ANY($2) )
       )${filtroCliente}`;
    const found = await query(sel, params);
    const removidos = found.rows.length;
    if (removidos) {
      // Apaga dependências dos leads encontrados (já restritos ao cliente, se for o caso).
      const ids = found.rows.map(r => r.id);
      const phIds = ids.map((_, i) => '$' + (i + 1)).join(',');
      await query(`DELETE FROM movatak_followup WHERE lead_id IN (${phIds})`, ids).catch(() => null);
      await query(`DELETE FROM movatak_mensagens WHERE lead_id IN (${phIds})`, ids).catch(() => null);
      // Histórico de conversas (tabela atual) — antes ficava órfão ao resetar, deixando
      // mensagens presas no banco apontando para um lead que já não existe.
      await query(`DELETE FROM movatak_conversas WHERE lead_id IN (${phIds})`, ids).catch(() => null);
      await query(`DELETE FROM movatak_lead_eventos WHERE lead_id IN (${phIds})`, ids).catch(() => null);
      await query(`DELETE FROM movatak_etiqueta_log WHERE lead_id IN (${phIds})`, ids).catch(() => null);
      await query(`DELETE FROM movatak_questionario_estado WHERE lead_id IN (${phIds})`, ids).catch(() => null);
      await query(`DELETE FROM movatak_menu_estado WHERE lead_id IN (${phIds})`, ids).catch(() => null);
      await query(`DELETE FROM movatak_leads WHERE id IN (${phIds})`, ids);
    }
    res.json({ ok: true, removidos });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/captacao/buscar', authMovatakOuApp, async (req, res) => {
  if (req.ehCliente) return res.status(403).json({ error: 'Recurso restrito ao admin.' });
  try {
    await garantirEstruturaCaptacao();
    const { nicho, cidade } = req.body;
    if (!nicho || !String(nicho).trim() || !cidade || !String(cidade).trim()) {
      return res.status(400).json({ error: 'Informe nicho e cidade.' });
    }
    const nichoT = String(nicho).trim();
    const cidadeT = String(cidade).trim();
    const { itens: encontrados, textSearchCalls, placeDetailsCalls, variantes } = await buscarGooglePlaces(nichoT, cidadeT);
    let novos = 0, semTelefone = 0, existentes = 0;
    const novosIds = [];
    for (const item of encontrados) {
      if (!item.telefone) { semTelefone++; continue; }
      const r = await query(
        `INSERT INTO movatak_leads_captacao (nome, telefone, endereco, categoria, cidade, nicho_busca, place_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (place_id) WHERE place_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [item.nome, item.telefone, item.endereco, item.categoria, cidadeT, nichoT, item.place_id]
      ).catch((e) => { console.error('[captacao] erro ao inserir lead:', e.message); return { rows: [] }; });
      if (r.rows.length) { novos++; novosIds.push(r.rows[0].id); } else existentes++;
    }
    await query(
      `INSERT INTO movatak_captacao_uso (mes, buscas, text_search, place_details, atualizado_em)
       VALUES ($1, 1, $2, $3, NOW())
       ON CONFLICT (mes) DO UPDATE SET
         buscas = movatak_captacao_uso.buscas + 1,
         text_search = movatak_captacao_uso.text_search + EXCLUDED.text_search,
         place_details = movatak_captacao_uso.place_details + EXCLUDED.place_details,
         atualizado_em = NOW()`,
      [mesAtualStr(), textSearchCalls, placeDetailsCalls]
    ).catch((e) => console.error('[captacao] erro ao registrar uso:', e.message));

    // [prospeccao] Verificação automática de WhatsApp: assim que novos leads são
    // capturados, checa cada número em segundo plano (não segura a resposta). Deixa a
    // coluna tem_whatsapp pronta sem o operador clicar em nada — o botão manual vira
    // fallback p/ os que ficarem indefinidos. Só roda se a instância de captação
    // estiver configurada no Railway; senão fica NULL e a verificação segue opcional.
    const autoVerificar = !!(process.env.ZAPI_CAPTACAO_INSTANCE && process.env.ZAPI_CAPTACAO_TOKEN) && novosIds.length > 0;
    res.json({ ok: true, encontrados: encontrados.length, novos, existentes, semTelefone, verificandoWhats: autoVerificar, variantes: Array.isArray(variantes) ? variantes : undefined });

    if (autoVerificar) {
      (async () => {
        for (const id of novosIds) {
          try {
            const lr = await query('SELECT telefone FROM movatak_leads_captacao WHERE id=$1 AND tem_whatsapp IS NULL', [id]);
            if (!lr.rows.length) continue; // já verificado ou removido
            const existe = await zapiPhoneExiste(lr.rows[0].telefone);
            if (existe === true || existe === false) {
              await query('UPDATE movatak_leads_captacao SET tem_whatsapp=$1 WHERE id=$2', [existe, id]).catch(() => null);
            } // null: não marca, permite re-tentar pelo botão manual
          } catch (e) { /* não interrompe os demais */ }
          await new Promise(r => setTimeout(r, 400)); // throttle leve p/ não estourar a Z-API
        }
      })().catch(e => console.error('[captacao] auto-verificar whatsapp:', e.message));
    }
  } catch (e) { res.status(500).json({ error: e.response?.data?.error_message || e.message }); }
});

app.get('/movatak/admin/captacao/uso', authMovatakOuApp, async (req, res) => {
  if (req.ehCliente) return res.status(403).json({ error: 'Recurso restrito ao admin.' });
  try {
    await garantirEstruturaCaptacao();
    const mes = mesAtualStr();
    const r = await query('SELECT buscas, text_search, place_details FROM movatak_captacao_uso WHERE mes=$1', [mes]);
    const u = r.rows[0] || { buscas: 0, text_search: 0, place_details: 0 };
    const detalhesRestante = Math.max(0, CAPTACAO_COTA_PLACE_DETAILS - u.place_details);
    const textRestante = Math.max(0, CAPTACAO_COTA_TEXT_SEARCH - u.text_search);
    // O Place Details (telefone) é o gargalo; ~20 por busca.
    const buscasRestantesEstim = Math.floor(detalhesRestante / 20);
    res.json({
      ok: true,
      mes,
      buscas: u.buscas,
      textSearch: u.text_search,
      placeDetails: u.place_details,
      cotaTextSearch: CAPTACAO_COTA_TEXT_SEARCH,
      cotaPlaceDetails: CAPTACAO_COTA_PLACE_DETAILS,
      textSearchRestante: textRestante,
      placeDetailsRestante: detalhesRestante,
      buscasRestantesEstim
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// [captacao] Painel/funil da captacao. READ-ONLY: so agrega e conta, nao dispara
// nada. Marcos de sistema (etapa_sistema) tornam a metrica robusta entre clientes:
// interessados=negociacao, link de pagamento=com_link_de_pagamento, cliente=cliente.
app.get('/movatak/admin/captacao/funil', authMovatakOuApp, async (req, res) => {
  if (req.ehCliente) return res.status(403).json({ error: 'Recurso restrito ao admin.' });
  try {
    await garantirEstruturaCaptacao();
    const nicho = req.query.nicho ? String(req.query.nicho) : null;
    const cidade = req.query.cidade ? String(req.query.cidade) : null;
    const capCte = `
      WITH cap AS (
        SELECT lc.id, lc.tem_whatsapp, lc.promovido, lc.lead_id, lc.nicho_busca, lc.cidade,
               fc.etapa_sistema,
               EXISTS(SELECT 1 FROM movatak_conversas cv WHERE cv.lead_id=lc.lead_id AND cv.direcao='saida')   AS teve_saida,
               EXISTS(SELECT 1 FROM movatak_conversas cv WHERE cv.lead_id=lc.lead_id AND cv.direcao='entrada') AS teve_entrada
          FROM movatak_leads_captacao lc
          LEFT JOIN movatak_leads l ON l.id = lc.lead_id
          LEFT JOIN movatak_funil_colunas fc ON fc.id = l.funil_coluna_id
         WHERE ($1::text IS NULL OR lc.nicho_busca ILIKE '%'||$1||'%')
           AND ($2::text IS NULL OR lc.cidade ILIKE '%'||$2||'%')
      )`;
    const f = await query(`${capCte}
      SELECT
        count(*) AS capturados,
        count(*) FILTER (WHERE tem_whatsapp IS TRUE)  AS com_whatsapp,
        count(*) FILTER (WHERE tem_whatsapp IS NULL)  AS whatsapp_indefinido,
        count(*) FILTER (WHERE promovido)             AS promovidos,
        count(*) FILTER (WHERE teve_saida)            AS contatados,
        count(*) FILTER (WHERE teve_entrada)          AS responderam,
        count(*) FILTER (WHERE etapa_sistema='negociacao')            AS interessados,
        count(*) FILTER (WHERE etapa_sistema='com_link_de_pagamento') AS link_pagamento,
        count(*) FILTER (WHERE etapa_sistema='cliente')               AS clientes,
        count(*) FILTER (WHERE etapa_sistema='descartado')            AS descartados
      FROM cap`, [nicho, cidade]);
    const porNicho = await query(`${capCte}
      SELECT nicho_busca, cidade, count(*) AS capturados,
             count(*) FILTER (WHERE promovido) AS promovidos,
             count(*) FILTER (WHERE etapa_sistema='cliente') AS clientes
        FROM cap GROUP BY nicho_busca, cidade ORDER BY capturados DESC LIMIT 20`, [nicho, cidade]);
    const u = await query('SELECT text_search, place_details FROM movatak_captacao_uso WHERE mes=$1', [mesAtualStr()]);
    const uso = u.rows[0] || { text_search: 0, place_details: 0 };
    res.json({
      ok: true,
      funil: f.rows[0],
      porNicho: porNicho.rows,
      uso: { ...uso, cotaTextSearch: CAPTACAO_COTA_TEXT_SEARCH, cotaPlaceDetails: CAPTACAO_COTA_PLACE_DETAILS }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// [prospeccao] Dispara a prospecção com IA para uma seleção de leads capturados.
// GATED: só roda por acionamento explícito do admin, valida config/credenciais e
// respeita o TETO DIÁRIO. Promove cada lead pro funil do cliente de prospecção
// (coluna de entrada com IA), envia a 1ª mensagem pelo número certo (modo
// dedicada/principal) e registra o envio. O throttle roda em background (não segura
// a resposta). A IA assume quando o prospect responder (webhook -> iaResponderAutomatico).
app.post('/movatak/admin/captacao/prospectar', authMovatak, async (req, res) => {
  try {
    await garantirEstruturaCaptacao();
    await garantirEstruturaFunil();
    const { clienteId, ids } = req.body || {};
    if (!clienteId || !Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'Informe clienteId e ids[].' });
    const cr = await query(
      `SELECT id, nome, zapi_instance, zapi_token, zapi_client_token,
              prospeccao_modo, prospeccao_zapi_instance, prospeccao_zapi_token, prospeccao_zapi_client_token,
              prospeccao_msg_abordagem, prospeccao_throttle_seg, prospeccao_teto_dia, prospeccao_coluna_entrada_id
         FROM movatak_clientes WHERE id=$1`, [clienteId]);
    if (!cr.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const cli = cr.rows[0];
    const msg = (cli.prospeccao_msg_abordagem || '').trim();
    if (!msg) return res.status(400).json({ error: 'Configure a mensagem de abordagem antes de prospectar.' });
    if (!cli.prospeccao_coluna_entrada_id) return res.status(400).json({ error: 'Configure a coluna de entrada (onde a IA assume).' });
    const modo = cli.prospeccao_modo === 'principal' ? 'principal' : 'dedicada';
    const inst = modo === 'principal' ? cli.zapi_instance : cli.prospeccao_zapi_instance;
    const tok = modo === 'principal' ? cli.zapi_token : cli.prospeccao_zapi_token;
    const ct = modo === 'principal' ? cli.zapi_client_token : cli.prospeccao_zapi_client_token;
    if (!inst || !tok) return res.status(400).json({ error: 'Credenciais Z-API do número de prospecção ausentes (modo: ' + modo + ').' });
    const teto = cli.prospeccao_teto_dia || 20;
    const usados = await query(`SELECT count(*)::int AS n FROM movatak_prospeccao_envios WHERE cliente_id=$1 AND status='enviado' AND criado_em >= date_trunc('day', NOW())`, [clienteId]);
    const disponivel = Math.max(0, teto - (usados.rows[0].n || 0));
    if (disponivel <= 0) return res.status(400).json({ error: 'Teto diário de prospecção já atingido para este cliente (' + teto + ').' });
    // Pula números sabidamente SEM WhatsApp (tem_whatsapp = false): disparar pra eles
    // é envio desperdiçado e ainda soma risco de ban. Mantém os TRUE e os NULL (ainda
    // não verificados) — a auto-verificação da captação normalmente já resolveu isso.
    const capR = await query(`SELECT id, nome, telefone FROM movatak_leads_captacao WHERE id = ANY($1::int[]) AND telefone IS NOT NULL AND telefone <> '' AND promovido = false AND tem_whatsapp IS NOT FALSE`, [ids]);
    const semWhatsR = await query(`SELECT count(*)::int AS n FROM movatak_leads_captacao WHERE id = ANY($1::int[]) AND tem_whatsapp = false`, [ids]);
    const semWhats = semWhatsR.rows[0].n || 0;
    const alvos = capR.rows.slice(0, disponivel);
    if (!alvos.length) return res.status(400).json({ error: 'Nenhum lead válido para prospectar na seleção (com telefone, não promovido e com WhatsApp).' });
    const throttleMs = Math.max(10, cli.prospeccao_throttle_seg || 45) * 1000;

    res.json({ ok: true, enfileirados: alvos.length, disponivel, teto, modo, puladosSemWhats: semWhats });

    // Envio em background com throttle. Volume pequeno (<= teto). Erros por lead
    // sao registrados e nao interrompem os demais.
    (async () => {
      for (const alvo of alvos) {
        try {
          let leadId;
          const dup = await query(`SELECT id FROM movatak_leads WHERE cliente_id=$1 AND telefone=$2 LIMIT 1`, [clienteId, alvo.telefone]);
          if (dup.rows.length) leadId = dup.rows[0].id;
          else {
            const insL = await query(
              `INSERT INTO movatak_leads (cliente_id, nome, telefone, etapa, origem, nao_lida, criado_em, atualizado_em)
               VALUES ($1,$2,$3,'lead','prospeccao_captacao',false,NOW(),NOW()) RETURNING id`,
              [clienteId, alvo.nome || alvo.telefone, alvo.telefone]);
            leadId = insL.rows[0].id;
          }
          await moverLeadParaColunaFunil(leadId, cli.prospeccao_coluna_entrada_id, false).catch(() => null);
          const texto = msg.replace(/\{nome\}/g, String(alvo.nome || '').split(' ')[0] || '');
          await zapiEnviar(inst, tok, ct || '', alvo.telefone, texto);
          await registrarConversa(leadId, clienteId, 'saida', texto, null, null, null, null, 'prospeccao').catch(() => null);
          await query(`UPDATE movatak_leads_captacao SET promovido=true, promovido_em=NOW(), lead_id=$1 WHERE id=$2`, [leadId, alvo.id]).catch(() => null);
          await query(`INSERT INTO movatak_prospeccao_envios (cliente_id, lead_id, captacao_id, telefone, status) VALUES ($1,$2,$3,$4,'enviado')`, [clienteId, leadId, alvo.id, alvo.telefone]).catch(() => null);
        } catch (e) {
          await query(`INSERT INTO movatak_prospeccao_envios (cliente_id, captacao_id, telefone, status, erro) VALUES ($1,$2,$3,'erro',$4)`, [clienteId, alvo.id, alvo.telefone, String(e.message || e).slice(0, 300)]).catch(() => null);
        }
        await new Promise(r => setTimeout(r, throttleMs));
      }
    })().catch(e => console.error('[prospeccao] loop de disparo:', e.message));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// [prospeccao] Salva a config de número de prospecção de UM cliente (a UI vive na
// Central de Captação). Write dedicado — só admin. Tokens só sobrescrevem se vierem.
app.patch('/movatak/admin/clientes/:id/prospeccao', authMovatak, async (req, res) => {
  try {
    await garantirEstruturaCaptacao();
    const { prospeccao_modo, prospeccao_zapi_instance, prospeccao_zapi_token, prospeccao_zapi_client_token,
            prospeccao_msg_abordagem, prospeccao_throttle_seg, prospeccao_teto_dia, prospeccao_coluna_entrada_id } = req.body || {};
    const modo = ['dedicada', 'principal'].includes(prospeccao_modo) ? prospeccao_modo : 'dedicada';
    const campos = ['prospeccao_modo = $1'];
    const valores = [modo];
    let idx = 2;
    if (prospeccao_zapi_instance !== undefined) { campos.push('prospeccao_zapi_instance = $' + idx); valores.push(prospeccao_zapi_instance ? String(prospeccao_zapi_instance).trim() : null); idx++; }
    if (prospeccao_zapi_token && String(prospeccao_zapi_token).trim()) { campos.push('prospeccao_zapi_token = $' + idx); valores.push(String(prospeccao_zapi_token).trim()); idx++; }
    if (prospeccao_zapi_client_token && String(prospeccao_zapi_client_token).trim()) { campos.push('prospeccao_zapi_client_token = $' + idx); valores.push(String(prospeccao_zapi_client_token).trim()); idx++; }
    if (prospeccao_msg_abordagem !== undefined) { campos.push('prospeccao_msg_abordagem = $' + idx); valores.push(prospeccao_msg_abordagem ? String(prospeccao_msg_abordagem) : null); idx++; }
    if (prospeccao_throttle_seg !== undefined) { const n = parseInt(prospeccao_throttle_seg, 10); campos.push('prospeccao_throttle_seg = $' + idx); valores.push(Number.isFinite(n) ? Math.max(10, Math.min(600, n)) : 45); idx++; }
    if (prospeccao_teto_dia !== undefined) { const n = parseInt(prospeccao_teto_dia, 10); campos.push('prospeccao_teto_dia = $' + idx); valores.push(Number.isFinite(n) ? Math.max(1, Math.min(500, n)) : 20); idx++; }
    if (prospeccao_coluna_entrada_id !== undefined) { campos.push('prospeccao_coluna_entrada_id = $' + idx); valores.push(prospeccao_coluna_entrada_id ? parseInt(prospeccao_coluna_entrada_id, 10) : null); idx++; }
    valores.push(req.params.id);
    const r = await query(`UPDATE movatak_clientes SET ${campos.join(', ')} WHERE id = $${idx} RETURNING id`, valores);
    if (!r.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/admin/captacao/leads', authMovatakOuApp, async (req, res) => {
  if (req.ehCliente) return res.status(403).json({ error: 'Recurso restrito ao admin.' });
  try {
    await garantirEstruturaCaptacao();
    const { cidade, nicho, promovido, whatsapp } = req.query;
    const cond = [];
    const params = [];
    if (cidade) { params.push('%' + cidade + '%'); cond.push(`cidade ILIKE $${params.length}`); }
    if (nicho) { params.push('%' + nicho + '%'); cond.push(`nicho_busca ILIKE $${params.length}`); }
    if (promovido === '0') cond.push(`promovido = false`);
    if (promovido === '1') cond.push(`promovido = true`);
    if (whatsapp === '1') cond.push(`tem_whatsapp = true`);
    if (whatsapp === '0') cond.push(`tem_whatsapp = false`);
    if (whatsapp === 'null') cond.push(`tem_whatsapp IS NULL`);
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const r = await query(`SELECT * FROM movatak_leads_captacao ${where} ORDER BY criado_em DESC LIMIT 500`, params);
    res.json({ ok: true, leads: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/movatak/admin/captacao/leads', authMovatakOuApp, async (req, res) => {
  if (req.ehCliente) return res.status(403).json({ error: 'Recurso restrito ao admin.' });
  try {
    await garantirEstruturaCaptacao();
    const r = await query('DELETE FROM movatak_leads_captacao WHERE promovido = false', []);
    res.json({ ok: true, removidos: r.rowCount || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/admin/captacao/colunas/:clienteId', authMovatakOuApp, async (req, res) => {
  if (req.ehCliente) return res.status(403).json({ error: 'Recurso restrito ao admin.' });
  try {
    const r = await query('SELECT id, nome FROM movatak_funil_colunas WHERE cliente_id=$1 AND ativo=true ORDER BY ordem ASC', [req.params.clienteId]);
    res.json({ ok: true, colunas: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/captacao/verificar-whatsapp', authMovatakOuApp, async (req, res) => {
  if (req.ehCliente) return res.status(403).json({ error: 'Recurso restrito ao admin.' });
  try {
    await garantirEstruturaCaptacao();
    if (!process.env.ZAPI_CAPTACAO_INSTANCE || !process.env.ZAPI_CAPTACAO_TOKEN) {
      return res.status(400).json({ error: 'Instância Z-API de captação não configurada no Railway.' });
    }
    const { cidade, nicho } = req.body || {};
    const cond = ['tem_whatsapp IS NULL'];
    const params = [];
    if (cidade) { params.push('%' + cidade + '%'); cond.push(`cidade ILIKE $${params.length}`); }
    if (nicho) { params.push('%' + nicho + '%'); cond.push(`nicho_busca ILIKE $${params.length}`); }
    const r = await query(
      `SELECT id, telefone FROM movatak_leads_captacao WHERE ${cond.join(' AND ')} ORDER BY criado_em DESC LIMIT 100`,
      params
    );
    let comWhats = 0, semWhats = 0, indefinido = 0;
    for (const lead of r.rows) {
      const existe = await zapiPhoneExiste(lead.telefone);
      if (existe === true) comWhats++;
      else if (existe === false) semWhats++;
      else { indefinido++; continue; } // null: não marca, permite tentar de novo depois
      await query('UPDATE movatak_leads_captacao SET tem_whatsapp=$1 WHERE id=$2', [existe, lead.id]).catch(() => null);
    }
    res.json({ ok: true, verificados: r.rows.length, comWhats, semWhats, indefinido });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/captacao/promover', authMovatakOuApp, async (req, res) => {
  if (req.ehCliente) return res.status(403).json({ error: 'Recurso restrito ao admin.' });
  try {
    await garantirEstruturaCaptacao();
    await garantirEstruturaFunil();
    const { ids, clienteId, colunaId } = req.body;
    if (!Array.isArray(ids) || !ids.length || !clienteId) {
      return res.status(400).json({ error: 'Informe ids[] e clienteId.' });
    }
    let promovidos = 0, duplicados = 0;
    for (const id of ids) {
      const c = await query('SELECT * FROM movatak_leads_captacao WHERE id=$1 AND promovido=false', [id]);
      if (!c.rows.length) continue;
      const cap = c.rows[0];
      const existe = await query('SELECT id FROM movatak_leads WHERE cliente_id=$1 AND telefone=$2 LIMIT 1', [clienteId, cap.telefone]);
      let leadId;
      if (existe.rows.length) {
        leadId = existe.rows[0].id;
        duplicados++;
      } else {
        const ins = await query(
          `INSERT INTO movatak_leads (cliente_id, nome, telefone, etapa, origem, nao_lida, criado_em, atualizado_em)
           VALUES ($1,$2,$3,'lead','captacao_google_places',false,NOW(),NOW()) RETURNING id`,
          [clienteId, cap.nome || cap.telefone, cap.telefone]
        );
        leadId = ins.rows[0].id;
        promovidos++;
      }
      if (colunaId) {
        await moverLeadParaColunaFunil(leadId, colunaId, false).catch(() => null);
      }
      await query('UPDATE movatak_leads_captacao SET promovido=true, promovido_em=NOW(), lead_id=$1 WHERE id=$2', [leadId, id]);
    }
    res.json({ ok: true, promovidos, duplicados });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/admin/uso-mensagens', authMovatakOuApp, async (req, res) => {
  try {
    const taxa = Number(req.query.taxa);
    const taxaCobravel = (Number.isFinite(taxa) && taxa >= 0) ? taxa : 0.12;
    // Primeiro dia do mês corrente (UTC), alinhado ao ciclo de cobrança.
    const agora = new Date();
    const inicioMes = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), 1, 0, 0, 0));

    const filtroCliente = req.ehCliente ? 'AND cliente_id = $2' : '';
    const params = req.ehCliente ? [inicioMes.toISOString(), req.clienteId] : [inicioMes.toISOString()];

    const tot = await query(
      `SELECT
         COUNT(*) FILTER (WHERE direcao='saida')   AS enviadas,
         COUNT(*) FILTER (WHERE direcao='entrada')  AS recebidas
       FROM movatak_conversas
       WHERE criado_em >= $1 ${filtroCliente}`,
      params
    );
    const enviadas = Number(tot.rows[0].enviadas || 0);
    const recebidas = Number(tot.rows[0].recebidas || 0);

    // Estimativa de custo: só mensagens ENVIADAS são cobráveis (as recebidas nunca custam).
    // É uma estimativa — o custo real do Meta depende da categoria e da janela de 24h,
    // que o CRM não classifica hoje. A taxa é configurável para refletir a média do gestor.
    const custoEstimado = Number((enviadas * taxaCobravel).toFixed(2));

    const resposta = {
      ok: true,
      mes: inicioMes.toISOString().slice(0, 7),
      taxa: taxaCobravel,
      enviadas, recebidas,
      total: enviadas + recebidas,
      custo_estimado: custoEstimado,
      ehCliente: !!req.ehCliente
    };

    // Admin: quebra por cliente.
    if (!req.ehCliente) {
      const porCliente = await query(
        `SELECT c.id, c.nome,
                COUNT(*) FILTER (WHERE cv.direcao='saida')  AS enviadas,
                COUNT(*) FILTER (WHERE cv.direcao='entrada') AS recebidas
           FROM movatak_conversas cv
           JOIN movatak_clientes c ON c.id = cv.cliente_id
          WHERE cv.criado_em >= $1
          GROUP BY c.id, c.nome
          ORDER BY enviadas DESC`,
        [inicioMes.toISOString()]
      );
      resposta.por_cliente = porCliente.rows.map(r => ({
        id: r.id, nome: r.nome,
        enviadas: Number(r.enviadas || 0),
        recebidas: Number(r.recebidas || 0),
        custo_estimado: Number((Number(r.enviadas || 0) * taxaCobravel).toFixed(2))
      }));
    }
    res.json(resposta);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
}

module.exports = { register };
