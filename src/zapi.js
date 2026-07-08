'use strict';

const axios = require('axios');
const { query } = require('./db');

const ZAPI_BASE = 'https://api.z-api.io/instances';

// Todas retornam o ID da mensagem que o Z-API devolve no envio. Pra APAGAR depois,
// o que o WhatsApp exige é o messageId (ID da mensagem no WhatsApp) — o zaapId é só
// o ID interno do Z-API e NÃO serve pra apagar. Por isso messageId vem primeiro.
function extrairIdMensagemZapi(resp) {
  const d = (resp && resp.data) || {};
  return d.messageId || d.id || d.zaapId || null;
}

function montarPayloadRespostaZapi(payload, replyMsgId) {
  if (!replyMsgId) return payload;

  // Z-API documenta oficialmente o vínculo de resposta pelo campo `messageId`.
  // Não enviar aliases extras aqui, porque alguns endpoints podem rejeitar
  // propriedades desconhecidas e cair no fallback sem responder nativamente.
  return {
    ...payload,
    messageId: String(replyMsgId)
  };
}
async function zapiPostComPossivelResposta(url, payload, clientToken, replyMsgId) {
  const headers = { 'Client-Token': clientToken };
  if (!replyMsgId) {
    const resp = await axios.post(url, payload, { headers });
    return extrairIdMensagemZapi(resp);
  }
  try {
    const resp = await axios.post(url, montarPayloadRespostaZapi(payload, replyMsgId), { headers });
    return extrairIdMensagemZapi(resp);
  } catch (e) {
    console.warn('[zapi][reply] envio com referência falhou; reenviando sem vínculo. status:', e.response?.status, 'body:', JSON.stringify(e.response?.data || {}));
    const resp = await axios.post(url, payload, { headers });
    return extrairIdMensagemZapi(resp);
  }
}

async function zapiEnviar(instance, token, clientToken, telefone, mensagem, replyMsgId = null) {
  const url = `${ZAPI_BASE}/${instance}/token/${token}/send-text`;
  return zapiPostComPossivelResposta(url, { phone: telefone, message: mensagem }, clientToken, replyMsgId);
}

// ---- Conexão da instância Z-API (status / reiniciar / QR) ----
async function getZapiCreds(clienteId) {
  const r = await query('SELECT zapi_instance, zapi_token, zapi_client_token FROM movatak_clientes WHERE id = $1', [clienteId]);
  if (!r.rows.length) return null;
  const c = r.rows[0];
  if (!c.zapi_instance || !c.zapi_token) return null;
  return { instance: c.zapi_instance, token: c.zapi_token, clientToken: c.zapi_client_token || '' };
}
async function zapiStatus(instance, token, clientToken) {
  const url = `${ZAPI_BASE}/${instance}/token/${token}/status`;
  const resp = await axios.get(url, { headers: { 'Client-Token': clientToken }, timeout: 12000 });
  return resp.data || {};
}
// Verifica se um número tem WhatsApp usando a instância fixa da captação (env vars).
// Retorna true/false/null (null = não deu pra verificar).
async function zapiPhoneExiste(telefone) {
  const instance = process.env.ZAPI_CAPTACAO_INSTANCE;
  const token = process.env.ZAPI_CAPTACAO_TOKEN;
  const clientToken = process.env.ZAPI_CAPTACAO_CLIENT_TOKEN || '';
  if (!instance || !token) throw new Error('Instância de captação Z-API não configurada (ZAPI_CAPTACAO_INSTANCE / ZAPI_CAPTACAO_TOKEN).');
  const fone = String(telefone || '').replace(/\D/g, '');
  if (!fone) return null;
  const url = `${ZAPI_BASE}/${instance}/token/${token}/phone-exists/${fone}`;
  try {
    const resp = await axios.get(url, { headers: { 'Client-Token': clientToken }, timeout: 12000 });
    const d = resp.data || {};
    if (typeof d.exists === 'boolean') return d.exists;
    if (typeof d.existsWhatsapp === 'boolean') return d.existsWhatsapp;
    return null;
  } catch (e) {
    console.error('[captacao] phone-exists falhou p/', fone, '-', e.response?.status, e.message);
    return null;
  }
}
async function zapiRestart(instance, token, clientToken) {
  const url = `${ZAPI_BASE}/${instance}/token/${token}/restart`;
  const resp = await axios.get(url, { headers: { 'Client-Token': clientToken }, timeout: 12000 });
  return resp.data || {};
}
async function zapiQrImagem(instance, token, clientToken) {
  const url = `${ZAPI_BASE}/${instance}/token/${token}/qr-code/image`;
  const resp = await axios.get(url, { headers: { 'Client-Token': clientToken }, timeout: 12000 });
  return resp.data;
}

