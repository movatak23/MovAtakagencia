'use strict';

// ============================================================
// Ausencia — avalia janelas de indisponibilidade do cliente e
// dispara a mensagem automatica de ausencia. (movido verbatim do index.js)
// ============================================================
const { query } = require('./db');
const { zapiEnviar } = require('./zapi');
const { registrarConversa } = require('./leads');
const { ehGrupoOuCanal } = require('./util');

async function dispararAusenciaSeAplicavel(cliente, lead, telefone) {
  try {
    if (!lead) return;
    // Trava de segurança: NUNCA envia ausência para grupos ou canais do WhatsApp.
    if (ehGrupoOuCanal(telefone) || ehGrupoOuCanal(lead.telefone)) return;
    let colunaAvaliar = lead.funil_coluna_id;
    if (!colunaAvaliar) {
      const ent = await query(
        `SELECT id FROM movatak_funil_colunas
          WHERE cliente_id = $1 AND ativo = true
          ORDER BY ordem ASC, id ASC LIMIT 1`,
        [cliente.id]
      ).catch(() => ({ rows: [] }));
      if (ent.rows.length) colunaAvaliar = ent.rows[0].id;
    }
    if (!colunaAvaliar) return;

    const col = await query(
      'SELECT ausencia_ativa FROM movatak_funil_colunas WHERE id = $1',
      [colunaAvaliar]
    ).catch(() => ({ rows: [] }));
    const togglerLigado = col.rows.length && col.rows[0].ausencia_ativa;

    let deveAvisar = false, mensagemAus = '', periodoChave = '';
    if (togglerLigado) {
      mensagemAus = (cliente.ausencia_msg_padrao || '').trim();
      const hojeBRT = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
      periodoChave = 'toggle:' + hojeBRT;
      deveAvisar = !!mensagemAus;
    } else {
      const av = avaliarAusencia(cliente);
      if (av.ausente && av.mensagem) { deveAvisar = true; mensagemAus = av.mensagem; periodoChave = av.periodoChave; }
    }

    if (deveAvisar && mensagemAus) {
      const reg = await query(
        `INSERT INTO movatak_ausencia_enviada (lead_id, cliente_id, periodo_chave)
         VALUES ($1, $2, $3)
         ON CONFLICT (lead_id, periodo_chave) DO NOTHING
         RETURNING id`,
        [lead.id, cliente.id, periodoChave]
      ).catch(() => ({ rows: [] }));
      if (reg.rows.length) {
        // Aguarda a saudação de boas-vindas chegar e assentar primeiro (a Z-API pode
        // entregar fora de ordem se as mensagens saem muito próximas).
        await new Promise(r => setTimeout(r, 8000));
        const msgId = await zapiEnviar(cliente.zapi_instance, cliente.zapi_token, cliente.zapi_client_token, telefone, mensagemAus).catch(() => null);
        await registrarConversa(lead.id, cliente.id, 'saida', mensagemAus, null, null, msgId, null, 'ausencia').catch(() => null);
      }
    }
  } catch (e) {
    console.error('[ausencia] erro ao processar:', e.message);
  }
}

function avaliarAusencia(cliente) {
  const vazio = { ausente: false, mensagem: null, periodoChave: null };
  try {
    // Hora local de Brasília a partir do horário do servidor (Railway roda em UTC).
    const agora = new Date(Date.now() - 3 * 3600 * 1000);
    const ano = agora.getUTCFullYear();
    const mes = String(agora.getUTCMonth() + 1).padStart(2, '0');
    const dia = String(agora.getUTCDate()).padStart(2, '0');
    const dataHoje = `${ano}-${mes}-${dia}`;
    const diaSemana = agora.getUTCDay(); // 0=domingo
    const minutosAgora = agora.getUTCHours() * 60 + agora.getUTCMinutes();

    const paraMin = (hhmm) => {
      const [h, m] = String(hhmm || '').split(':').map(n => parseInt(n, 10));
      if (isNaN(h)) return null;
      return h * 60 + (m || 0);
    };
    // Cobre faixas que viram a meia-noite (ex: 18:00–08:00).
    const dentroFaixa = (ini, fim) => {
      if (ini === null || fim === null) return false;
      if (ini <= fim) return minutosAgora >= ini && minutosAgora < fim;
      return minutosAgora >= ini || minutosAgora < fim; // atravessa meia-noite
    };

    // 1) Datas específicas (feriados) — prioridade. Mensagem própria de cada data.
    const datas = Array.isArray(cliente.ausencia_datas) ? cliente.ausencia_datas : [];
    for (const d of datas) {
      if (d && d.data === dataHoje) {
        const ini = paraMin(d.inicio || '00:00');
        const fim = paraMin(d.fim || '23:59');
        if (dentroFaixa(ini, fim)) {
          return {
            ausente: true,
            mensagem: d.msg || cliente.ausencia_msg_padrao || '',
            periodoChave: `data:${d.data}:${d.inicio || '00:00'}-${d.fim || '23:59'}`
          };
        }
      }
    }

    // 2) Horário recorrente semanal — mensagem padrão.
    const horarios = Array.isArray(cliente.ausencia_horarios) ? cliente.ausencia_horarios : [];
    for (const h of horarios) {
      const dias = Array.isArray(h.dias) ? h.dias : [];
      if (!dias.includes(diaSemana)) continue;
      const ini = paraMin(h.inicio);
      const fim = paraMin(h.fim);
      if (dentroFaixa(ini, fim)) {
        // Chave por dia+faixa: o período "reinicia" a cada dia, permitindo novo aviso.
        return {
          ausente: true,
          mensagem: cliente.ausencia_msg_padrao || '',
          periodoChave: `sem:${dataHoje}:${h.inicio}-${h.fim}`
        };
      }
    }

    return vazio;
  } catch (e) {
    console.error('[ausencia] erro ao avaliar:', e.message);
    return vazio;
  }
}

function clienteRowEmAusencia(row) {
  if (!row) return false;
  try {
    return avaliarAusencia({
      ausencia_horarios: row.ausencia_horarios,
      ausencia_datas: row.ausencia_datas,
      ausencia_msg_padrao: row.ausencia_msg_padrao || ''
    }).ausente === true;
  } catch (e) {
    return false;
  }
}


module.exports = {
  dispararAusenciaSeAplicavel,
  avaliarAusencia,
  clienteRowEmAusencia,
};
