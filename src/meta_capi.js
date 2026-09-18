'use strict';

// ============================================================
// Meta Conversions API — conversões offline (FASE 1).
//
// O que faz: avisa a Meta quando um lead converte (virou cliente, fechou pedido),
// pra ela otimizar os anúncios por VENDA e não só por conversa iniciada.
//
// Como o match acontece: pelo TELEFONE criptografado em SHA-256. O casamento exato
// clique→venda (ctwa_clid) exige o whatsapp_business_account_id, que só existe em
// número na API oficial da Meta; aqui tudo roda na Z-API. O telefone é o método que a
// própria Meta recomenda pra dado vindo de CRM.
//
// ⚠️ NINGUÉM CHAMA ESTE MÓDULO AINDA. A Fase 2 é que liga os gatilhos no funil.
// Enquanto isso o arquivo é inerte: importá-lo não muda comportamento nenhum.
//
// Regras que valem sempre:
//   - gated: só envia se o cliente tiver meta_capi_ativo = true, dataset e token;
//   - nunca derruba o fluxo de quem chamou (toda falha vira log + linha de auditoria);
//   - toda tentativa é gravada em movatak_meta_eventos, com a resposta da Meta.
// ============================================================

const crypto = require('crypto');
const { query, garantirEstruturaMetaCapi } = require('./db');

// Versão da Graph API. v26.0 é a atual em setembro/2026; dá pra fixar outra por env
// sem mexer no código quando a Meta descontinuar.
const META_API_VERSION = process.env.META_API_VERSION || 'v26.0';
const META_TIMEOUT_MS = 12000;

// Eventos que a Meta aceita para conversão offline. Guardado aqui pra UI e backend
// usarem a mesma lista e ninguém digitar um nome que a Meta rejeita.
const EVENTOS_META = [
  'Lead',
  'Purchase',
  'CompleteRegistration',
  'Schedule',
  'Contact',
  'SubmitApplication',
  'StartTrial',
  'AddToCart',
  'InitiateCheckout',
];

// A Meta exige o telefone só com dígitos, em formato internacional, antes do hash.
// Ex.: "+55 (81) 98765-4321" -> "5581987654321". Número sem DDI recebe 55 na frente,
// que é o caso de todo lead brasileiro daqui.
function normalizarTelefoneParaMeta(telefone) {
  let d = String(telefone || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length <= 11) d = '55' + d;      // veio sem DDI
  if (d.length < 12 || d.length > 15) return null; // fora do E.164 = não dá pra casar
  return d;
}

function hashSha256(valor) {
  return crypto.createHash('sha256').update(String(valor)).digest('hex');
}

// user_data com o telefone hasheado. A Meta só aceita contato hasheado — mandar o
// número puro é recusado (e seria vazamento de dado do lead).
function montarUserData(lead) {
  const tel = normalizarTelefoneParaMeta(lead && lead.telefone);
  if (!tel) return null;
  return { ph: [hashSha256(tel)] };
}

// event_id serve de trava de duplicata do lado da Meta: se o mesmo evento for enviado
// duas vezes, ela conta uma só. Granularidade de minuto — dois eventos iguais no mesmo
// minuto são o mesmo acontecimento; no dia seguinte, é uma venda nova.
function montarEventId(leadId, eventName, quando) {
  const d = quando instanceof Date ? quando : new Date();
  const carimbo = d.toISOString().slice(0, 16).replace(/[-:T]/g, '');
  return 'mv-' + leadId + '-' + String(eventName).toLowerCase() + '-' + carimbo;
}

// Monta o corpo exato que a Meta espera para conversão offline.
function montarPayload(cliente, lead, eventName, opts = {}) {
  const userData = montarUserData(lead);
  if (!userData) return null;
  const quando = opts.quando instanceof Date ? opts.quando : new Date();
  const evento = {
    event_name: eventName,
    event_time: Math.floor(quando.getTime() / 1000),
    // physical_store é o action_source que a Meta exige para evento offline/CRM.
    action_source: 'physical_store',
    event_id: montarEventId(lead.id, eventName, quando),
    user_data: userData,
  };
  const valor = opts.valor != null ? Number(opts.valor) : null;
  if (valor != null && !Number.isNaN(valor)) {
    evento.custom_data = { value: valor, currency: opts.moeda || 'BRL' };
  }
  const corpo = { data: [evento] };
  // Código de teste: os eventos aparecem em "Eventos de teste" no Gerenciador e NÃO
  // entram na otimização. É como conferir a integração sem sujar os dados.
  if (cliente.meta_test_event_code) corpo.test_event_code = cliente.meta_test_event_code;
  return corpo;
}

