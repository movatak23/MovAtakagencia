'use strict';

// ============================================================
// Follow-ups (motor de agendamento/disparo FU1/FU2)
// (movido verbatim do index.js na Fase 3d)
// ============================================================
const { query } = require('./db');
const { registrarEventoLead, registrarConversa } = require('./leads');
const { zapiEnviar } = require('./zapi');

// Deps ainda no index.js, injetadas no boot via init() (ausencia, funil, o
// cluster anti-spam e registrarErroZapi saem em fases futuras). O corpo movido
// as referencia por variavel de escopo do modulo, entao fica byte-a-byte
// identico ao original.
let ehGrupoOuCanal, clienteRowEmAusencia, moverLeadParaColunaFunil,
    podeEnviarMensagemAutomatica, registrarErroZapi;
function init(deps) {
  ({ ehGrupoOuCanal, clienteRowEmAusencia, moverLeadParaColunaFunil,
     podeEnviarMensagemAutomatica, registrarErroZapi } = deps);
}

function followupDataDaLinha(row) {
  return row.template_followup_v2 || row.followup_msgs_v2 || {};
}

const DIAS_FOLLOWUP_V2 = {
  fu1: { 1: 0, 2: 0 },
  fu2: { 1: 0, 2: 1, 3: 3 }
};

async function agendarFollowupV2(leadId, clienteId, sequenciaFu, limparFila = true) {
  const chave = 'fu' + sequenciaFu;
  const diasPorMensagem = DIAS_FOLLOWUP_V2[chave];

  if (!diasPorMensagem) {
    throw new Error('Sequencia de follow-up invalida: ' + sequenciaFu);
  }

  if (limparFila) {
    await query('DELETE FROM movatak_followup WHERE lead_id = $1', [leadId]);
  }

  const agora = new Date();

  for (const [etapa, dias] of Object.entries(diasPorMensagem)) {
    const proximo = new Date(agora);
    proximo.setDate(proximo.getDate() + dias);

    await query(
      `INSERT INTO movatak_followup
         (lead_id, cliente_id, etapa_seq, proximo_envio, status, sequencia_fu, data_entrada)
       VALUES ($1, $2, $3, $4, 'pendente', $5, $6)`,
      [leadId, clienteId, parseInt(etapa), proximo.toISOString(), sequenciaFu, agora.toISOString()]
    );
  }

  await registrarEventoLead(
    leadId,
    clienteId,
    'followup_agendado',
    `FU${sequenciaFu} agendado`,
    { sequencia_fu: sequenciaFu, limpar_fila: limparFila }
  );
  // Reentrou no follow-up → volta a ser elegível para a finalização pós-FU.
  await query('UPDATE movatak_leads SET pos_followup_finalizado = false WHERE id = $1', [leadId]).catch(() => null);
}

