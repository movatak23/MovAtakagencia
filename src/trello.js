'use strict';

// ============================================================
// Integração Trello (produção) — FASE 1: o módulo.
//
// Ida:   o atendente clica "🏭 Enviar para produção" → o CRM cria o cartão na lista
//        escolhida, no MESMO padrão de título que a equipe já usa à mão:
//            #2974 - 8168 - GREEN SOLARI - 6 METROS (OBSERVAÇÃO)
//             │       │         │            │
//             │       │         │            └ quantidade
//             │       │         └ cliente/empresa (editável: o nome no CRM pode ser "🥶")
//             │       └ 4 últimos dígitos do telefone do cliente
//             └ número do pedido na Nuvemshop (opcional)
//        e anexa as imagens da conversa (a arte que o cliente mandou).
//
// Volta: o Trello avisa (webhook) quando o cartão muda de lista ou é arquivado, e o CRM
//        só guarda/mostra a etapa. Arquivado = pedido entregue. Não move o kanban e não
//        manda mensagem ao cliente — decisão do dono.
//
// Quem usa: index.js (POST /movatak/webhook/trello) e routes/admin.js (listas, criar
// cartão, etapa do lead). Tudo condicionado a movatak_clientes.trello_ativo.
// ============================================================

const crypto = require('crypto');
const { query, garantirEstruturaTrello } = require('./db');

const TRELLO_API = 'https://api.trello.com/1';
const TRELLO_TIMEOUT_MS = 15000;
const ETAPA_CONCLUIDO = 'Concluído';

// Credenciais: as do cliente no banco; se faltar, as envs do Railway. O token nunca
// deve passar pelo chat — o caminho recomendado é a env.
function credenciaisTrello(cliente) {
  const c = cliente || {};
  return {
    key: c.trello_api_key || process.env.TRELLO_API_KEY || null,
    token: c.trello_token || process.env.TRELLO_TOKEN || null,
    secret: c.trello_api_secret || process.env.TRELLO_API_SECRET || null,
  };
}

function trelloConfigurado(cliente) {
  const cr = credenciaisTrello(cliente);
  return !!(cliente && cliente.trello_ativo && cliente.trello_board_id && cr.key && cr.token);
}

// Chamada à API. Autentica pelo header OAuth (a chave/token não vão na URL, que é o
// que costuma aparecer em log de proxy).
async function trelloApi(cliente, metodo, caminho, params) {
  const cr = credenciaisTrello(cliente);
  if (!cr.key || !cr.token) throw new Error('Trello sem credenciais (key/token).');
  const url = new URL(TRELLO_API + caminho);
  if (params && metodo === 'GET') {
    Object.entries(params).forEach(([k, v]) => { if (v != null) url.searchParams.set(k, String(v)); });
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TRELLO_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: metodo,
      headers: {
        'Authorization': 'OAuth oauth_consumer_key="' + cr.key + '", oauth_token="' + cr.token + '"',
        'Accept': 'application/json',
        ...(metodo !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
      },
      body: metodo !== 'GET' && params ? JSON.stringify(params) : undefined,
      signal: ctrl.signal,
    });
    const texto = await resp.text();
    if (!resp.ok) throw new Error('Trello HTTP ' + resp.status + ': ' + texto.slice(0, 200));
    return texto ? JSON.parse(texto) : null;
  } finally { clearTimeout(timer); }
}

// As listas do quadro, na ordem do Trello. O formulário usa isso — se a equipe criar uma
// lista nova amanhã, ela aparece sem mudar código.
async function listarListasTrello(cliente) {
  const listas = await trelloApi(cliente, 'GET', '/boards/' + encodeURIComponent(cliente.trello_board_id) + '/lists',
    { fields: 'name,closed,pos', filter: 'open' });
  return (listas || []).map(l => ({ id: l.id, nome: l.name }));
}