async function zapiEnviarImagem(instance, token, clientToken, telefone, imageUrl, caption, replyMsgId = null) {
  const url = `${ZAPI_BASE}/${instance}/token/${token}/send-image`;
  return zapiPostComPossivelResposta(url, { phone: telefone, image: imageUrl, caption: caption || '' }, clientToken, replyMsgId);
}

async function zapiEnviarVideo(instance, token, clientToken, telefone, videoUrl, caption, replyMsgId = null) {
  const url = `${ZAPI_BASE}/${instance}/token/${token}/send-video`;
  return zapiPostComPossivelResposta(url, { phone: telefone, video: videoUrl, caption: caption || '' }, clientToken, replyMsgId);
}

async function zapiEnviarAudio(instance, token, clientToken, telefone, audioUrl, replyMsgId = null) {
  // Mensagem de voz (PTT) no WhatsApp não tem legenda — só o áudio.
  const url = `${ZAPI_BASE}/${instance}/token/${token}/send-audio`;
  return zapiPostComPossivelResposta(url, { phone: telefone, audio: audioUrl }, clientToken, replyMsgId);
}

// Apaga a mensagem no WhatsApp do lead (delete for everyone). Convenção do Z-API
// pra isso ainda não testada contra a API real — se o endpoint/formato não bater,
// me avisa o erro exato que aparecer pra eu ajustar.
async function zapiApagarMensagem(instance, token, clientToken, telefone, messageId) {
  // Z-API espera os parâmetros na query string do DELETE, não no body.
  // owner=true => apagar uma mensagem que NÓS enviamos (delete for everyone).
  const url = `${ZAPI_BASE}/${instance}/token/${token}/messages`;
  const resp = await axios.delete(url, {
    headers: { 'Client-Token': clientToken },
    params: { messageId, phone: telefone, owner: 'true' }
  });
  console.log('[zapi][apagar] resposta:', JSON.stringify(resp.data || {}));
  return resp.data;
}

async function zapiEtiquetar(instance, token, clientToken, telefone, label) {
  const url = `${ZAPI_BASE}/${instance}/token/${token}/label-contact`;
  await axios.post(url, { phone: telefone, labelName: label }, {
    headers: { 'Client-Token': clientToken }
  });
}


async function zapiArquivar(instance, token, clientToken, telefone) {
  const url = `${ZAPI_BASE}/${instance}/token/${token}/archive-chat`;
  await axios.post(url, { phone: telefone, archive: true }, { headers: { 'Client-Token': clientToken } });
}

async function zapiMarcarNaoLido(instance, token, clientToken, telefone) {
  const url = `${ZAPI_BASE}/${instance}/token/${token}/mark-message-as-unread`;
  await axios.post(url, { phone: telefone }, { headers: { 'Client-Token': clientToken } });
}

