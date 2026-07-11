'use strict';

// ============================================================
// src/routes/vendedor.js — Fase 5b da refatoracao.
//
// As 47 rotas /movatak/vendedor/* foram movidas VERBATIM do index.js para
// dentro de register(app, deps). Nenhuma logica foi reescrita: os corpos dos
// handlers sao byte-a-byte identicos aos originais. Todas as dependencias
// (authVendedor, os vendedorPode*, helpers ainda no index.js e funcoes de
// modulos ja extraidos) chegam pelo objeto deps e sao desestruturadas abaixo,
// de modo que os call sites dentro dos handlers permanecem exatamente como eram.
// ============================================================

function register(app, deps) {
  const {
    ZAPI_ADVANCED_ENDPOINTS, agendarFollowupV2, authVendedor, axios, buscarColunaAgenda,
    conflitoAgenda, emitirMensagemApagada, emitirMensagemLead, enviarFollowupsPendentesDoLead, etapaSistemaPorSlug,
    garantirColunasVendedoresPortal, garantirEstruturaAgenda, garantirEstruturaFunil, garantirEstruturaMensagensRapidas, garantirEstruturaQuestionario,
    hashSenha, iniciarQuestionarioPorTemplate, limparPayloadAvancado, limparPedidoAtendente, marcarChatLidoNoZap,
    montarPayloadRespostaZapi, moverLeadParaColunaFunil, query, registrarConversa, registrarEventoLead,
    resolverReplyInfoLead, sincronizarColunaComWhatsapp, slugFunilPorEtapa, slugifyFunil, tipoMidia,
    uploadSupabase, vendedorPodeAgendamento, vendedorPodeColuna, vendedorPodeConversa, vendedorPodeLead,
    vendedorPodeSetor, zapiApagarMensagem, zapiEditarTexto, zapiEncaminharMensagem, zapiEnviar,
    zapiEnviarAudio, zapiEnviarContato, zapiEnviarDocumento, zapiEnviarImagem, zapiEnviarLink,
    zapiEnviarLocalizacao, zapiEnviarVideo, zapiHeaders, zapiLerMensagem, zapiModificarChat,
    zapiPost, zapiReagirMensagem,
  } = deps;
app.post('/movatak/vendedor/login', async (req, res) => {
  try {
    await garantirColunasVendedoresPortal();
    const { email, senha } = req.body || {};
    if (!email || !senha) return res.status(400).json({ error: 'Informe email e senha.' });
    const r = await query(
      `SELECT v.id, v.cliente_id, v.nome, v.email_acesso, v.acesso_token, c.nome AS cliente_nome
         FROM movatak_vendedores v
         JOIN movatak_clientes c ON c.id = v.cliente_id
        WHERE LOWER(v.email_acesso) = LOWER($1) AND v.senha_hash = $2 AND v.ativo = true AND c.ativo = true
        LIMIT 1`,
      [String(email).trim().toLowerCase(), hashSenha(senha)]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'Acesso inválido.' });
    const vend = r.rows[0];
    // Setores que este vendedor acessa — definem o que ele vê no kanban.
    const setoresR = await query(
      `SELECT s.id, s.nome, s.cor FROM movatak_setor_vendedores sv
         JOIN movatak_setores s ON s.id = sv.setor_id AND COALESCE(s.ativo, true) = true
        WHERE sv.vendedor_id = $1 ORDER BY s.ordem_bot NULLS LAST, s.nome`,
      [vend.id]
    ).catch(() => ({ rows: [] }));
    res.json({
      token: vend.acesso_token,
      vendedor: { id: vend.id, cliente_id: vend.cliente_id, nome: vend.nome, cliente_nome: vend.cliente_nome, setores: setoresR.rows }
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/vendedor/resumo', authVendedor, async (req, res) => {
  try {
    const dias = [0, 7, 30, 90].includes(parseInt(req.query.dias)) ? parseInt(req.query.dias) : 30;
    const leadPeriodoSQL = dias === 0 ? "DATE(l.criado_em) = CURRENT_DATE" : `l.criado_em >= NOW() - INTERVAL '${dias} days'`;
    const vendaPeriodoSQL = dias === 0 ? "DATE(COALESCE(l.convertido_em, l.atualizado_em)) = CURRENT_DATE" : `COALESCE(l.convertido_em, l.atualizado_em) >= NOW() - INTERVAL '${dias} days'`;
    const m = await query(
      `SELECT COUNT(l.id) FILTER (WHERE ${leadPeriodoSQL})::int AS leads_atribuidos,
              COUNT(l.id) FILTER (WHERE l.etapa = 'cliente' AND ${vendaPeriodoSQL})::int AS vendas,
              COUNT(l.id) FILTER (WHERE l.etapa = 'followup')::int AS em_followup,
              COUNT(l.id) FILTER (WHERE DATE(l.criado_em) = CURRENT_DATE)::int AS leads_hoje,
              COUNT(l.id) FILTER (WHERE l.etapa = 'cliente' AND DATE(COALESCE(l.convertido_em, l.atualizado_em)) = CURRENT_DATE)::int AS vendas_hoje
         FROM movatak_leads l
        WHERE l.vendedor_id = $1`,
      [req.vendedor.id]
    );
    const ranking = await query(
      `SELECT v.nome,
              COUNT(l.id) FILTER (WHERE l.etapa = 'cliente')::int AS vendas
         FROM movatak_vendedores v
         LEFT JOIN movatak_leads l ON l.vendedor_id = v.id AND l.criado_em >= NOW() - INTERVAL '30 days'
        WHERE v.cliente_id = $1 AND COALESCE(v.ativo, true) = true
        GROUP BY v.id, v.nome
        ORDER BY vendas DESC`,
      [req.vendedor.cliente_id]
    );
    const eventos = await query(
      `SELECT l.id, l.nome, l.telefone, l.etapa, l.criado_em, l.atualizado_em
         FROM movatak_leads l
        WHERE l.vendedor_id = $1
        ORDER BY l.atualizado_em DESC NULLS LAST, l.criado_em DESC
        LIMIT 30`,
      [req.vendedor.id]
    );
    const row = m.rows[0] || {};
    const total = parseInt(row.leads_atribuidos || 0);
    const vendas = parseInt(row.vendas || 0);
    res.json({ vendedor: req.vendedor, periodo_dias: dias, ...row, taxa_conversao: total ? ((vendas/total)*100).toFixed(1) : '0.0', ranking: ranking.rows, leads: eventos.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/vendedor/funil', authVendedor, async (req, res) => {
  try {
    const clienteId = req.vendedor.cliente_id;
    const setorIds = req.vendedor.setorIds || [];
    if (!setorIds.length) {
      return res.json({
        colunas: [],
        colunasVendedores: [],
        leads: [],
        setores: [],
        totalGeral: 0,
        totalNaoLidas: 0,
        semSetor: true
      });
    }

    // Correção definitiva de carregamento do CRM do vendedor:
    // esta rota NÃO executa DDL/template em GET e NÃO busca a última mensagem
    // com LATERAL por lead. Assim a tela não fica presa em "Carregando funil..."
    // quando a tabela de conversas está grande ou o banco está com lock de migração.

    let setoresAlvo = setorIds;
    let setorFiltro = null;
    if (req.query.setor) {
      const pedido = parseInt(req.query.setor, 10);
      if (!setorIds.includes(pedido)) return res.status(403).json({ error: 'Sem acesso a este setor.' });
      setoresAlvo = [pedido];
      setorFiltro = pedido;
    }

    const ph = setoresAlvo.map((_, i) => '$' + (i + 2)).join(',');
    const params = [clienteId, ...setoresAlvo];

    const colunasRes = await query(
      `SELECT id, nome, slug, ordem, cor, etapa_sistema, sincronizar_whatsapp,
              zapi_tag_id, zapi_sync_erro, comando, setor_id, ausencia_ativa, ia_ativa,
              nicho_template, agenda_tipo, agenda_status
         FROM movatak_funil_colunas
        WHERE cliente_id=$1 AND ativo=true AND setor_id IN (${ph})
        ORDER BY ordem ASC, id ASC`,
      params
    );

    const colunas = colunasRes.rows.map(c => ({ ...c, leads: [] }));
    const colById = new Map(colunas.map(c => [Number(c.id), c]));
    const colBySlug = new Map(colunas.map(c => [c.slug, c]));

    const leadsRes = await query(
      `SELECT lb.*, ult.direcao AS ultima_msg_direcao, ult.criado_em AS ultima_msg_em, ult.midia_tipo AS ultima_msg_midia
         FROM (
           SELECT l.id, l.nome, l.telefone, l.etapa, l.funil_coluna_id, l.vendedor_id, l.setor_id,
              COALESCE(l.nao_lida,false) AS nao_lida,
              COALESCE(l.arquivado,false) AS arquivado,
              COALESCE(l.pediu_atendente,false) AS pediu_atendente, l.pediu_atendente_em,
              s.nome AS setor_nome, s.cor AS setor_cor,
              l.criado_em, l.atualizado_em, l.convertido_em, l.prioridade_dispensada_em,
              v.nome AS vendedor_nome,
              p.nome AS plano_nome, p.valor AS plano_valor,
              NULL::text AS ultima_msg,
              0::int AS followups_pendentes,
              NULL::int AS fu_sequencia_ativa
         FROM movatak_leads l
         LEFT JOIN movatak_vendedores v ON v.id = l.vendedor_id
         LEFT JOIN movatak_planos p ON p.id = l.plano_id
         LEFT JOIN movatak_setores s ON s.id = l.setor_id
        WHERE l.cliente_id=$1 AND l.setor_id IN (${ph})
        ORDER BY l.atualizado_em DESC NULLS LAST, l.criado_em DESC
        LIMIT 500
         ) lb
         LEFT JOIN LATERAL (
           SELECT direcao, criado_em, midia_tipo FROM movatak_conversas c
            WHERE c.lead_id = lb.id ORDER BY c.criado_em DESC LIMIT 1
         ) ult ON true`,
      params
    );

    const leadsAtivos = leadsRes.rows.filter(l => !l.arquivado);
    for (const lead of leadsAtivos) {
      let coluna = lead.funil_coluna_id ? colById.get(Number(lead.funil_coluna_id)) : null;
      if (!coluna) coluna = colBySlug.get(slugFunilPorEtapa(lead.etapa));
      if (!coluna) coluna = colunas.find(c => Number(c.setor_id) === Number(lead.setor_id));
      if (!coluna) coluna = colunas[0];
      if (coluna) coluna.leads.push(lead);
    }

    const phTodos = setorIds.map((_, i) => '$' + (i + 2)).join(',');
    const paramsTodos = [clienteId, ...setorIds];

    const clienteInfoRes = await query(
      'SELECT nicho, agenda_ativa FROM movatak_clientes WHERE id=$1',
      [clienteId]
    ).catch(() => ({ rows: [] }));
    const clienteInfo = clienteInfoRes.rows[0] || {};

    const setoresRes = await query(
      `SELECT id, nome, cor FROM movatak_setores
        WHERE cliente_id=$1 AND COALESCE(ativo,true)=true AND id IN (${phTodos})
        ORDER BY ordem_bot ASC, nome ASC`,
      paramsTodos
    );

    const contagemSetoresRes = await query(
      `SELECT setor_id,
              COUNT(*)::int AS cnt,
              COUNT(*) FILTER (WHERE COALESCE(nao_lida,false) = true)::int AS nao_lidas
         FROM movatak_leads
        WHERE cliente_id=$1 AND COALESCE(arquivado,false)=false AND setor_id IN (${phTodos})
        GROUP BY setor_id`,
      paramsTodos
    );

    const contagemPorSetor = new Map(contagemSetoresRes.rows.map(r => [Number(r.setor_id), Number(r.cnt || 0)]));
    const naoLidasPorSetor = new Map(contagemSetoresRes.rows.map(r => [Number(r.setor_id), Number(r.nao_lidas || 0)]));
    const setores = setoresRes.rows.map(s => ({
      ...s,
      leads_count: contagemPorSetor.get(Number(s.id)) || 0,
      nao_lidas: naoLidasPorSetor.get(Number(s.id)) || 0
    }));

    const totalGeral = contagemSetoresRes.rows.reduce((acc, r) => acc + Number(r.cnt || 0), 0);
    const totalNaoLidas = contagemSetoresRes.rows.reduce((acc, r) => acc + Number(r.nao_lidas || 0), 0);

    res.json({
      colunas,
      colunasVendedores: [],
      setores,
      setorAtivo: setorFiltro,
      totalGeral,
      totalNaoLidas,
      nicho: clienteInfo.nicho || null,
      agenda_ativa: !!clienteInfo.agenda_ativa,
      leads: leadsRes.rows
    });
  } catch (e) {
    console.error('[vendedor/funil]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/movatak/vendedor/funil/metricas', authVendedor, async (req, res) => {
  try {
    const clienteId = req.vendedor.cliente_id;
    const setorIds = req.vendedor.setorIds || [];
    if (!setorIds.length) return res.json({ totalLeads: 0, novasMensagens: 0, emNegociacao: 0, conversaoMes: 0 });
    let setoresAlvo = setorIds;
    if (req.query.setor) {
      const pedido = parseInt(req.query.setor, 10);
      if (!setorIds.includes(pedido)) return res.status(403).json({ error: 'Sem acesso a este setor.' });
      setoresAlvo = [pedido];
    }
    const ph = setoresAlvo.map((_, i) => '$' + (i + 2)).join(',');
    const params = [clienteId, ...setoresAlvo];
    const totaisR = await query(
      `SELECT COUNT(*)::int AS total_leads,
              COUNT(*) FILTER (WHERE l.nao_lida = true)::int AS novas_mensagens,
              COUNT(*) FILTER (WHERE l.criado_em >= date_trunc('month', now()))::int AS criados_mes,
              COUNT(*) FILTER (WHERE l.convertido_em >= date_trunc('month', now()))::int AS convertidos_mes
         FROM movatak_leads l
        WHERE l.cliente_id=$1 AND COALESCE(l.arquivado,false)=false AND l.setor_id IN (${ph})`,
      params
    );
    const negociacaoR = await query(
      `SELECT COUNT(*)::int AS n
         FROM movatak_leads l
         LEFT JOIN movatak_funil_colunas c ON c.id = l.funil_coluna_id
        WHERE l.cliente_id=$1 AND COALESCE(l.arquivado,false)=false AND l.setor_id IN (${ph})
          AND COALESCE(c.etapa_sistema, l.etapa) = 'negociacao'`,
      params
    );
    const t = totaisR.rows[0] || {};
    const conversaoMes = t.criados_mes > 0 ? Math.round((t.convertidos_mes / t.criados_mes) * 100) : 0;
    res.json({ totalLeads: t.total_leads || 0, novasMensagens: t.novas_mensagens || 0, emNegociacao: (negociacaoR.rows[0] || {}).n || 0, conversaoMes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/vendedor/leads/:id/conversas', authVendedor, async (req, res) => {
  try {
    const lead = await vendedorPodeLead(req, req.params.id);
    if (!lead) return res.status(403).json({ error: 'Sem acesso a este lead.' });
    const r = await query(
      `SELECT * FROM (
         SELECT id, direcao, conteudo, midia_url, midia_tipo, msg_id,
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

app.post('/movatak/vendedor/leads/:id/mensagem', authVendedor, async (req, res) => {
  try {
    const lead = await vendedorPodeLead(req, req.params.id);
    if (!lead) return res.status(403).json({ error: 'Sem acesso a este lead.' });
    const { texto, mensagem, midia_url, midia_tipo, reply_to_conversa_id, reply_to_msg_id } = req.body || {};
    const conteudo = String(texto ?? mensagem ?? '').trim();
    if (!conteudo && !midia_url) return res.status(400).json({ error: 'Texto ou mídia obrigatório.' });
    const cli = await query('SELECT zapi_instance, zapi_token, zapi_client_token FROM movatak_clientes WHERE id=$1', [lead.cliente_id]);
    const c = cli.rows[0] || {};
    if (!c.zapi_instance || !c.zapi_token || !c.zapi_client_token) return res.status(400).json({ error: 'Z-API não configurada para este cliente.' });
    const replyResolvido = await resolverReplyInfoLead(lead.id, reply_to_conversa_id, reply_to_msg_id, null);
    const replyMsgIdZap = replyResolvido.msgId || null;
    let tipoFinal = null, msgId = null;
    if (midia_url) {
      tipoFinal = tipoMidia(midia_url, midia_tipo);
      if (tipoFinal === 'video') msgId = await zapiEnviarVideo(c.zapi_instance, c.zapi_token, c.zapi_client_token, lead.telefone, midia_url, conteudo || '', replyMsgIdZap);
      else if (tipoFinal === 'audio') msgId = await zapiEnviarAudio(c.zapi_instance, c.zapi_token, c.zapi_client_token, lead.telefone, midia_url, replyMsgIdZap);
      else msgId = await zapiEnviarImagem(c.zapi_instance, c.zapi_token, c.zapi_client_token, lead.telefone, midia_url, conteudo || '', replyMsgIdZap);
    } else {
      msgId = await zapiEnviar(c.zapi_instance, c.zapi_token, c.zapi_client_token, lead.telefone, conteudo, replyMsgIdZap);
    }
    const conversaId = await registrarConversa(lead.id, lead.cliente_id, 'saida', conteudo || '', midia_url || null, tipoFinal, msgId, replyResolvido.info).catch(() => null);
    await registrarEventoLead(lead.id, lead.cliente_id, 'mensagem_vendedor', 'Mensagem enviada pelo vendedor ' + req.vendedor.nome, { texto: (conteudo || '').slice(0,100), midia: !!midia_url });
    emitirMensagemLead(lead.cliente_id, lead.id, { id: conversaId, lead_id: lead.id, cliente_id: lead.cliente_id, direcao: 'saida', conteudo: conteudo || '', midia_url: midia_url || null, midia_tipo: tipoFinal, msg_id: msgId, criado_em: new Date().toISOString() });
    res.json({ ok: true, conversaId, criado_em: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
});

app.post('/movatak/vendedor/leads/:id/mensagem-kanban', authVendedor, async (req, res, next) => {
  req.body = { ...(req.body || {}), texto: (req.body && (req.body.texto ?? req.body.mensagem)) || '' };
  next();
}, async (req, res) => {
  try {
    const lead = await vendedorPodeLead(req, req.params.id);
    if (!lead) return res.status(403).json({ error: 'Sem acesso a este lead.' });
    const { texto, midia_url } = req.body || {};
    if (!texto && !midia_url) return res.status(400).json({ error: 'Texto ou mídia obrigatório.' });
    const cli = await query('SELECT zapi_instance, zapi_token, zapi_client_token FROM movatak_clientes WHERE id=$1', [lead.cliente_id]);
    const c = cli.rows[0] || {};
    let tipoFinal = null, msgId = null;
    if (midia_url) {
      tipoFinal = tipoMidia(midia_url);
      if (tipoFinal === 'video') msgId = await zapiEnviarVideo(c.zapi_instance, c.zapi_token, c.zapi_client_token, lead.telefone, midia_url, texto || '');
      else if (tipoFinal === 'audio') msgId = await zapiEnviarAudio(c.zapi_instance, c.zapi_token, c.zapi_client_token, lead.telefone, midia_url);
      else msgId = await zapiEnviarImagem(c.zapi_instance, c.zapi_token, c.zapi_client_token, lead.telefone, midia_url, texto || '');
    } else {
      msgId = await zapiEnviar(c.zapi_instance, c.zapi_token, c.zapi_client_token, lead.telefone, texto);
    }
    const conversaId = await registrarConversa(lead.id, lead.cliente_id, 'saida', texto || '', midia_url || null, tipoFinal, msgId).catch(() => null);
    await registrarEventoLead(lead.id, lead.cliente_id, 'mensagem_manual_kanban', 'Mensagem enviada pelo vendedor no kanban', { vendedor_id: req.vendedor.id, texto: (texto||'').slice(0,100), midia: !!midia_url });
    await limparPedidoAtendente(lead.id);
    res.json({ ok: true, conversaId });
  } catch (e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
});

app.post('/movatak/vendedor/leads/:id/mensagem-rapida', authVendedor, async (req, res) => {
  try {
    const lead = await vendedorPodeLead(req, req.params.id);
    if (!lead) return res.status(403).json({ error: 'Sem acesso a este lead.' });
    const { texto, midia_url, midia_tipo, reply_to_conversa_id, reply_to_msg_id } = req.body || {};
    if (!texto && !midia_url) return res.status(400).json({ error: 'Texto ou mídia obrigatório.' });
    const cli = await query('SELECT zapi_instance, zapi_token, zapi_client_token FROM movatak_clientes WHERE id=$1', [lead.cliente_id]);
    const c = cli.rows[0] || {};
    const replyResolvido = await resolverReplyInfoLead(lead.id, reply_to_conversa_id, reply_to_msg_id, null);
    const replyMsgIdZap = replyResolvido.msgId || null;
    let tipoFinal = null, msgId = null;
    if (midia_url) {
      tipoFinal = tipoMidia(midia_url, midia_tipo);
      if (tipoFinal === 'video') msgId = await zapiEnviarVideo(c.zapi_instance, c.zapi_token, c.zapi_client_token, lead.telefone, midia_url, texto || '', replyMsgIdZap);
      else if (tipoFinal === 'audio') msgId = await zapiEnviarAudio(c.zapi_instance, c.zapi_token, c.zapi_client_token, lead.telefone, midia_url, replyMsgIdZap);
      else msgId = await zapiEnviarImagem(c.zapi_instance, c.zapi_token, c.zapi_client_token, lead.telefone, midia_url, texto || '', replyMsgIdZap);
    } else {
      msgId = await zapiEnviar(c.zapi_instance, c.zapi_token, c.zapi_client_token, lead.telefone, texto, replyMsgIdZap);
    }
    const conversaId = await registrarConversa(lead.id, lead.cliente_id, 'saida', texto || '', midia_url || null, tipoFinal, msgId, replyResolvido.info).catch(() => null);
    if (texto) query('UPDATE movatak_mensagens_rapidas SET vezes_usado = COALESCE(vezes_usado,0)+1 WHERE cliente_id=$1 AND texto=$2', [lead.cliente_id, texto]).catch(() => null);
    await registrarEventoLead(lead.id, lead.cliente_id, 'mensagem_rapida_vendedor', 'Mensagem rápida enviada pelo vendedor', { vendedor_id: req.vendedor.id, midia: !!midia_url });
    res.json({ ok: true, conversaId, criado_em: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
});

app.patch('/movatak/vendedor/leads/:id/coluna', authVendedor, async (req, res) => {
  try {
    const lead = await vendedorPodeLead(req, req.params.id);
    if (!lead) return res.status(403).json({ error: 'Sem acesso a este lead.' });
    const colunaId = parseInt(req.body && req.body.coluna_id, 10);
    if (!colunaId) return res.status(400).json({ error: 'coluna_id obrigatório.' });
    // A coluna destino precisa ser de um setor do vendedor.
    const col = await query('SELECT setor_id FROM movatak_funil_colunas WHERE id=$1 AND cliente_id=$2 AND ativo=true', [colunaId, lead.cliente_id]);
    if (!col.rows.length || !vendedorPodeSetor(req, col.rows[0].setor_id)) return res.status(403).json({ error: 'Coluna fora do seu acesso.' });
    await moverLeadParaColunaFunil(lead.id, colunaId).catch(() => null);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/vendedor/leads/:id/marcar-lida', authVendedor, async (req, res) => {
  try {
    const lead = await vendedorPodeLead(req, req.params.id);
    if (!lead) return res.status(403).json({ error: 'Sem acesso a este lead.' });
    const naoLida = !!(req.body && req.body.nao_lida);
    const upd = await query(`UPDATE movatak_leads SET nao_lida = $1 WHERE id = $2 AND nao_lida IS DISTINCT FROM $1 RETURNING id`, [naoLida, lead.id]);
    // Reflete no WhatsApp só quando REALMENTE mudou de não-lido -> lido.
    if (!naoLida && upd.rows.length) marcarChatLidoNoZap(lead.id);
    res.json({ ok: true, nao_lida: naoLida });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/vendedor/leads/:id/arquivar', authVendedor, async (req, res) => {
  try {
    const lead = await vendedorPodeLead(req, req.params.id);
    if (!lead) return res.status(403).json({ error: 'Sem acesso a este lead.' });
    const arquivado = req.body && typeof req.body.arquivado === 'boolean' ? req.body.arquivado : true;
    await query(`UPDATE movatak_leads SET arquivado=$1, atualizado_em=NOW() WHERE id=$2`, [arquivado, lead.id]);
    res.json({ ok: true, arquivado });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/vendedor/leads/:id/setor', authVendedor, async (req, res) => {
  try {
    const lead = await vendedorPodeLead(req, req.params.id);
    if (!lead) return res.status(403).json({ error: 'Sem acesso a este lead.' });
    const setorDestinoId = parseInt(req.body && req.body.setor_id, 10);
    if (!setorDestinoId || !vendedorPodeSetor(req, setorDestinoId)) return res.status(403).json({ error: 'Setor fora do seu acesso.' });
    const colunaR = await query(
      `SELECT id, nome FROM movatak_funil_colunas
        WHERE cliente_id=$1 AND setor_id=$2 AND ativo=true
        ORDER BY ordem ASC, id ASC LIMIT 1`,
      [lead.cliente_id, setorDestinoId]
    );
    const colunaDestino = colunaR.rows[0] || null;
    await query(`UPDATE movatak_leads SET setor_id=$1, funil_coluna_id=COALESCE($2, funil_coluna_id), atualizado_em=NOW() WHERE id=$3`, [setorDestinoId, colunaDestino ? colunaDestino.id : null, lead.id]);
    await registrarEventoLead(lead.id, lead.cliente_id, 'transferencia_setor_vendedor', 'Atendimento transferido pelo vendedor', { setor_destino_id: setorDestinoId, coluna_destino_id: colunaDestino ? colunaDestino.id : null, vendedor_id: req.vendedor.id }).catch(() => null);
    res.json({ ok: true, setor_id: setorDestinoId, coluna_destino: colunaDestino ? colunaDestino.nome : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/vendedor/leads/:id/historico', authVendedor, async (req, res) => {
  try {
    const acesso = await vendedorPodeLead(req, req.params.id);
    if (!acesso) return res.status(403).json({ error: 'Sem acesso a este lead.' });
    const lead = await query(
      `SELECT l.*, c.nome AS cliente_nome, v.nome AS vendedor_nome
         FROM movatak_leads l
         JOIN movatak_clientes c ON c.id = l.cliente_id
         LEFT JOIN movatak_vendedores v ON v.id = l.vendedor_id
        WHERE l.id = $1`,
      [acesso.id]
    );
    const eventos = await query(`SELECT id, tipo, descricao, dados, criado_em FROM movatak_lead_eventos WHERE lead_id=$1 ORDER BY criado_em DESC LIMIT 100`, [acesso.id]).catch(() => ({ rows: [] }));
    const fila = await query(
      `SELECT id, etapa_seq, COALESCE(sequencia_fu, 1) AS sequencia_fu, proximo_envio,
              status, data_entrada, enviado_em, tentativas_envio, erro_envio
         FROM movatak_followup
        WHERE lead_id = $1
        ORDER BY proximo_envio DESC
        LIMIT 100`,
      [acesso.id]
    ).catch(() => ({ rows: [] }));
    res.json({ lead: lead.rows[0], eventos: eventos.rows, fila: fila.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/movatak/vendedor/conversas/:id', authVendedor, async (req, res) => {
  try {
    const msg = await vendedorPodeConversa(req, req.params.id);
    if (!msg) return res.status(403).json({ error: 'Sem acesso a esta mensagem.' });
    let apagadaNoZap = false;
    let avisoZap = null;
    if (msg.direcao === 'saida' && msg.msg_id) {
      try { await zapiApagarMensagem(msg.zapi_instance, msg.zapi_token, msg.zapi_client_token, msg.telefone, msg.msg_id); apagadaNoZap = true; }
      catch (e) { avisoZap = e.response?.data?.error || e.response?.data?.message || e.message; }
    } else if (msg.direcao === 'entrada') {
      avisoZap = 'Mensagem recebida do lead — não é possível apagar do lado dele, só do seu painel.';
    }
    await query('DELETE FROM movatak_conversas WHERE id=$1', [msg.id]);
    emitirMensagemApagada(msg.cliente_id, msg.lead_id, Number(msg.id));
    res.json({ ok: true, apagadaNoZap, avisoZap });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/vendedor/conversas/:id/reagir', authVendedor, async (req, res) => {
  try {
    const { reaction } = req.body || {};
    if (!reaction) return res.status(400).json({ error: 'Informe o emoji da reação.' });
    const msg = await vendedorPodeConversa(req, req.params.id);
    if (!msg) return res.status(403).json({ error: 'Sem acesso a esta mensagem.' });
    if (!msg.msg_id) return res.status(400).json({ error: 'Mensagem sem messageId do WhatsApp.' });
    const data = await zapiReagirMensagem(msg.zapi_instance, msg.zapi_token, msg.zapi_client_token, msg.telefone, msg.msg_id, reaction);
    await registrarEventoLead(msg.lead_id, msg.cliente_id, 'whatsapp_reacao', 'Reação enviada pelo vendedor no CRM', { conversa_id: msg.id, reaction, vendedor_id: req.vendedor.id });
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
});

app.post('/movatak/vendedor/conversas/:id/encaminhar', authVendedor, async (req, res) => {
  try {
    const { destino } = req.body || {};
    if (!destino) return res.status(400).json({ error: 'Informe o destino.' });
    const msg = await vendedorPodeConversa(req, req.params.id);
    if (!msg) return res.status(403).json({ error: 'Sem acesso a esta mensagem.' });
    if (!msg.msg_id) return res.status(400).json({ error: 'Mensagem sem messageId do WhatsApp.' });
    const data = await zapiEncaminharMensagem(msg.zapi_instance, msg.zapi_token, msg.zapi_client_token, String(destino).replace(/\D/g, ''), msg.msg_id, msg.telefone);
    await registrarEventoLead(msg.lead_id, msg.cliente_id, 'whatsapp_encaminhamento', 'Mensagem encaminhada pelo vendedor no CRM', { conversa_id: msg.id, destino, vendedor_id: req.vendedor.id });
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
});

app.post('/movatak/vendedor/conversas/:id/marcar-lida-zap', authVendedor, async (req, res) => {
  try {
    const msg = await vendedorPodeConversa(req, req.params.id);
    if (!msg) return res.status(403).json({ error: 'Sem acesso a esta mensagem.' });
    if (!msg.msg_id) return res.status(400).json({ error: 'Mensagem sem messageId do WhatsApp.' });
    const data = await zapiLerMensagem(msg.zapi_instance, msg.zapi_token, msg.zapi_client_token, msg.telefone, msg.msg_id);
    await query(`UPDATE movatak_conversas SET msg_status='read', msg_status_em=NOW() WHERE id=$1`, [msg.id]).catch(() => null);
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
});

app.post('/movatak/vendedor/conversas/:id/editar', authVendedor, async (req, res) => {
  try {
    const { texto } = req.body || {};
    if (!String(texto || '').trim()) return res.status(400).json({ error: 'Informe o novo texto.' });
    const msg = await vendedorPodeConversa(req, req.params.id);
    if (!msg) return res.status(403).json({ error: 'Sem acesso a esta mensagem.' });
    if (msg.direcao !== 'saida') return res.status(400).json({ error: 'Só é possível editar mensagens enviadas.' });
    if (!msg.msg_id) return res.status(400).json({ error: 'Mensagem sem messageId do WhatsApp.' });
    const data = await zapiEditarTexto(msg.zapi_instance, msg.zapi_token, msg.zapi_client_token, msg.telefone, msg.msg_id, texto);
    await query(`UPDATE movatak_conversas SET conteudo=$1 WHERE id=$2`, [texto, msg.id]);
    await registrarEventoLead(msg.lead_id, msg.cliente_id, 'whatsapp_edicao', 'Mensagem editada pelo vendedor no CRM', { conversa_id: msg.id, vendedor_id: req.vendedor.id });
    emitirMensagemLead(msg.cliente_id, msg.lead_id, { ...msg, conteudo: texto, editada: true });
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
});

app.post('/movatak/vendedor/leads/:id/zapi/chat-action', authVendedor, async (req, res) => {
  try {
    const { action } = req.body || {};
    const allowed = ['read','unread','pin','unpin','mute','unmute','archive','unarchive'];
    if (!allowed.includes(action)) return res.status(400).json({ error: 'Ação inválida.' });
    const lead = await vendedorPodeLead(req, req.params.id);
    if (!lead) return res.status(403).json({ error: 'Sem acesso a este lead.' });
    const z = await query('SELECT zapi_instance, zapi_token, zapi_client_token FROM movatak_clientes WHERE id=$1', [lead.cliente_id]);
    const c = z.rows[0] || {};
    let data;
    if (action === 'archive' || action === 'unarchive') {
      const url = `${ZAPI_BASE}/${c.zapi_instance}/token/${c.zapi_token}/archive-chat`;
      const resp = await axios.post(url, { phone: lead.telefone, archive: action === 'archive' }, { headers: zapiHeaders(c.zapi_client_token) });
      data = resp.data || {};
      await query(`UPDATE movatak_leads SET arquivado=$1 WHERE id=$2`, [action === 'archive', lead.id]).catch(() => null);
    } else {
      data = await zapiModificarChat(c.zapi_instance, c.zapi_token, c.zapi_client_token, lead.telefone, action);
      if (action === 'read') await query(`UPDATE movatak_leads SET nao_lida=false WHERE id=$1`, [lead.id]).catch(() => null);
      if (action === 'unread') await query(`UPDATE movatak_leads SET nao_lida=true WHERE id=$1`, [lead.id]).catch(() => null);
    }
    await registrarEventoLead(lead.id, lead.cliente_id, 'whatsapp_chat_action', 'Ação de chat executada pelo vendedor', { action, vendedor_id: req.vendedor.id });
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
});

app.post('/movatak/vendedor/leads/:id/zapi/send-advanced', authVendedor, async (req, res) => {
  try {
    const lead = await vendedorPodeLead(req, req.params.id);
    if (!lead) return res.status(403).json({ error: 'Sem acesso a este lead.' });
    const { recurso, payload, reply_to_conversa_id, reply_to_msg_id } = req.body || {};
    if (!recurso || !ZAPI_ADVANCED_ENDPOINTS[recurso]) return res.status(400).json({ error: 'Recurso inválido.' });
    const z = await query('SELECT zapi_instance, zapi_token, zapi_client_token FROM movatak_clientes WHERE id=$1', [lead.cliente_id]);
    const c = z.rows[0] || {};
    const p = limparPayloadAvancado(payload || {});
    const replyResolvido = await resolverReplyInfoLead(lead.id, reply_to_conversa_id, reply_to_msg_id, null);
    const replyMsgIdZap = replyResolvido.msgId || null;
    let msgId = null, conteudo = '', midiaUrl = null, midiaTipo = recurso;
    if (recurso === 'document') {
      msgId = await zapiEnviarDocumento(c.zapi_instance, c.zapi_token, c.zapi_client_token, lead.telefone, p.document || p.documentUrl || p.url, p.fileName || p.filename || 'arquivo.pdf', p.caption || p.message || '', p.extension || p.ext || 'pdf', replyMsgIdZap);
      conteudo = p.caption || p.message || 'Documento enviado';
      midiaUrl = p.document || p.documentUrl || p.url || null;
      midiaTipo = 'documento';
    } else if (recurso === 'link') {
      msgId = await zapiEnviarLink(c.zapi_instance, c.zapi_token, c.zapi_client_token, lead.telefone, p.linkUrl || p.url, p.message || '', p.title || '', p.image || '', replyMsgIdZap);
      conteudo = p.message || p.title || p.linkUrl || p.url || 'Link enviado';
    } else if (recurso === 'location') {
      msgId = await zapiEnviarLocalizacao(c.zapi_instance, c.zapi_token, c.zapi_client_token, lead.telefone, p.title || 'Localização', p.address || '', p.latitude, p.longitude, replyMsgIdZap);
      conteudo = p.title || p.address || 'Localização enviada';
    } else if (recurso === 'contact') {
      msgId = await zapiEnviarContato(c.zapi_instance, c.zapi_token, c.zapi_client_token, lead.telefone, p.contactName || p.name || 'Contato', p.contactPhone || p.phone, !!p.contactBusiness, replyMsgIdZap);
      conteudo = p.contactName || p.name || 'Contato enviado';
    } else {
      const payloadFinal = montarPayloadRespostaZapi({ phone: lead.telefone, ...p }, replyMsgIdZap);
      const data = await zapiPost(c.zapi_instance, c.zapi_token, c.zapi_client_token, ZAPI_ADVANCED_ENDPOINTS[recurso], payloadFinal);
      msgId = data.messageId || data.id || data.zaapId || null;
      conteudo = p.message || p.text || p.caption || p.title || ('Recurso enviado: ' + recurso);
      midiaUrl = p.image || p.video || p.gif || p.sticker || null;
    }
    const conversaId = await registrarConversa(lead.id, lead.cliente_id, 'saida', conteudo || '', midiaUrl || null, midiaTipo, msgId, replyResolvido.info).catch(() => null);
    await registrarEventoLead(lead.id, lead.cliente_id, 'whatsapp_recurso_avancado', 'Recurso avançado enviado pelo vendedor', { recurso, conversaId, vendedor_id: req.vendedor.id });
    res.json({ ok: true, conversaId, messageId: msgId, criado_em: new Date().toISOString() });
  } catch(e) { res.status(500).json({ error: e.response?.data?.message || JSON.stringify(e.response?.data || {}) || e.message }); }
});

app.get('/movatak/vendedor/mensagens-rapidas', authVendedor, async (req, res) => {
  try {
    await garantirEstruturaMensagensRapidas();
    const r = await query('SELECT id, titulo, texto, midia_url, vezes_usado, ordem, itens, template_id FROM movatak_mensagens_rapidas WHERE cliente_id=$1 ORDER BY vezes_usado DESC, ordem ASC, id ASC', [req.vendedor.cliente_id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/vendedor/mensagens-rapidas', authVendedor, async (req, res) => {
  try {
    await garantirEstruturaMensagensRapidas();
    const { titulo, texto, midia_url, itens, template_id } = req.body || {};
    const sequencia = Array.isArray(itens) ? itens.filter(it => it && (it.texto || it.midia_url)) : [];
    if (!titulo) return res.status(400).json({ error: 'Título obrigatório.' });
    if (!sequencia.length && !texto) return res.status(400).json({ error: 'Texto obrigatório.' });
    const textoFinal = sequencia.length ? (texto || sequencia.map(it => it.texto || '').filter(Boolean).join(' ')).trim().slice(0,500) || titulo.trim() : texto.trim();
    const r = await query('INSERT INTO movatak_mensagens_rapidas (cliente_id, titulo, texto, midia_url, itens, template_id) VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING id, titulo, texto, midia_url, ordem, itens, template_id', [req.vendedor.cliente_id, titulo.trim(), textoFinal, sequencia.length ? null : (midia_url || null), JSON.stringify(sequencia), template_id ? parseInt(template_id,10) : null]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/vendedor/mensagens-rapidas/:id', authVendedor, async (req, res) => {
  try {
    const { titulo, texto, midia_url, itens } = req.body || {};
    await query(`UPDATE movatak_mensagens_rapidas SET titulo=COALESCE($1,titulo), texto=COALESCE($2,texto), midia_url=CASE WHEN $3::text IS NULL THEN midia_url ELSE $3 END, itens=CASE WHEN $4::jsonb IS NULL THEN itens ELSE $4::jsonb END WHERE id=$5 AND cliente_id=$6`, [titulo || null, texto || null, midia_url !== undefined ? (midia_url || null) : null, Array.isArray(itens) ? JSON.stringify(itens) : null, req.params.id, req.vendedor.cliente_id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/movatak/vendedor/mensagens-rapidas/:id', authVendedor, async (req, res) => {
  try { await query('DELETE FROM movatak_mensagens_rapidas WHERE id=$1 AND cliente_id=$2', [req.params.id, req.vendedor.cliente_id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/vendedor/mensagens-rapidas/:id/usar', authVendedor, async (req, res) => {
  try { await query('UPDATE movatak_mensagens_rapidas SET vezes_usado=COALESCE(vezes_usado,0)+1 WHERE id=$1 AND cliente_id=$2', [req.params.id, req.vendedor.cliente_id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/vendedor/upload-imagem', authVendedor, async (req, res) => {
  try {
    const dataUrl = (req.body && req.body.dataUrl) || '';
    const m = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)(?:;[^;,]+)*;base64,(.+)$/i.exec(dataUrl);
    const TIPOS_PERMITIDOS = ['image/png','image/jpeg','image/jpg','image/webp','video/mp4','video/webm','video/quicktime','audio/webm','audio/ogg','audio/mpeg','audio/mp4','audio/wav','audio/x-m4a','audio/aac'];
    const contentType = m ? m[1].toLowerCase() : '';
    if (!m || !TIPOS_PERMITIDOS.includes(contentType)) return res.status(400).json({ error: 'Arquivo inválido. Envie imagem, vídeo ou áudio.' });
    const ehVideo = contentType.startsWith('video/');
    const ehAudio = contentType.startsWith('audio/');
    const tipo = ehVideo ? 'video' : (ehAudio ? 'audio' : 'imagem');
    const extMap = { 'image/png':'png','image/jpeg':'jpg','image/jpg':'jpg','image/webp':'webp','video/mp4':'mp4','video/webm':'webm','video/quicktime':'mov','audio/webm':'webm','audio/ogg':'ogg','audio/mpeg':'mp3','audio/mp4':'m4a','audio/wav':'wav','audio/x-m4a':'m4a','audio/aac':'aac' };
    const ext = extMap[contentType] || (ehVideo ? 'mp4' : (ehAudio ? 'webm' : 'jpg'));
    const buffer = Buffer.from(m[2], 'base64');
    const limite = ehVideo ? 20 * 1024 * 1024 : 8 * 1024 * 1024;
    if (buffer.length > limite) return res.status(413).json({ error: ehVideo ? 'Vídeo muito grande (máx 20MB).' : 'Arquivo muito grande (máx 8MB).' });
    const url = await uploadSupabase(buffer, contentType, ext);
    res.json({ ok: true, url, tipo });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/vendedor/agendamentos', authVendedor, async (req, res) => {
  try {
    await garantirEstruturaAgenda();
    const setorIds = req.vendedor.setorIds || [];
    if (!setorIds.length) return res.json([]);
    const dias = Math.max(1, Math.min(parseInt(req.query.dias || '30', 10), 120));
    const ph = setorIds.map((_, i) => '$' + (i + 3)).join(',');
    const r = await query(
      `SELECT a.*, l.nome AS lead_nome, l.telefone AS lead_telefone, c.nome AS coluna_nome
         FROM movatak_agendamentos a
         LEFT JOIN movatak_leads l ON l.id = a.lead_id
         LEFT JOIN movatak_funil_colunas c ON c.id = a.funil_coluna_id
        WHERE a.cliente_id=$1
          AND (a.lead_id IS NULL OR l.setor_id IN (${ph}))
          AND a.inicio >= NOW() - INTERVAL '1 day'
          AND a.inicio <= NOW() + ($2 || ' days')::INTERVAL
        ORDER BY a.inicio ASC LIMIT 200`,
      [req.vendedor.cliente_id, dias, ...setorIds]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/vendedor/agendamentos', authVendedor, async (req, res) => {
  try {
    await garantirEstruturaAgenda();
    const clienteId = req.vendedor.cliente_id;
    const { lead_id, titulo, tipo, inicio, fim, status, observacao, coluna_id, mover_kanban } = req.body || {};
    if (!titulo || !inicio) return res.status(400).json({ error: 'Título e data/horário são obrigatórios.' });
    if (lead_id) {
      const lead = await vendedorPodeLead(req, lead_id);
      if (!lead) return res.status(403).json({ error: 'Sem acesso a este lead.' });
    }
    let colunaDestino = null;
    if (coluna_id) {
      const col = await vendedorPodeColuna(req, coluna_id);
      if (!col) return res.status(403).json({ error: 'Coluna fora do seu acesso.' });
      colunaDestino = col.id;
    } else {
      const tipoNormTmp = String(tipo || 'atendimento').trim().toLowerCase();
      colunaDestino = await buscarColunaAgenda(clienteId, tipoNormTmp, null).catch(() => null);
      if (colunaDestino) {
        const col = await vendedorPodeColuna(req, colunaDestino);
        if (!col) colunaDestino = null;
      }
    }
    const tipoNorm = String(tipo || 'atendimento').trim().toLowerCase();
    if (await conflitoAgenda(clienteId, inicio, colunaDestino, null)) {
      return res.status(409).json({ error: 'Já existe um agendamento neste horário nesta coluna. Escolha outro horário ou outra coluna.' });
    }
    const ins = await query(`INSERT INTO movatak_agendamentos (cliente_id, lead_id, titulo, tipo, status, inicio, fim, observacao, funil_coluna_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [clienteId, lead_id || null, titulo, tipoNorm, status || 'agendado', inicio, fim || null, observacao || null, colunaDestino]);
    if (lead_id && colunaDestino && mover_kanban !== false) {
      await moverLeadParaColunaFunil(lead_id, colunaDestino, true).catch(() => null);
      await registrarEventoLead(lead_id, clienteId, 'agendamento_criado', 'Agendamento criado pelo vendedor e lead movido no kanban', { agendamento_id: ins.rows[0].id, tipo: tipoNorm, inicio, coluna_id: colunaDestino, vendedor_id: req.vendedor.id }).catch(() => null);
    }
    res.json({ ok: true, agendamento: ins.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/vendedor/agendamentos/:id/status', authVendedor, async (req, res) => {
  try {
    await garantirEstruturaAgenda();
    const { status, mover_para_coluna_id } = req.body || {};
    if (!status) return res.status(400).json({ error: 'Informe o status.' });
    const agPerm = await vendedorPodeAgendamento(req, req.params.id);
    if (!agPerm) return res.status(403).json({ error: 'Sem acesso a este agendamento.' });
    const r = await query(`UPDATE movatak_agendamentos SET status=$1, atualizado_em=NOW() WHERE id=$2 RETURNING *`, [status, req.params.id]);
    const ag = r.rows[0];
    let leadMovido = false;
    if (mover_para_coluna_id && ag.lead_id) {
      const col = await vendedorPodeColuna(req, mover_para_coluna_id);
      if (col) {
        await moverLeadParaColunaFunil(ag.lead_id, mover_para_coluna_id).catch(() => null);
        await registrarEventoLead(ag.lead_id, ag.cliente_id, 'agenda_status', `Agendamento "${ag.titulo || ''}" → ${status}`, { agendamento_id: ag.id, status, vendedor_id: req.vendedor.id }).catch(() => null);
        leadMovido = true;
      }
    }
    res.json({ ok: true, agendamento: ag, lead_movido: leadMovido });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/vendedor/agendamentos/:id', authVendedor, async (req, res) => {
  try {
    await garantirEstruturaAgenda();
    const agPerm = await vendedorPodeAgendamento(req, req.params.id);
    if (!agPerm) return res.status(403).json({ error: 'Sem acesso a este agendamento.' });
    const { status, observacao, inicio, fim, funil_coluna_id } = req.body || {};
    let colId = funil_coluna_id || null;
    if (colId) {
      const col = await vendedorPodeColuna(req, colId);
      if (!col) return res.status(403).json({ error: 'Coluna fora do seu acesso.' });
    }
    const r = await query(`UPDATE movatak_agendamentos SET status=COALESCE($1,status), observacao=CASE WHEN $2::text IS NULL THEN observacao ELSE $2 END, inicio=COALESCE($3::timestamptz,inicio), fim=COALESCE($4::timestamptz,fim), funil_coluna_id=COALESCE($5,funil_coluna_id), atualizado_em=NOW() WHERE id=$6 RETURNING *`, [status || null, observacao !== undefined ? observacao : null, inicio || null, fim || null, colId, req.params.id]);
    res.json({ ok: true, agendamento: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/movatak/vendedor/agendamentos/:id', authVendedor, async (req, res) => {
  try {
    await garantirEstruturaAgenda();
    const ag = await vendedorPodeAgendamento(req, req.params.id);
    if (!ag) return res.status(403).json({ error: 'Sem acesso a este agendamento.' });
    await query(`DELETE FROM movatak_agendamentos WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/vendedor/funil/colunas', authVendedor, async (req, res) => {
  try {
    // Não inicializa template em ação do vendedor; evita lock/DDL durante atendimento.
    const nome = String((req.body && req.body.nome) || '').trim();
    if (!nome) return res.status(400).json({ error: 'Informe o nome da etapa.' });
    const setorId = req.body && req.body.setor_id ? parseInt(req.body.setor_id, 10) : (req.vendedor.setorIds || [])[0];
    if (!setorId || !vendedorPodeSetor(req, setorId)) return res.status(403).json({ error: 'Setor fora do seu acesso.' });
    const slugBase = slugifyFunil(nome);
    const ordemR = await query('SELECT COALESCE(MAX(ordem),0)+1 AS ordem FROM movatak_funil_colunas WHERE cliente_id=$1', [req.vendedor.cliente_id]);
    const etapa = etapaSistemaPorSlug(slugBase);
    const ins = await query(`INSERT INTO movatak_funil_colunas (cliente_id, nome, slug, ordem, etapa_sistema, sincronizar_whatsapp, setor_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [req.vendedor.cliente_id, nome, slugBase, ordemR.rows[0].ordem, etapa, req.body?.sincronizar_whatsapp !== false, setorId]);
    res.json({ ok: true, coluna: ins.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/vendedor/funil/colunas/:id', authVendedor, async (req, res) => {
  try {
    await garantirEstruturaFunil();
    const col = await vendedorPodeColuna(req, req.params.id);
    if (!col) return res.status(403).json({ error: 'Coluna fora do seu acesso.' });
    const { nome, ordem, ativo, cor, comando } = req.body || {};
    const r = await query(`UPDATE movatak_funil_colunas SET nome=COALESCE($1,nome), ordem=COALESCE($2,ordem), ativo=COALESCE($3,ativo), cor=CASE WHEN $5::text IS NULL THEN cor ELSE $5 END, comando=CASE WHEN $6::text IS NULL THEN comando ELSE NULLIF($6,'') END, atualizado_em=NOW() WHERE id=$4 RETURNING *`, [nome || null, Number.isFinite(Number(ordem)) ? Number(ordem) : null, typeof ativo === 'boolean' ? ativo : null, col.id, cor !== undefined ? (cor || null) : null, comando !== undefined ? String(comando).trim() : null]);
    res.json({ ok: true, coluna: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/vendedor/funil/colunas/:id/setor', authVendedor, async (req, res) => {
  try {
    const col = await vendedorPodeColuna(req, req.params.id);
    if (!col) return res.status(403).json({ error: 'Coluna fora do seu acesso.' });
    const setorId = req.body && req.body.setor_id ? parseInt(req.body.setor_id, 10) : null;
    if (!setorId || !vendedorPodeSetor(req, setorId)) return res.status(403).json({ error: 'Setor fora do seu acesso.' });
    const r = await query('UPDATE movatak_funil_colunas SET setor_id=$1, atualizado_em=NOW() WHERE id=$2 RETURNING *', [setorId, col.id]);
    res.json({ ok: true, coluna: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/vendedor/funil/colunas/:id/ausencia', authVendedor, async (req, res) => {
  try {
    const col = await vendedorPodeColuna(req, req.params.id);
    if (!col) return res.status(403).json({ error: 'Coluna fora do seu acesso.' });
    const ativa = !!(req.body && req.body.ausencia_ativa);
    const r = await query('UPDATE movatak_funil_colunas SET ausencia_ativa=$1, atualizado_em=NOW() WHERE id=$2 RETURNING *', [ativa, col.id]);
    res.json({ ok: true, coluna: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/movatak/vendedor/funil/colunas/:id', authVendedor, async (req, res) => {
  try {
    const col = await vendedorPodeColuna(req, req.params.id);
    if (!col) return res.status(403).json({ error: 'Coluna fora do seu acesso.' });
    const { confirmar, destino_coluna_id } = req.body || {};
    if (!confirmar) return res.status(400).json({ error: 'Confirmação obrigatória para excluir a coluna.' });
    const dest = await vendedorPodeColuna(req, destino_coluna_id);
    if (!dest || Number(dest.id) === Number(col.id)) return res.status(400).json({ error: 'Coluna de destino inválida.' });
    const leadsR = await query('SELECT id FROM movatak_leads WHERE funil_coluna_id=$1 AND cliente_id=$2', [col.id, req.vendedor.cliente_id]);
    if (leadsR.rows.length) await query('UPDATE movatak_leads SET funil_coluna_id=$1, atualizado_em=NOW() WHERE funil_coluna_id=$2 AND cliente_id=$3', [dest.id, col.id, req.vendedor.cliente_id]);
    await query('UPDATE movatak_funil_colunas SET ativo=false, atualizado_em=NOW() WHERE id=$1', [col.id]);
    res.json({ ok: true, leads_realocados: leadsR.rows.length, destino_coluna_id: dest.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/vendedor/funil/colunas/reordenar', authVendedor, async (req, res) => {
  try {
    const ordem = Array.isArray(req.body?.ordem) ? req.body.ordem : null;
    if (!ordem || !ordem.length) return res.status(400).json({ error: 'Envie ordem: [ids...] na sequência desejada.' });
    let pos = 1;
    for (const colId of ordem) {
      const col = await vendedorPodeColuna(req, colId);
      if (!col) continue;
      await query('UPDATE movatak_funil_colunas SET ordem=$1, atualizado_em=NOW() WHERE id=$2', [pos, col.id]).catch(() => null);
      pos++;
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/vendedor/funil/colunas/:id/sincronizar-whatsapp', authVendedor, async (req, res) => {
  try {
    const col = await vendedorPodeColuna(req, req.params.id);
    if (!col) return res.status(403).json({ error: 'Coluna fora do seu acesso.' });
    const tagId = await sincronizarColunaComWhatsapp(col.id);
    res.json({ ok: true, zapi_tag_id: tagId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/vendedor/leads/:id/reativar-followup', authVendedor, async (req, res) => {
  try {
    const lead = await vendedorPodeLead(req, req.params.id);
    if (!lead) return res.status(403).json({ error: 'Sem acesso a este lead.' });
    await query(`UPDATE movatak_leads SET etapa='followup', atualizado_em=NOW() WHERE id=$1`, [lead.id]);
    await agendarFollowupV2(lead.id, lead.cliente_id, 1, true);
    await enviarFollowupsPendentesDoLead(lead.id, 1);
    await registrarEventoLead(lead.id, lead.cliente_id, 'followup_reativado', 'Follow-up reativado manualmente pelo vendedor', { vendedor_id: req.vendedor.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/vendedor/questionario-templates', authVendedor, async (req, res) => {
  try {
    await garantirEstruturaQuestionario();
    const r = await query(
      `SELECT id, nome, criado_em, atualizado_em,
              COALESCE(jsonb_array_length(passos), 0) AS qtd_passos
         FROM movatak_questionario_templates
        WHERE cliente_id = $1 AND ativo = true
        ORDER BY criado_em DESC`,
      [req.vendedor.cliente_id]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/vendedor/questionario-templates/:tid', authVendedor, async (req, res) => {
  try {
    await garantirEstruturaQuestionario();
    const r = await query(
      `SELECT * FROM movatak_questionario_templates WHERE id = $1 AND cliente_id = $2 AND ativo = true`,
      [req.params.tid, req.vendedor.cliente_id]
    );
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

app.patch('/movatak/vendedor/leads/:id/cliente', authVendedor, async (req, res) => {
  try {
    const lead = await vendedorPodeLead(req, req.params.id);
    if (!lead) return res.status(403).json({ error: 'Sem acesso a este lead.' });
    await query(`UPDATE movatak_leads SET etapa='cliente', convertido_em=NOW(), atualizado_em=NOW() WHERE id=$1`, [lead.id]);
    await query(`UPDATE movatak_followup SET status='pausado' WHERE lead_id=$1 AND status='pendente'`, [lead.id]);
    await registrarEventoLead(lead.id, lead.cliente_id, 'cliente_manual', 'Lead marcado como cliente pelo vendedor', { vendedor_id: req.vendedor.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/vendedor/leads/:id/descartar', authVendedor, async (req, res) => {
  try {
    const lead = await vendedorPodeLead(req, req.params.id);
    if (!lead) return res.status(403).json({ error: 'Sem acesso a este lead.' });
    await query(`UPDATE movatak_leads SET etapa='descartado', atualizado_em=NOW() WHERE id=$1`, [lead.id]);
    await query(`UPDATE movatak_followup SET status='pausado' WHERE lead_id=$1 AND status='pendente'`, [lead.id]);
    await registrarEventoLead(lead.id, lead.cliente_id, 'descartado_manual', 'Lead descartado pelo vendedor', { vendedor_id: req.vendedor.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/vendedor/leads/:id/followup/pausar', authVendedor, async (req, res) => {
  try {
    const lead = await vendedorPodeLead(req, req.params.id);
    if (!lead) return res.status(403).json({ error: 'Sem acesso a este lead.' });
    await query(`UPDATE movatak_leads SET etapa='lead', atualizado_em=NOW() WHERE id=$1`, [lead.id]);
    await query(`UPDATE movatak_followup SET status='pausado' WHERE lead_id=$1 AND status='pendente'`, [lead.id]);
    await registrarEventoLead(lead.id, lead.cliente_id, 'followup_pausado_manual', 'Follow-up pausado pelo vendedor', { vendedor_id: req.vendedor.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/vendedor/leads/:id/followup/reativar', authVendedor, async (req, res) => {
  try {
    const lead = await vendedorPodeLead(req, req.params.id);
    if (!lead) return res.status(403).json({ error: 'Sem acesso a este lead.' });
    const sequencia = parseInt(req.body && req.body.sequencia_fu ? req.body.sequencia_fu : 2, 10);
    const enviarImediato = !!(req.body && req.body.enviar_imediato);
    if (![1, 2].includes(sequencia)) return res.status(400).json({ error: 'sequencia_fu deve ser 1 ou 2.' });
    await query(`UPDATE movatak_leads SET etapa='followup', atualizado_em=NOW() WHERE id=$1`, [lead.id]);
    await agendarFollowupV2(lead.id, lead.cliente_id, sequencia, true);
    await registrarEventoLead(lead.id, lead.cliente_id, 'followup_reativado_manual', `Follow-up FU${sequencia} reativado pelo vendedor`, { vendedor_id: req.vendedor.id, enviar_imediato: enviarImediato });
    if (enviarImediato) await enviarFollowupsPendentesDoLead(lead.id, sequencia);
    res.json({ ok: true, sequencia_fu: sequencia });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/vendedor/leads/:id/iniciar-autoatendimento', authVendedor, async (req, res) => {
  try {
    const leadPerm = await vendedorPodeLead(req, req.params.id);
    if (!leadPerm) return res.status(403).json({ error: 'Sem acesso a este lead.' });
    const templateId = req.body && req.body.template_id ? parseInt(req.body.template_id, 10) : null;
    if (!templateId) return res.status(400).json({ error: 'template_id é obrigatório.' });
    const tpl = await query('SELECT id FROM movatak_questionario_templates WHERE id=$1 AND cliente_id=$2 AND ativo=true', [templateId, req.vendedor.cliente_id]);
    if (!tpl.rows.length) return res.status(404).json({ error: 'Template não encontrado para este cliente.' });
    await query('UPDATE movatak_leads SET automacao_pausada=false, pediu_atendente=false WHERE id=$1', [leadPerm.id]).catch(() => null);
    const leadRow = await query('SELECT * FROM movatak_leads WHERE id=$1 AND cliente_id=$2', [leadPerm.id, req.vendedor.cliente_id]);
    const cliRow = await query('SELECT * FROM movatak_clientes WHERE id=$1', [req.vendedor.cliente_id]);
    const lead = leadRow.rows[0];
    const cliente = cliRow.rows[0];
    if (!lead || !cliente) return res.status(404).json({ error: 'Lead ou cliente não encontrado.' });
    await query(
      `UPDATE movatak_questionario_estado SET status='cancelado', atualizado_em=NOW()
        WHERE cliente_id=$1 AND telefone=$2 AND status IN ('em_andamento','aguardando')`,
      [cliente.id, lead.telefone]
    ).catch(() => null);
    await iniciarQuestionarioPorTemplate(cliente, lead, templateId);
    await registrarEventoLead(lead.id, cliente.id, 'autoatendimento_manual', 'Autoatendimento iniciado pelo vendedor', { template_id: templateId, vendedor_id: req.vendedor.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/movatak/vendedor/leads/:id', authVendedor, async (req, res) => {
  try {
    const lead = await vendedorPodeLead(req, req.params.id);
    if (!lead) return res.status(403).json({ error: 'Sem acesso a este lead.' });
    const leadId = lead.id;
    await query('DELETE FROM movatak_conversas WHERE lead_id=$1', [leadId]).catch(() => null);
    await query('DELETE FROM movatak_followup WHERE lead_id=$1', [leadId]).catch(() => null);
    await query('DELETE FROM movatak_lead_eventos WHERE lead_id=$1', [leadId]).catch(() => null);
    await query('DELETE FROM movatak_mensagens WHERE lead_id=$1', [leadId]).catch(() => null);
    await query('DELETE FROM movatak_menu_estado WHERE lead_id=$1', [leadId]).catch(() => null);
    await query('DELETE FROM movatak_questionario_estado WHERE lead_id=$1', [leadId]).catch(() => null);
    await query('DELETE FROM movatak_leads WHERE id=$1 AND cliente_id=$2', [leadId, req.vendedor.cliente_id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
}

module.exports = { register };