// Tira emoji e excesso de espaço: "🥶 Green  Solari" -> "GREEN SOLARI".
function limparNomeParaCartao(nome) {
  return String(nome || '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function ultimos4Digitos(telefone) {
  const d = String(telefone || '').replace(/\D/g, '');
  return d.length >= 4 ? d.slice(-4) : null;
}

// Monta o título no padrão da equipe. Partes vazias somem sem deixar " -  - ".
function montarTituloCartao({ pedido, telefone, nome, quantidade, observacao }) {
  const pedidoLimpo = String(pedido || '').replace(/[^\dA-Za-z-]/g, '');
  const partes = [
    pedidoLimpo ? '#' + pedidoLimpo : null,
    ultimos4Digitos(telefone),
    limparNomeParaCartao(nome) || null,
    quantidade ? String(quantidade).trim().toUpperCase() : null,
  ].filter(Boolean);
  let titulo = partes.join(' - ');
  const obs = String(observacao || '').trim();
  if (obs) titulo += ' (' + obs.toUpperCase() + ')';
  return titulo.slice(0, 16384); // limite do Trello para nome de cartão
}

function montarDescricaoCartao({ nomeCrm, telefone, linkCrm, pedido }) {
  const linhas = [
    '**Cliente no CRM:** ' + (nomeCrm || '-'),
    '**WhatsApp:** ' + (telefone ? 'https://wa.me/' + String(telefone).replace(/\D/g, '') : '-'),
  ];
  if (pedido) linhas.push('**Pedido Nuvemshop:** #' + pedido);
  if (linkCrm) linhas.push('**Abrir no CRM:** ' + linkCrm);
  linhas.push('', '_Cartão criado pelo MovAtak CRM._');
  return linhas.join('\n');
}

// Cria o cartão, anexa as imagens e registra o pedido. Devolve a linha gravada.
async function criarCartaoProducao(cliente, lead, dados) {
  await garantirEstruturaTrello();
  if (!trelloConfigurado(cliente)) throw new Error('Integração com o Trello desligada ou incompleta.');
  if (!dados || !dados.listaId) throw new Error('Escolha a lista de destino.');

  const titulo = montarTituloCartao({
    pedido: dados.pedido, telefone: lead.telefone,
    nome: dados.nome || lead.nome, quantidade: dados.quantidade, observacao: dados.observacao,
  });
  const card = await trelloApi(cliente, 'POST', '/cards', {
    idList: dados.listaId,
    name: titulo,
    desc: montarDescricaoCartao({ nomeCrm: lead.nome, telefone: lead.telefone, linkCrm: dados.linkCrm, pedido: dados.pedido }),
    pos: 'top',
  });

  // Anexos: falha de UM anexo não derruba o cartão — ele já existe e é o que importa.
  const falhas = [];
  for (const url of (dados.anexos || []).slice(0, 10)) {
    try { await trelloApi(cliente, 'POST', '/cards/' + card.id + '/attachments', { url }); }
    catch (e) { falhas.push(e.message); }
  }

  const listaNome = dados.listaNome || null;
  const r = await query(
    `INSERT INTO movatak_trello_cartoes
       (cliente_id, lead_id, card_id, card_url, titulo, pedido_numero, quantidade, lista_id, lista_nome, criado_por)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (card_id) DO NOTHING
     RETURNING *`,
    [cliente.id, lead.id, card.id, card.shortUrl || card.url || null, titulo,
     dados.pedido || null, dados.quantidade || null, dados.listaId, listaNome, dados.criadoPor || null]);
  return { cartao: r.rows[0] || null, anexosComFalha: falhas };
}

// Assinatura do webhook: base64(HMAC-SHA1(secret, CORPO_CRU + callbackURL)). Tem que ser
// o corpo CRU (bytes recebidos): re-serializar o JSON muda escape de acento e quebra a
// comparação. Comparação em tempo constante.
function verificarAssinaturaTrello(corpoCru, callbackUrl, assinaturaRecebida, secret) {
  if (!secret || !assinaturaRecebida || corpoCru == null) return false;
  const esperado = crypto.createHmac('sha1', secret)
    .update(Buffer.concat([Buffer.isBuffer(corpoCru) ? corpoCru : Buffer.from(String(corpoCru), 'utf8'),
                           Buffer.from(String(callbackUrl), 'utf8')]))
    .digest('base64');
  const a = Buffer.from(esperado);
  const b = Buffer.from(String(assinaturaRecebida));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Traduz um evento do Trello no que interessa ao CRM. Devolve null quando o evento não
// muda a etapa (comentário, etiqueta, descrição...), pra quem chama só ignorar.
function interpretarEventoTrello(payload) {
  const acao = payload && payload.action;
  if (!acao || !acao.data || !acao.data.card) return null;
  const card = acao.data.card;
  const d = acao.data;
  if (acao.type === 'updateCard') {
    // Arquivado = pedido entregue (é assim que a equipe encerra o cartão).
    if (d.old && d.old.closed === false && card.closed === true) {
      return { cardId: card.id, etapa: ETAPA_CONCLUIDO, arquivado: true, listaId: null };
    }
    // Desarquivado: volta a mostrar a lista onde ele estava.
    if (d.old && d.old.closed === true && card.closed === false) {
      return { cardId: card.id, etapa: null, arquivado: false, listaId: null, desarquivado: true };
    }
    if (d.listAfter && d.listBefore && d.listAfter.id !== d.listBefore.id) {
      return { cardId: card.id, etapa: d.listAfter.name, arquivado: false, listaId: d.listAfter.id };
    }
  }
  if (acao.type === 'deleteCard') {
    return { cardId: card.id, etapa: 'Excluído no Trello', arquivado: true, listaId: null };
  }
  return null;
}

// Aplica o evento no pedido correspondente. Cartão que o CRM não criou é ignorado —
// o quadro tem cartões feitos à mão que não são deste sistema.
async function aplicarEventoTrello(evento) {
  if (!evento) return null;
  await garantirEstruturaTrello();
  if (evento.desarquivado) {
    const r = await query(
      `UPDATE movatak_trello_cartoes SET arquivado = false, atualizado_em = NOW()
        WHERE card_id = $1 RETURNING *`, [evento.cardId]);
    return r.rows[0] || null;
  }
  const r = await query(
    `UPDATE movatak_trello_cartoes
        SET lista_nome = COALESCE($2, lista_nome),
            lista_id = COALESCE($3, lista_id),
            arquivado = $4,
            atualizado_em = NOW()
      WHERE card_id = $1 RETURNING *`,
    [evento.cardId, evento.etapa, evento.listaId, !!evento.arquivado]);
  return r.rows[0] || null;
}

// Etapa atual do pedido mais recente de cada lead, pro selo no painel/kanban.
async function etapasProducaoPorLead(clienteId, leadIds) {
  await garantirEstruturaTrello();
  if (!leadIds || !leadIds.length) return {};
  const r = await query(
    `SELECT DISTINCT ON (lead_id) lead_id, card_url, titulo,
            CASE WHEN arquivado THEN $3 ELSE lista_nome END AS etapa, atualizado_em
       FROM movatak_trello_cartoes
      WHERE cliente_id = $1 AND lead_id = ANY($2::int[])
      -- id DESC desempata cartões criados no mesmo instante: o mais novo é o pedido atual.
      ORDER BY lead_id, criado_em DESC, id DESC`,
    [clienteId, leadIds.map(Number), ETAPA_CONCLUIDO]);
  return Object.fromEntries(r.rows.map(x => [x.lead_id, x]));
}

async function registrarWebhookTrello(cliente, callbackUrl) {
  return trelloApi(cliente, 'POST', '/webhooks', {
    callbackURL: callbackUrl, idModel: cliente.trello_board_id,
    description: 'MovAtak CRM — etapas de produção',
  });
}

module.exports = {
  ETAPA_CONCLUIDO,
  credenciaisTrello,
  trelloConfigurado,
  listarListasTrello,
  limparNomeParaCartao,
  ultimos4Digitos,
  montarTituloCartao,
  montarDescricaoCartao,
  criarCartaoProducao,
  verificarAssinaturaTrello,
  interpretarEventoTrello,
  aplicarEventoTrello,
  etapasProducaoPorLead,
  registrarWebhookTrello,
};