// Busca a URL da foto de perfil do contato. A URL retornada pelo WhatsApp expira
// em ~48h, então não vale guardar para sempre — buscamos sob demanda e cacheamos
// por algumas horas (controle via foto_atualizada_em).
async function zapiBuscarFoto(instance, token, clientToken, telefone) {
  try {
    const url = `${ZAPI_BASE}/${instance}/token/${token}/profile-picture`;
    const resp = await axios.get(url, { headers: { 'Client-Token': clientToken }, params: { phone: telefone }, timeout: 8000 });
    const d = resp.data || {};
    return d.link || d.imgUrl || d.url || d.profilePicture || null;
  } catch (e) {
    return null;
  }
}


function zapiHeaders(clientToken) {
  return { 'Client-Token': clientToken };
}

function zapiUrl(instance, token, endpoint) {
  return `${ZAPI_BASE}/${instance}/token/${token}/${String(endpoint || '').replace(/^\/+/, '')}`;
}

async function zapiPost(instance, token, clientToken, endpoint, payload = {}) {
  const resp = await axios.post(zapiUrl(instance, token, endpoint), payload, { headers: zapiHeaders(clientToken) });
  return resp.data || {};
}

async function zapiGet(instance, token, clientToken, endpoint, params = {}) {
  const resp = await axios.get(zapiUrl(instance, token, endpoint), { headers: zapiHeaders(clientToken), params });
  return resp.data || {};
}

async function zapiEnviarDocumento(instance, token, clientToken, telefone, documentUrl, fileName, caption, extension, replyMsgId = null) {
  const ext = String(extension || (fileName || '').split('.').pop() || 'pdf').replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'pdf';
  const url = `${ZAPI_BASE}/${instance}/token/${token}/send-document/${ext}`;
  const payload = { phone: telefone, document: documentUrl };
  if (fileName) payload.fileName = fileName;
  if (caption) payload.caption = caption;
  return zapiPostComPossivelResposta(url, payload, clientToken, replyMsgId);
}

async function zapiEnviarLocalizacao(instance, token, clientToken, telefone, title, address, latitude, longitude, replyMsgId = null) {
  const url = `${ZAPI_BASE}/${instance}/token/${token}/send-location`;
  return zapiPostComPossivelResposta(url, { phone: telefone, title, address, latitude: String(latitude), longitude: String(longitude) }, clientToken, replyMsgId);
}

async function zapiEnviarLink(instance, token, clientToken, telefone, linkUrl, message, title, image, replyMsgId = null) {
  const url = `${ZAPI_BASE}/${instance}/token/${token}/send-link`;
  const payload = { phone: telefone, linkUrl };
  if (message) payload.message = message;
  if (title) payload.title = title;
  if (image) payload.image = image;
  return zapiPostComPossivelResposta(url, payload, clientToken, replyMsgId);
}

async function zapiEnviarContato(instance, token, clientToken, telefone, contactName, contactPhone, contactBusiness = false, replyMsgId = null) {
  const url = `${ZAPI_BASE}/${instance}/token/${token}/send-contact`;
  return zapiPostComPossivelResposta(url, { phone: telefone, contactName, contactPhone, contactBusiness: !!contactBusiness }, clientToken, replyMsgId);
}

async function zapiReagirMensagem(instance, token, clientToken, telefone, messageId, reaction) {
  return zapiPost(instance, token, clientToken, 'send-reaction', { phone: telefone, messageId, reaction });
}

async function zapiEncaminharMensagem(instance, token, clientToken, destino, messageId, messagePhone) {
  return zapiPost(instance, token, clientToken, 'forward-message', { phone: destino, messageId, messagePhone });
}

async function zapiLerMensagem(instance, token, clientToken, telefone, messageId) {
  return zapiPost(instance, token, clientToken, 'read-message', { phone: telefone, messageId });
}

async function zapiEditarTexto(instance, token, clientToken, telefone, messageId, novoTexto) {
  return zapiPost(instance, token, clientToken, 'send-text', { phone: telefone, message: novoTexto, editMessageId: messageId });
}