async function enviarFollowupsPendentesDoLead(leadId, apenasSequenciaFu = null) {
  const params = [leadId];
  let filtroSequencia = '';

  if (apenasSequenciaFu !== null && apenasSequenciaFu !== undefined) {
    params.push(apenasSequenciaFu);
    filtroSequencia = ` AND COALESCE(f.sequencia_fu, 1) = $2`;
  }

  const r = await query(
    `SELECT f.*, l.telefone, l.nome, l.etapa,
            c.zapi_instance, c.zapi_token, c.zapi_client_token, c.followup_msgs_v2,
            c.ausencia_horarios, c.ausencia_datas, c.ausencia_msg_padrao,
            camp.id AS campanha_id, camp.nome AS campanha_nome,
            t.followup_v2 AS template_followup_v2, t.nome AS template_nome_debug
       FROM movatak_followup f
       JOIN movatak_leads l ON l.id = f.lead_id
       JOIN movatak_clientes c ON c.id = f.cliente_id
       LEFT JOIN movatak_campanhas camp ON camp.id = l.campanha_id
       LEFT JOIN movatak_followup_templates t
              ON t.id = COALESCE(camp.template_id, l.template_id_origem) AND t.ativo = true
      WHERE f.lead_id = $1
        AND f.status = 'pendente'
        AND f.proximo_envio <= NOW()
        -- Trava anti-spam: nunca dispara follow-up vencido há mais de 7 dias (backlog
        -- antigo/parado). Não apaga a linha — só não envia mensagem velha fora de hora.
        AND f.proximo_envio > NOW() - INTERVAL '7 days'
        ${filtroSequencia}
      ORDER BY COALESCE(f.sequencia_fu, 1), f.etapa_seq`,
    params
  );

  if (!r.rows.length) {
    console.log(`[followup][imediato] nenhuma mensagem pendente para lead ${leadId}`);
    return;
  }

  for (const row of r.rows) {
    try {
      // Trava de segurança: nunca envia follow-up para grupos ou canais.
      if (ehGrupoOuCanal(row.telefone)) {
        await query(`UPDATE movatak_followup SET status='cancelado' WHERE id=$1`, [row.id]).catch(() => null);
        continue;
      }
      if (row.etapa !== 'followup') {
        console.log(`[followup][imediato] lead ${leadId} ignorado porque etapa=${row.etapa}`);
        continue;
      }

      const fuData = followupDataDaLinha(row);
      const seqKey = 'fu' + (row.sequencia_fu || 1);
      const msgs = fuData[seqKey] || {};
      const msgText = msgs['msg' + row.etapa_seq];
      const templateFonte = row.template_followup_v2 ? `template:${row.template_nome_debug}` : 'cliente:followup_msgs_v2';
      console.log(`[imediato][fu] lead=${leadId} campanha=${row.campanha_nome||'—'} fonte=${templateFonte} seq=${seqKey} etapa=${row.etapa_seq}`);

      if (!msgText || !String(msgText).trim()) {
        await query(`UPDATE movatak_followup SET status = 'enviado', enviado_em = NOW() WHERE id = $1`, [row.id]);
        console.log(`[followup][imediato] FU${row.sequencia_fu || 1} msg${row.etapa_seq} vazia; marcada como enviada -> lead ${leadId}`);
        continue;
      }

      const msg = String(msgText).replace(/{nome}/g, row.nome || 'Lead');

      // Pausa de ausência: não dispara follow-up enquanto o cliente está fora do
      // horário de atendimento. A linha continua 'pendente' e o cron reavalia depois;
      // assim o FU só sai quando o expediente volta (humano qualifica o lead antes).
      if (clienteRowEmAusencia(row)) {
        console.log(`[followup][imediato] FU${row.sequencia_fu || 1} msg${row.etapa_seq} adiado: cliente em ausência -> lead ${leadId}`);
        continue;
      }

      if (!(await podeEnviarMensagemAutomatica(leadId))) {
        await query(`UPDATE movatak_followup SET status = 'pausado', erro_envio = 'limite anti-spam diario atingido' WHERE id = $1`, [row.id]);
        await registrarEventoLead(leadId, row.cliente_id, 'anti_spam', 'Mensagem automática pausada por limite diário', { followup_id: row.id });
        console.log(`[anti-spam] limite diario atingido -> lead ${leadId}`);
        continue;
      }

      await zapiEnviar(
        row.zapi_instance,
        row.zapi_token,
        row.zapi_client_token,
        row.telefone,
        msg
      );

      await query(
        `UPDATE movatak_followup
            SET status = 'enviado', enviado_em = NOW(), erro_envio = NULL, tentativas_envio = COALESCE(tentativas_envio, 0) + 1
          WHERE id = $1`,
        [row.id]
      );
      registrarConversa(leadId, row.cliente_id, 'saida', msg || '', null, null, null, null, 'followup').catch(() => null);
      await registrarEventoLead(
        leadId,
        row.cliente_id,
        'mensagem_enviada',
        `FU${row.sequencia_fu || 1} msg${row.etapa_seq} enviada`,
        { followup_id: row.id, sequencia_fu: row.sequencia_fu || 1, etapa_seq: row.etapa_seq }
      );
      console.log(`[followup][imediato] FU${row.sequencia_fu || 1} msg${row.etapa_seq} enviada -> lead ${leadId}`);
    } catch (e) {
      await query(
        `UPDATE movatak_followup
            SET erro_envio = $1, tentativas_envio = COALESCE(tentativas_envio, 0) + 1
          WHERE id = $2`,
        [String(e.message || e).slice(0, 500), row.id]
      ).catch(() => null);
      await registrarErroZapi(row.cliente_id, e.message, { lead_id: leadId, followup_id: row.id });
      await registrarEventoLead(leadId, row.cliente_id, 'erro_envio', 'Erro ao enviar mensagem de follow-up', { erro: e.message, followup_id: row.id });
      console.error(`[followup][imediato] erro ao enviar lead ${leadId} fila ${row.id}:`, e.message);
      // Não marca como enviado. O cron tentará reenviar depois.
    }
  }
}

