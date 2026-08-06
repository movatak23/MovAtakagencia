'use strict';

// ============================================================
// Sincronização de leitura CRM -> WhatsApp (Z-API)
// Espelha no aparelho o estado de leitura do CRM: sempre que o CRM considera a
// conversa LIDA (nao_lida=false — por abertura no painel OU por uma resposta de
// saída), marca o chat como lido no WhatsApp. Idempotente e com trava anti-spam
// (zap_lido_msg_id): só chama a Z-API quando há um inbound NOVO ainda não marcado.
// Isolado num módulo pra poder ser usado tanto pelo index.js quanto pelo leads.js
// (registro de conversa) sem dependência circular.
// ============================================================
const { query } = require('./db');
const { zapiLerMensagem, zapiModificarChat } = require('./zapi');

// Identificador do chat para a Z-API. read-message/modify-chat aceitam número real,
// @lid E id de GRUPO ("120363...-group") — testado: os três retornam value:true.
// Usa o telefone (que já guarda o id certo do chat, inclusive grupo) e cai no
// chat_lid quando não há telefone.
function alvoZap(row) {
  return (row && row.telefone) || (row && row.chat_lid) || null;
}

async function marcarChatLidoNoZap(leadId) {
  try {
    const r = await query(
      `SELECT l.telefone, l.chat_lid, l.nao_lida, l.zap_lido_msg_id,
              c.zapi_instance, c.zapi_token, c.zapi_client_token
         FROM movatak_leads l JOIN movatak_clientes c ON c.id = l.cliente_id
        WHERE l.id = $1`,
      [leadId]
    );
    const row = r.rows[0];
    if (!row || !row.zapi_instance) return;
    // Espelha o CRM: se o lead ainda está NÃO LIDA no CRM (ex.: pediu atendente),
    // NÃO marca lido no WhatsApp — o aparelho deve continuar mostrando não-lido.
    if (row.nao_lida === true) return;
    const alvo = alvoZap(row);
    if (!alvo) return;

    // Última mensagem RECEBIDA com id: ler ela lê o chat inteiro no WhatsApp.
    const ult = await query(
      `SELECT msg_id FROM movatak_conversas
        WHERE lead_id = $1 AND direcao = 'entrada' AND msg_id IS NOT NULL AND msg_id <> ''
        ORDER BY criado_em DESC LIMIT 1`,
      [leadId]
    );
    const msgId = ult.rows[0] && ult.rows[0].msg_id;
    if (!msgId) return;                       // nada recebido com id — nada a marcar
    if (msgId === row.zap_lido_msg_id) return; // já marcamos leitura desse inbound — anti-spam

    await zapiLerMensagem(row.zapi_instance, row.zapi_token, row.zapi_client_token, alvo, msgId).catch(() => null);
    await zapiModificarChat(row.zapi_instance, row.zapi_token, row.zapi_client_token, alvo, 'read').catch(() => null);
    await query(`UPDATE movatak_leads SET zap_lido_msg_id = $1 WHERE id = $2`, [msgId, leadId]).catch(() => null);
  } catch (e) {
    console.error('[leitura][zap-lido] falha ao marcar lido no WhatsApp:', e.message);
  }
}

async function marcarChatNaoLidoNoZap(leadId) {
  try {
    const r = await query(
      `SELECT l.telefone, l.chat_lid, c.zapi_instance, c.zapi_token, c.zapi_client_token
         FROM movatak_leads l JOIN movatak_clientes c ON c.id = l.cliente_id
        WHERE l.id = $1`,
      [leadId]
    );
    const row = r.rows[0];
    if (!row || !row.zapi_instance) return;
    const alvo = alvoZap(row);
    if (!alvo) return;
    await zapiModificarChat(row.zapi_instance, row.zapi_token, row.zapi_client_token, alvo, 'unread');
    // Resetar o marcador: ao voltar a NÃO-LIDA, uma futura leitura deve disparar de novo.
    await query(`UPDATE movatak_leads SET zap_lido_msg_id = NULL WHERE id = $1`, [leadId]).catch(() => null);
  } catch (e) {
    console.error('[leitura][zap-nao-lido] falha ao marcar não-lido no WhatsApp:', e.message);
  }
}

module.exports = { marcarChatLidoNoZap, marcarChatNaoLidoNoZap };