async function zapiModificarChat(instance, token, clientToken, telefone, action) {
  return zapiPost(instance, token, clientToken, 'modify-chat', { phone: telefone, action });
}

async function zapiListarChats(instance, token, clientToken) {
  return zapiGet(instance, token, clientToken, 'chats');
}

const ZAPI_ADVANCED_ENDPOINTS = {
  sticker: 'send-sticker',
  gif: 'send-gif',
  ptv: 'send-ptv',
  catalog: 'send-catalog',
  product: 'send-product',
  poll: 'send-poll',
  button_actions: 'send-button-actions',
  button_list: 'send-button-list',
  button_image: 'send-button-list-image',
  button_video: 'send-button-list-video',
  option_list: 'send-option-list',
  otp: 'send-button-otp',
  pix: 'send-button-pix',
  carousel: 'send-carousel',
  order: 'send-order',
  order_status: 'send-order-status-update',
  order_payment: 'send-order-payment-update',
  pin_message: 'pin-message'
};

function limparPayloadAvancado(payload) {
  const out = { ...(payload || {}) };
  delete out.phone; delete out.telefone; delete out.endpoint; delete out.recurso; delete out.tipo;
  return out;
}

const MOVATAK_ADMIN_WA = '558176041948';

async function zapiCriarEtiqueta(instance, token, clientToken, nome) {
  try {
    // Z-API: criação de tag é POST em /business/create-tag (somente contas Business).
    // O caminho /tags é GET (listar) — usar POST nele retorna 405.
    const url = `https://api.z-api.io/instances/${instance}/token/${token}/business/create-tag`;
    const res = await axios.post(url, { name: nome }, { headers: { 'Client-Token': clientToken } });
    return res.data;
  } catch(e) {
    console.error('[zapiCriarEtiqueta]', e.message);
    return null;
  }
}

async function zapiAtribuirEtiqueta(instance, token, clientToken, telefone, tagId) {
  try {
    const url = `https://api.z-api.io/instances/${instance}/token/${token}/chats/${telefone}/tags/${tagId}/add`;
    await axios.put(url, {}, { headers: { 'Client-Token': clientToken } });
  } catch(e) {
    console.error('[zapiAtribuirEtiqueta]', e.message);
  }
}

async function zapiRemoverEtiqueta(instance, token, clientToken, telefone, tagId) {
  try {
    if (!tagId) return;
    const url = `https://api.z-api.io/instances/${instance}/token/${token}/chats/${telefone}/tags/${tagId}/remove`;
    await axios.put(url, {}, { headers: { 'Client-Token': clientToken } });
  } catch(e) {
    // Mantém a operação do CRM mesmo se a remoção da lista/tag falhar na Z-API.
    console.error('[zapiRemoverEtiqueta]', e.message);
  }
}


module.exports = {
  ZAPI_BASE,
  extrairIdMensagemZapi, montarPayloadRespostaZapi, zapiPostComPossivelResposta,
  zapiEnviar, getZapiCreds, zapiStatus, zapiPhoneExiste, zapiRestart, zapiQrImagem,
  zapiEnviarImagem, zapiEnviarVideo, zapiEnviarAudio, zapiApagarMensagem, zapiEtiquetar,
  zapiArquivar, zapiMarcarNaoLido, zapiBuscarFoto, zapiHeaders, zapiUrl, zapiPost, zapiGet,
  zapiEnviarDocumento, zapiEnviarLocalizacao, zapiEnviarLink, zapiEnviarContato,
  zapiReagirMensagem, zapiEncaminharMensagem, zapiLerMensagem, zapiEditarTexto,
  zapiModificarChat, zapiListarChats, ZAPI_ADVANCED_ENDPOINTS, limparPayloadAvancado,
  MOVATAK_ADMIN_WA, zapiCriarEtiqueta, zapiAtribuirEtiqueta, zapiRemoverEtiqueta,
};
