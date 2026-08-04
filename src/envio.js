'use strict';

// ============================================================
// Camada de envio MULTICANAL (dispatcher).  [instagram] Fase 1.
//
// Decide o canal pelo `lead.canal` e encaminha:
//   - 'whatsapp' (default)  -> zapiEnviar* (Z-API), com EXATAMENTE os mesmos
//                              argumentos usados hoje nos call sites (verbatim);
//   - 'instagram'           -> STUB ate a Fase 2 (src/instagram.js). Hoje esse
//                              galho NUNCA e alcancado em producao: nenhum lead
//                              tem canal='instagram' e o IG esta gated
//                              (ig_habilitado=false em todos os tenants).
//
// Convencao de uso (para a migracao da Fase 4):
//   * `conta` = linha de movatak_clientes (tem zapi_instance/zapi_token/
//     zapi_client_token e, apos a Fase 0, as colunas ig_*).
//   * `lead`  = linha de movatak_leads (tem canal, canal_id, telefone).
//   Migrar SO os envios DIRECIONADOS A UM LEAD. Envios sem lead (aviso ao
//   dono, relatorios, disparo pra numero arbitrario) continuam chamando
//   zapiEnviar* direto — nao passam por aqui.
//
// Este modulo e ADITIVO: enquanto a Fase 4 nao migra os call sites, ninguem
// o importa e o comportamento do WhatsApp fica byte-a-byte igual.
// ============================================================

const zapi = require('./zapi');

function ehInstagram(lead) {
  return !!(lead && lead.canal === 'instagram');
}

// Fase 2 substitui estes stubs por require('./instagram').igEnviar*.
function stubInstagram(op) {
  return Promise.reject(new Error(`[envio] Instagram (${op}) ainda nao implementado — Fase 2`));
}

async function enviarMensagem(conta, lead, mensagem, opts = {}) {
  const replyMsgId = opts.replyMsgId || null;
  if (ehInstagram(lead)) return stubInstagram('texto');
  return zapi.zapiEnviar(conta.zapi_instance, conta.zapi_token, conta.zapi_client_token, lead.telefone, mensagem, replyMsgId);
}

async function enviarImagem(conta, lead, imageUrl, caption, opts = {}) {
  const replyMsgId = opts.replyMsgId || null;
  if (ehInstagram(lead)) return stubInstagram('imagem');
  return zapi.zapiEnviarImagem(conta.zapi_instance, conta.zapi_token, conta.zapi_client_token, lead.telefone, imageUrl, caption, replyMsgId);
}

async function enviarVideo(conta, lead, videoUrl, caption, opts = {}) {
  const replyMsgId = opts.replyMsgId || null;
  if (ehInstagram(lead)) return stubInstagram('video');
  return zapi.zapiEnviarVideo(conta.zapi_instance, conta.zapi_token, conta.zapi_client_token, lead.telefone, videoUrl, caption, replyMsgId);
}

async function enviarAudio(conta, lead, audioUrl, opts = {}) {
  const replyMsgId = opts.replyMsgId || null;
  if (ehInstagram(lead)) return stubInstagram('audio');
  return zapi.zapiEnviarAudio(conta.zapi_instance, conta.zapi_token, conta.zapi_client_token, lead.telefone, audioUrl, replyMsgId);
}

async function enviarDocumento(conta, lead, documentUrl, fileName, caption, extension, opts = {}) {
  const replyMsgId = opts.replyMsgId || null;
  if (ehInstagram(lead)) return stubInstagram('documento');
  return zapi.zapiEnviarDocumento(conta.zapi_instance, conta.zapi_token, conta.zapi_client_token, lead.telefone, documentUrl, fileName, caption, extension, replyMsgId);
}

module.exports = {
  ehInstagram,
  enviarMensagem,
  enviarImagem,
  enviarVideo,
  enviarAudio,
  enviarDocumento,
};
