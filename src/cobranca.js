'use strict';

// ============================================================
// Recuperação de Carrinho / Cobrança
// Leads que receberam link de pagamento e não pagaram recebem uma régua de
// lembretes própria (texto + horário configuráveis no painel, dentro do menu de
// Follow-up). Disparada por uma PALAVRA-GATILHO que o atendente inclui na
// mensagem do link; interrompida quando o lead PAGA (vai pra etapa 'cliente') ou
// RESPONDE. Isolada do motor de follow-up pra não misturar as réguas.
// ============================================================
const { query } = require('./db');
const { zapiEnviar } = require('./zapi');
const { registrarConversa, registrarEventoLead } = require('./leads');
const { ehGrupoOuCanal } = require('./util');

// Normaliza a config vinda do banco em { gatilho, ativo, msgs:[{texto,horas}] }.
function lerConfigCobranca(cliente) {
  const raw = (cliente && cliente.cobranca_v2) || {};
  const cfg = typeof raw === 'string' ? safeJson(raw) : raw;
  const msgs = Array.isArray(cfg.msgs) ? cfg.msgs : [];
  return {
    gatilho: String(cfg.gatilho || '').trim(),
    ativo: cfg.ativo !== false, // default ligado se houver gatilho+msgs
    msgs: msgs.map(m => ({ texto: String((m && m.texto) || '').trim(), horas: Number((m && m.horas) || 0) }))
  };
}
function safeJson(s) { try { return JSON.parse(s) || {}; } catch { return {}; } }

// A mensagem de saída do atendente contém a palavra-gatilho de cobrança?
function textoDisparaCobranca(texto, cliente) {
  const cfg = lerConfigCobranca(cliente);
  if (!cfg.ativo || !cfg.gatilho) return false;
  if (!cfg.msgs.some(m => m.texto)) return false;
  const t = String(texto || '').toLowerCase();
  return t.includes(cfg.gatilho.toLowerCase());
}

// Agenda (ou reinicia) a régua de cobrança para um lead. Limpa a fila pendente
// anterior pra não duplicar quando o gatilho é disparado de novo.
async function agendarCobranca(cliente, lead) {
  const cfg = lerConfigCobranca(cliente);
  if (!cfg.ativo || !cfg.msgs.some(m => m.texto)) return;
  if (!lead || !lead.id) return;

  // Debounce anti-loop: se a régua foi (re)agendada nos últimos 2 min, ignora. Evita
  // que o eco fromMe de uma mensagem de cobrança que por acaso contenha a palavra-
  // gatilho reinicie a régua em loop.
  const recente = await query(
    `SELECT 1 FROM movatak_cobranca_fila WHERE lead_id=$1 AND criado_em > NOW() - INTERVAL '2 minutes' LIMIT 1`,
    [lead.id]
  ).catch(() => ({ rows: [] }));
  if (recente.rows.length) { console.log(`[cobranca] debounce — régua já agendada há pouco, ignora -> lead ${lead.id}`); return; }

  await query(`UPDATE movatak_cobranca_fila SET status='cancelado' WHERE lead_id=$1 AND status='pendente'`, [lead.id]).catch(() => null);

  const nome = (lead.nome && !String(lead.nome).includes('@lid')) ? String(lead.nome).split(' ')[0] : 'Lead';
  let agendadas = 0;
  for (let i = 0; i < cfg.msgs.length; i++) {
    const m = cfg.msgs[i];
    if (!m.texto) continue;
    const texto = m.texto.replace(/{nome}/g, nome);
    await query(
      `INSERT INTO movatak_cobranca_fila (cliente_id, lead_id, etapa_seq, mensagem, proximo_envio, status)
       VALUES ($1, $2, $3, $4, NOW() + ($5 || ' hours')::interval, 'pendente')`,
      [cliente.id, lead.id, i + 1, texto, String(Math.max(0, m.horas))]
    ).catch(e => console.error('[cobranca][agendar] erro:', e.message));
    agendadas++;
  }
  if (agendadas) {
    await registrarEventoLead(lead.id, cliente.id, 'cobranca_agendada', `Régua de cobrança agendada (${agendadas} lembrete(s))`, { gatilho: cfg.gatilho }).catch(() => null);
    console.log(`[cobranca] régua agendada -> lead ${lead.id} (${agendadas} msgs)`);
  }
}

// Cancela a cobrança pendente do lead (pagou ou respondeu).
async function cancelarCobrancaLead(leadId, motivo) {
  if (!leadId) return 0;
  const r = await query(`UPDATE movatak_cobranca_fila SET status='cancelado' WHERE lead_id=$1 AND status='pendente' RETURNING id`, [leadId]).catch(() => ({ rows: [] }));
  const n = (r && r.rows) ? r.rows.length : 0;
  if (n) console.log(`[cobranca] régua cancelada (${motivo || 'sem motivo'}) -> lead ${leadId} (${n} pendente(s))`);
  return n;
}

// Cron: dispara os lembretes de cobrança vencidos.
async function processarCobrancaFila() {
  const r = await query(
    `SELECT f.*, l.telefone, l.etapa, l.arquivado,
            c.zapi_instance, c.zapi_token, c.zapi_client_token
       FROM movatak_cobranca_fila f
       JOIN movatak_leads l ON l.id = f.lead_id
       JOIN movatak_clientes c ON c.id = f.cliente_id
      WHERE f.status = 'pendente'
        AND f.proximo_envio <= NOW()
        -- anti-spam: nunca dispara lembrete vencido há mais de 7 dias
        AND f.proximo_envio > NOW() - INTERVAL '7 days'
      ORDER BY f.proximo_envio ASC
      LIMIT 200`,
    []
  ).catch(e => { console.error('[cobranca][cron] erro select:', e.message); return { rows: [] }; });

  for (const row of r.rows) {
    try {
      // Trava: se o lead já é cliente (pagou), grupo, ou arquivado — cancela e segue.
      if (row.etapa === 'cliente' || row.arquivado || ehGrupoOuCanal(row.telefone) || !row.telefone) {
        await query(`UPDATE movatak_cobranca_fila SET status='cancelado' WHERE lead_id=$1 AND status='pendente'`, [row.lead_id]).catch(() => null);
        continue;
      }
      await zapiEnviar(row.zapi_instance, row.zapi_token, row.zapi_client_token, row.telefone, row.mensagem);
      await query(`UPDATE movatak_cobranca_fila SET status='enviado', enviado_em=NOW(), erro_envio=NULL WHERE id=$1`, [row.id]);
      registrarConversa(row.lead_id, row.cliente_id, 'saida', row.mensagem || '', null, null, null, null, 'cobranca').catch(() => null);
      await registrarEventoLead(row.lead_id, row.cliente_id, 'cobranca_enviada', `Lembrete de cobrança ${row.etapa_seq} enviado`, { fila_id: row.id }).catch(() => null);
      console.log(`[cobranca] lembrete ${row.etapa_seq} enviado -> lead ${row.lead_id}`);
    } catch (e) {
      await query(`UPDATE movatak_cobranca_fila SET erro_envio=$1 WHERE id=$2`, [String(e.message || e).slice(0, 500), row.id]).catch(() => null);
      console.error(`[cobranca] erro ao enviar fila ${row.id} lead ${row.lead_id}:`, e.message);
    }
  }
}

module.exports = {
  lerConfigCobranca,
  textoDisparaCobranca,
  agendarCobranca,
  cancelarCobrancaLead,
  processarCobrancaFila,
};