async function migrarFU1ParaFU2() {
  const r = await query(
    `SELECT DISTINCT l.id AS lead_id, l.cliente_id
     FROM movatak_leads l
     JOIN movatak_followup f ON f.lead_id = l.id
     WHERE l.etapa = 'followup'
       AND COALESCE(f.sequencia_fu, 1) = 1
       -- FU1 totalmente processado: nenhuma mensagem do FU1 ainda pendente.
       -- (durante a ausência o FU1 fica pendente, então a migração não avança e o lead não pula o FU1)
       AND NOT EXISTS (
         SELECT 1 FROM movatak_followup fp
         WHERE fp.lead_id = l.id
           AND COALESCE(fp.sequencia_fu, 1) = 1
           AND fp.status = 'pendente'
       )
       -- Conta 1h a partir do ÚLTIMO FU1 realmente enviado (não da entrada do lead),
       -- pra respeitar o intervalo mesmo quando o FU1 foi adiado por ausência.
       AND (
         SELECT MAX(fe.enviado_em)
         FROM movatak_followup fe
         WHERE fe.lead_id = l.id
           AND COALESCE(fe.sequencia_fu, 1) = 1
           AND fe.status = 'enviado'
       ) <= NOW() - INTERVAL '1 hour'
       AND NOT EXISTS (
         SELECT 1 FROM movatak_followup f2
         WHERE f2.lead_id = l.id
           AND f2.sequencia_fu = 2
           AND f2.status = 'pendente'
       )`,
    []
  );

  for (const row of r.rows) {
    await query('DELETE FROM movatak_followup WHERE lead_id = $1 AND COALESCE(sequencia_fu, 1) = 1', [row.lead_id]);
    await agendarFollowupV2(row.lead_id, row.cliente_id, 2, false);
    await registrarEventoLead(row.lead_id, row.cliente_id, 'migrado_fu2', 'Lead migrou automaticamente do FU1 para o FU2 após 1h sem resposta');
    console.log(`[cron] FU1 -> FU2 migrado -> lead ${row.lead_id}`);
  }
}

async function finalizarFollowupsEsgotados() {
  const r = await query(
    `SELECT l.id AS lead_id, l.cliente_id, c.pos_followup_acao, c.pos_followup_coluna_id
       FROM movatak_leads l
       JOIN movatak_clientes c ON c.id = l.cliente_id
      WHERE l.etapa = 'followup'
        AND NOT COALESCE(l.pos_followup_finalizado, false)
        AND COALESCE(c.pos_followup_acao, 'nenhum') <> 'nenhum'
        AND EXISTS (SELECT 1 FROM movatak_followup f WHERE f.lead_id = l.id AND f.sequencia_fu = 2)
        AND NOT EXISTS (SELECT 1 FROM movatak_followup f WHERE f.lead_id = l.id AND f.status = 'pendente')
        AND (
          SELECT MAX(f.enviado_em) FROM movatak_followup f
           WHERE f.lead_id = l.id AND f.status = 'enviado'
        ) <= NOW() - INTERVAL '24 hours'
      LIMIT 200`
  ).catch(() => ({ rows: [] }));

  for (const row of r.rows) {
    try {
      if (row.pos_followup_acao === 'mover' && row.pos_followup_coluna_id) {
        await moverLeadParaColunaFunil(row.lead_id, row.pos_followup_coluna_id, true);
      } else if (row.pos_followup_acao === 'descartar') {
        await query(`UPDATE movatak_leads SET etapa='descartado', atualizado_em=NOW() WHERE id=$1`, [row.lead_id]);
        await query(`UPDATE movatak_followup SET status='pausado' WHERE lead_id=$1 AND status='pendente'`, [row.lead_id]).catch(() => null);
        await registrarEventoLead(row.lead_id, row.cliente_id, 'pos_followup_descartado', 'Descartado automaticamente após o follow-up sem resposta', {}).catch(() => null);
      } else {
        continue; // 'mover' sem coluna definida → não faz nada
      }
      await query('UPDATE movatak_leads SET pos_followup_finalizado = true, atualizado_em = NOW() WHERE id = $1', [row.lead_id]);
      console.log(JSON.stringify({ tipo: 'pos_followup', lead_id: row.lead_id, acao: row.pos_followup_acao, coluna_id: row.pos_followup_coluna_id || null }));
    } catch (e) {
      console.error('[pos-fu] erro ao finalizar lead', row.lead_id, e.message);
    }
  }
}


module.exports = {
  init,
  followupDataDaLinha,
  agendarFollowupV2,
  enviarFollowupsPendentesDoLead,
  migrarFU1ParaFU2,
  finalizarFollowupsEsgotados,
};
