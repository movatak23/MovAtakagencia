'use strict';

// ============================================================
// Anti-spam / auditoria de mensagens automaticas — limites diarios
// e janelas de reentrada no follow-up. (movido verbatim do index.js)
// ============================================================
const { query } = require('./db');
const { MOVATAK_MAX_AUTO_MSG_DIA, MOVATAK_REENTRADA_FU1_HORAS } = require('./config');

async function contarMensagensAutomaticasHoje(leadId) {
  const r = await query(
    `SELECT COUNT(*)::int AS total
       FROM movatak_lead_eventos
      WHERE lead_id = $1
        AND tipo = 'mensagem_enviada'
        AND criado_em >= CURRENT_DATE`,
    [leadId]
  );
  return parseInt((r.rows[0] || {}).total || 0, 10);
}

async function podeEnviarMensagemAutomatica(leadId) {
  try {
    const total = await contarMensagensAutomaticasHoje(leadId);
    return total < MOVATAK_MAX_AUTO_MSG_DIA;
  } catch (e) {
    // Se a auditoria ainda não estiver migrada, não derruba o envio.
    console.error('[anti-spam]', e.message);
    return true;
  }
}

async function reentradaFU1Permitida(leadId) {
  try {
    const r = await query(
      `SELECT 1
         FROM movatak_lead_eventos
        WHERE lead_id = $1
          AND tipo IN ('reativado_gatilho','lead_criado','followup_reativado_manual')
          AND criado_em >= NOW() - ($2 || ' hours')::INTERVAL
        LIMIT 1`,
      [leadId, MOVATAK_REENTRADA_FU1_HORAS]
    );
    return !r.rows.length;
  } catch (e) {
    console.error('[anti-spam]', e.message);
    return true;
  }
}

async function leadRespondeuRecentemente(leadId, horas) {
  try {
    const r = await query(
      `SELECT COUNT(*)::int AS n FROM movatak_conversas
        WHERE lead_id = $1 AND direcao = 'entrada'
          AND criado_em >= NOW() - ($2 || ' hours')::INTERVAL`,
      [leadId, horas]
    );
    return (r.rows[0] ? r.rows[0].n : 0) >= 2;
  } catch (e) {
    console.error('[anti-spam][resposta-recente]', e.message);
    return false;
  }
}


module.exports = {
  contarMensagensAutomaticasHoje,
  podeEnviarMensagemAutomatica,
  reentradaFU1Permitida,
  leadRespondeuRecentemente,
};
