'use strict';

// ============================================================
// Disparo em massa para leads de uma coluna do kanban.
// Reusa: envio.js (por lead), fila com worker no cron (padrão da cobrança).
// Travas anti-ban (o "pior cliente"): piso de intervalo + jitter, teto diário
// por número, opt-out/supressão, só leads da própria base, dedup.
// ============================================================

const { query } = require('./db');
const envio = require('./envio');
const { registrarConversa } = require('./leads');

const INTERVALO_MIN_SEG = 8;    // piso-duro de plataforma (anti-ban)
const TETO_DIA_MAX = 300;       // teto-duro por número/dia (acima do editável)
const TETO_DIA_DEFAULT = 250;

let _processando = false;       // mutex do worker (evita reentrada do cron)

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ±25% de variação no intervalo — cara de humano, não de robô. (Node do servidor:
// Math.random é permitido; a restrição vale só p/ scripts de workflow.)
function jitter(baseSeg) {
  const f = 0.75 + Math.random() * 0.5;
  return Math.max(INTERVALO_MIN_SEG, Math.round(baseSeg * f));
}

// Brasil = UTC-3 (sem horário de verão desde 2019).
function agoraBRT() { return new Date(Date.now() - 3 * 3600 * 1000); }

function dentroDaJanela(d) {
  const b = agoraBRT();
  const dias = String(d.dias_semana || '1,2,3,4,5,6')
    .split(',').map(s => parseInt(s, 10)).filter(n => !isNaN(n));
  if (dias.length && !dias.includes(b.getUTCDay())) return false; // 0=dom..6=sáb
  const h = b.getUTCHours();
  const ini = Number.isInteger(d.janela_inicio) ? d.janela_inicio : 8;
  const fim = Number.isInteger(d.janela_fim) ? d.janela_fim : 20;
  return h >= ini && h < fim;
}

// Cria um disparo: valida, tira um snapshot dos leads da coluna e enfileira.
async function criarDisparo(clienteId, dados = {}) {
  const coluna_id = parseInt(dados.coluna_id, 10);
  if (!coluna_id) throw new Error('Escolha a coluna do kanban de destino.');

  const tipo = ['texto', 'imagem', 'video', 'audio', 'documento'].includes(dados.tipo) ? dados.tipo : 'texto';
  const texto = (dados.texto || '').toString();
  const midia_url = dados.midia_url || null;
  if (tipo === 'texto' && !texto.trim()) throw new Error('Escreva a mensagem.');
  if (tipo !== 'texto' && !midia_url) throw new Error('Anexe o arquivo de mídia.');

  const intervalo = Math.max(INTERVALO_MIN_SEG, parseInt(dados.intervalo_seg, 10) || 12);
  const teto = Math.min(TETO_DIA_MAX, Math.max(1, parseInt(dados.teto_dia, 10) || TETO_DIA_DEFAULT));
  const jIni = (dados.janela_inicio !== undefined && dados.janela_inicio !== null && dados.janela_inicio !== '')
    ? Math.max(0, Math.min(23, parseInt(dados.janela_inicio, 10) || 0)) : 8;
  const jFim = (dados.janela_fim !== undefined && dados.janela_fim !== null && dados.janela_fim !== '')
    ? Math.max(1, Math.min(24, parseInt(dados.janela_fim, 10) || 20)) : 20;
  const dias = (dados.dias_semana && String(dados.dias_semana).trim()) || '1,2,3,4,5,6';
  const agendado = dados.agendado_para ? new Date(dados.agendado_para) : null;
  const status = (agendado && !isNaN(agendado.getTime())) ? 'agendado' : 'em_andamento';

  // Snapshot: só WhatsApp com telefone, não arquivado e não opt-out.
  const leads = await query(
    `SELECT l.id, l.telefone FROM movatak_leads l
      WHERE l.cliente_id = $1 AND l.funil_coluna_id = $2
        AND l.telefone IS NOT NULL AND l.telefone <> ''
        AND COALESCE(l.arquivado, false) = false
        AND NOT EXISTS (SELECT 1 FROM movatak_optout o WHERE o.cliente_id = l.cliente_id AND o.telefone = l.telefone)`,
    [clienteId, coluna_id]
  );
  if (!leads.rows.length) throw new Error('Nenhum lead válido nessa coluna (precisa ter telefone, não estar arquivado nem em opt-out).');

  const ins = await query(
    `INSERT INTO movatak_disparos
       (cliente_id, nome, coluna_id, tipo, texto, midia_url, midia_nome, intervalo_seg,
        janela_inicio, janela_fim, dias_semana, agendado_para, teto_dia, status, total)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [clienteId, (dados.nome || 'Disparo').toString().slice(0, 120), coluna_id, tipo, texto, midia_url,
      dados.midia_nome || null, intervalo, jIni, jFim, dias,
      (status === 'agendado') ? agendado : null, teto, status, leads.rows.length]
  );
  const disparoId = ins.rows[0].id;

  for (const l of leads.rows) {
    await query(
      `INSERT INTO movatak_disparo_fila (disparo_id, cliente_id, lead_id, telefone, status)
       VALUES ($1,$2,$3,$4,'pendente') ON CONFLICT (disparo_id, lead_id) DO NOTHING`,
      [disparoId, clienteId, l.id, l.telefone]
    ).catch(() => null);
  }
  return { id: disparoId, total: leads.rows.length, status };
}

async function enviarPorTipo(conta, lead, d) {
  switch (d.tipo) {
    case 'imagem':    return envio.enviarImagem(conta, lead, d.midia_url, d.texto || '');
    case 'video':     return envio.enviarVideo(conta, lead, d.midia_url, d.texto || '');
    case 'audio':     return envio.enviarAudio(conta, lead, d.midia_url);
    case 'documento': return envio.enviarDocumento(conta, lead, d.midia_url, d.midia_nome || 'arquivo', d.texto || '', String(d.midia_nome || '').split('.').pop() || '');
    default:          return envio.enviarMensagem(conta, lead, d.texto || '');
  }
}

// Worker do cron: manda os pendentes respeitando janela, throttle, teto e opt-out.
async function processarDisparoFila() {
  if (_processando) return;
  _processando = true;
  try {
    // Ativa os agendados cuja hora chegou.
    await query(`UPDATE movatak_disparos SET status='em_andamento', atualizado_em=NOW()
                  WHERE status='agendado' AND agendado_para IS NOT NULL AND agendado_para <= NOW()`).catch(() => null);

    const disparos = await query(`SELECT * FROM movatak_disparos WHERE status='em_andamento' ORDER BY criado_em ASC`);
    const inicioTick = Date.now();

    for (const d of disparos.rows) {
      if (!dentroDaJanela(d)) continue; // fora do horário → espera a próxima janela

      const cli = await query('SELECT id, zapi_instance, zapi_token, zapi_client_token FROM movatak_clientes WHERE id=$1', [d.cliente_id]);
      const conta = cli.rows[0];
      if (!conta || !conta.zapi_instance) continue;

      const usados = await query(
        `SELECT count(*)::int AS n FROM movatak_disparo_fila
          WHERE disparo_id=$1 AND status='enviado' AND enviado_em >= date_trunc('day', NOW())`, [d.id]);
      let restanteDia = Math.max(0, (d.teto_dia || TETO_DIA_DEFAULT) - (usados.rows[0].n || 0));
      const intervalo = Math.max(INTERVALO_MIN_SEG, d.intervalo_seg || 12);

      // Pacing pelo intervalo, sem estourar o tick (~55s) — o próximo tick continua.
      while (restanteDia > 0 && (Date.now() - inicioTick) < 55000) {
        const st = await query('SELECT status FROM movatak_disparos WHERE id=$1', [d.id]);
        if (!st.rows.length || st.rows[0].status !== 'em_andamento') break; // pausado/cancelado
        if (!dentroDaJanela(d)) break;

        const prox = await query(
          `SELECT id, lead_id, telefone FROM movatak_disparo_fila
            WHERE disparo_id=$1 AND status='pendente' ORDER BY id ASC LIMIT 1`, [d.id]);
        if (!prox.rows.length) {
          await query(`UPDATE movatak_disparos SET status='concluido', atualizado_em=NOW() WHERE id=$1`, [d.id]).catch(() => null);
          break;
        }
        const item = prox.rows[0];

        // Opt-out em tempo real (o lead pode ter pedido pra sair depois do snapshot).
        const opt = await query('SELECT 1 FROM movatak_optout WHERE cliente_id=$1 AND telefone=$2 LIMIT 1', [d.cliente_id, item.telefone]);
        if (opt.rows.length) {
          await query(`UPDATE movatak_disparo_fila SET status='pulado', erro='opt-out' WHERE id=$1`, [item.id]).catch(() => null);
          continue;
        }

        try {
          const lead = { id: item.lead_id, telefone: item.telefone, canal: 'whatsapp' };
          await enviarPorTipo(conta, lead, d);
          await query(`UPDATE movatak_disparo_fila SET status='enviado', enviado_em=NOW() WHERE id=$1`, [item.id]);
          await query(`UPDATE movatak_disparos SET enviados=enviados+1, atualizado_em=NOW() WHERE id=$1`, [d.id]).catch(() => null);
          const conteudoLog = d.tipo === 'texto' ? d.texto : ('[disparo ' + d.tipo + ']' + (d.texto ? ': ' + d.texto : ''));
          await registrarConversa(item.lead_id, d.cliente_id, 'saida', conteudoLog,
            d.tipo !== 'texto' ? d.midia_url : null, d.tipo !== 'texto' ? d.tipo : null, null, null, 'disparo').catch(() => null);
          restanteDia--;
        } catch (e) {
          await query(`UPDATE movatak_disparo_fila SET status='erro', erro=$2 WHERE id=$1`, [item.id, String(e.message || e).slice(0, 300)]).catch(() => null);
          await query(`UPDATE movatak_disparos SET erros=erros+1, atualizado_em=NOW() WHERE id=$1`, [d.id]).catch(() => null);
        }
        await sleep(jitter(intervalo) * 1000);
      }
    }
  } catch (e) {
    console.error('[disparo] worker erro:', e.message);
  } finally {
    _processando = false;
  }
}

async function controlarDisparo(clienteId, disparoId, acao) {
  const map = { pausar: 'pausado', retomar: 'em_andamento', cancelar: 'cancelado' };
  const novo = map[acao];
  if (!novo) throw new Error('Ação inválida.');
  const r = await query(
    `UPDATE movatak_disparos SET status=$1, atualizado_em=NOW()
      WHERE id=$2 AND cliente_id=$3 AND status <> 'concluido' AND status <> 'cancelado' RETURNING id, status`,
    [novo, disparoId, clienteId]);
  if (!r.rows.length) throw new Error('Disparo não encontrado ou já finalizado.');
  if (acao === 'cancelar') {
    await query(`UPDATE movatak_disparo_fila SET status='cancelado' WHERE disparo_id=$1 AND status='pendente'`, [disparoId]).catch(() => null);
  }
  return r.rows[0];
}

async function listarDisparos(clienteId) {
  const r = await query(
    `SELECT d.id, d.nome, d.coluna_id, d.tipo, d.status, d.total, d.enviados, d.erros,
            d.intervalo_seg, d.agendado_para, d.criado_em, c.nome AS coluna_nome,
            (SELECT count(*)::int FROM movatak_disparo_fila f WHERE f.disparo_id=d.id AND f.status='pendente') AS pendentes
       FROM movatak_disparos d
       LEFT JOIN movatak_funil_colunas c ON c.id = d.coluna_id
      WHERE d.cliente_id=$1 ORDER BY d.criado_em DESC LIMIT 50`, [clienteId]);
  return r.rows;
}

// Opt-out: registra supressão quando o lead pede pra sair (chamado do webhook inbound).
const OPTOUT_PALAVRAS = ['sair', 'parar', 'pare', 'cancelar', 'descadastrar', 'remover', 'stop', 'nao quero', 'não quero'];
async function registrarOptOutSeAplicavel(clienteId, telefone, texto) {
  try {
    if (!clienteId || !telefone) return;
    const t = String(texto || '').trim().toLowerCase();
    if (!t || t.length > 40) return; // opt-out é mensagem curta ("sair", "parar")
    if (!OPTOUT_PALAVRAS.some(p => t === p || t === p + '!' || t === p + '.')) return;
    await query(
      `INSERT INTO movatak_optout (cliente_id, telefone) VALUES ($1,$2)
       ON CONFLICT (cliente_id, telefone) DO NOTHING`, [clienteId, telefone]).catch(() => null);
    // Para os disparos pendentes desse lead imediatamente.
    await query(
      `UPDATE movatak_disparo_fila SET status='pulado', erro='opt-out'
        WHERE cliente_id=$1 AND telefone=$2 AND status='pendente'`, [clienteId, telefone]).catch(() => null);
  } catch (e) { /* silencioso */ }
}

module.exports = { criarDisparo, processarDisparoFila, controlarDisparo, listarDisparos, registrarOptOutSeAplicavel };