async function registrarAuditoria(dados) {
  await garantirEstruturaMetaCapi();
  await query(
    `INSERT INTO movatak_meta_eventos
       (cliente_id, lead_id, coluna_id, event_name, event_id, valor, moeda, status, http_status, resposta, erro)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (event_id) DO NOTHING`,
    [dados.clienteId, dados.leadId || null, dados.colunaId || null, dados.eventName,
     dados.eventId || null, dados.valor ?? null, dados.moeda || null, dados.status,
     dados.httpStatus || null, dados.resposta ? String(dados.resposta).slice(0, 2000) : null,
     dados.erro ? String(dados.erro).slice(0, 500) : null]
  ).catch(e => console.error('[meta-capi] falha ao gravar auditoria:', e.message));
}

function clienteConfigurado(cliente) {
  return !!(cliente && cliente.meta_capi_ativo && cliente.meta_dataset_id && cliente.meta_access_token);
}

// Envia UM evento de conversão. Devolve {ok, motivo} e nunca lança: quem chama está
// no meio de mover um lead no funil e não pode quebrar por causa disto.
async function enviarEventoMeta(cliente, lead, eventName, opts = {}) {
  try {
    if (!clienteConfigurado(cliente)) return { ok: false, motivo: 'desligado' };
    if (!lead || !lead.id) return { ok: false, motivo: 'lead invalido' };
    if (!EVENTOS_META.includes(eventName)) return { ok: false, motivo: 'evento nao suportado: ' + eventName };

    const corpo = montarPayload(cliente, lead, eventName, opts);
    if (!corpo) {
      await registrarAuditoria({ clienteId: cliente.id, leadId: lead.id, colunaId: opts.colunaId,
        eventName, status: 'ignorado', erro: 'telefone fora do formato internacional' });
      return { ok: false, motivo: 'telefone invalido' };
    }
    const eventId = corpo.data[0].event_id;

    const url = 'https://graph.facebook.com/' + META_API_VERSION + '/' +
                encodeURIComponent(cliente.meta_dataset_id) + '/events';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), META_TIMEOUT_MS);
    let resp, texto;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json',
                   'Authorization': 'Bearer ' + cliente.meta_access_token },
        body: JSON.stringify(corpo),
        signal: ctrl.signal,
      });
      texto = await resp.text();
    } finally { clearTimeout(timer); }

    const ok = resp.ok;
    await registrarAuditoria({
      clienteId: cliente.id, leadId: lead.id, colunaId: opts.colunaId, eventName, eventId,
      valor: opts.valor ?? null, moeda: opts.valor != null ? (opts.moeda || 'BRL') : null,
      status: ok ? 'enviado' : 'erro', httpStatus: resp.status,
      resposta: texto, erro: ok ? null : ('HTTP ' + resp.status),
    });
    if (!ok) console.error('[meta-capi] recusado pela Meta (HTTP ' + resp.status + '): ' + String(texto).slice(0, 300));
    else console.log('[meta-capi] ' + eventName + ' enviado | lead ' + lead.id + ' | event_id ' + eventId);
    return { ok, motivo: ok ? null : 'http ' + resp.status, resposta: texto };
  } catch (e) {
    const abortado = e && e.name === 'AbortError';
    console.error('[meta-capi] falha ao enviar:', abortado ? 'timeout' : e.message);
    await registrarAuditoria({ clienteId: cliente && cliente.id, leadId: lead && lead.id,
      colunaId: opts.colunaId, eventName, status: 'erro', erro: abortado ? 'timeout' : e.message });
    return { ok: false, motivo: abortado ? 'timeout' : e.message };
  }
}

// Teste de configuração: manda um evento marcado como teste, que a Meta mostra em
// "Eventos de teste" e não usa pra otimizar. Exige o código de teste preenchido.
async function testarConexaoMeta(cliente, telefoneTeste) {
  if (!clienteConfigurado(cliente)) return { ok: false, motivo: 'Configure dataset, token e ligue o recurso.' };
  if (!cliente.meta_test_event_code) return { ok: false, motivo: 'Preencha o código de teste do Gerenciador de Eventos.' };
  const leadFalso = { id: 0, telefone: telefoneTeste || '5581999999999' };
  return enviarEventoMeta(cliente, leadFalso, 'Lead', { valor: null });
}

module.exports = {
  META_API_VERSION,
  EVENTOS_META,
  normalizarTelefoneParaMeta,
  hashSha256,
  montarUserData,
  montarEventId,
  montarPayload,
  clienteConfigurado,
  enviarEventoMeta,
  testarConexaoMeta,
};
