'use strict';

const express = require('express');
const { Pool } = require('pg');
const cron = require('node-cron');
const axios = require('axios');

const path = require('path');
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-movatak-secret, x-app-token');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// Banco de dados
// ============================================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function query(sql, params) {
  const client = await pool.connect();
  try {
    const res = await client.query(sql, params);
    return res;
  } finally {
    client.release();
  }
}

// ============================================================
// Autenticação do painel Movatak (suas rotas internas)
// ============================================================
function authMovatak(req, res, next) {
  const secret = req.headers['x-movatak-secret'];
  if (secret !== process.env.MOVATAK_SECRET) {
    return res.status(401).json({ error: 'Nao autorizado.' });
  }
  next();
}

// Autenticação do app do cliente (acesso somente leitura)
async function authCliente(req, res, next) {
  const token = req.headers['x-app-token'];
  if (!token) return res.status(401).json({ error: 'Token ausente.' });
  try {
    const r = await query(
      'SELECT id FROM movatak_clientes WHERE app_token = $1 AND ativo = true',
      [token]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'Token invalido.' });
    req.clienteId = r.rows[0].id;
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ============================================================
// Z-API — helpers
// ============================================================
const ZAPI_BASE = 'https://api.z-api.io/instances';

async function zapiEnviar(instance, token, clientToken, telefone, mensagem) {
  const url = `${ZAPI_BASE}/${instance}/token/${token}/send-text`;
  await axios.post(url, { phone: telefone, message: mensagem }, {
    headers: { 'Client-Token': clientToken }
  });
}

async function zapiEtiquetar(instance, token, clientToken, telefone, label) {
  const url = `${ZAPI_BASE}/${instance}/token/${token}/label-contact`;
  await axios.post(url, { phone: telefone, labelName: label }, {
    headers: { 'Client-Token': clientToken }
  });
}

// ============================================================
// Mensagens de follow up por etapa
// ============================================================
const MSGS_FOLLOWUP = {
  1: (nome) => `Oi${nome ? ' ' + nome : ''}! Tudo bem? Passei aqui pra saber se ficou alguma dúvida sobre o que conversamos. Estou à disposição!`,
  2: (nome) => `${nome || 'Olá'}! Só reforçando que ainda temos disponibilidade pra você. Se quiser retomar a conversa, é só chamar aqui.`,
  3: (_) => `Ei! Não quero ser chato, mas queria dar uma última passada antes de seguir em frente. Tem algo que posso esclarecer pra facilitar sua decisão?`,
  4: (_) => `Último recado da minha parte! Se em algum momento fizer sentido retomar, estarei aqui. Abraço!`
};

const DIAS_FOLLOWUP = { 1: 1, 2: 3, 3: 7, 4: 14 };

// ============================================================
// ROTA 1 — Webhook de mensagem recebida
// Z-API → POST /webhook/mensagem
// ============================================================
app.post('/movatak/webhook/mensagem', async (req, res) => {
  try {
    const { phone, text, senderName } = req.body;
    if (!phone || !text) return res.json({ ok: true });

    const mensagem = (text || '').trim().toLowerCase();
    const telefone = phone.replace(/\D/g, '');

    // Buscar cliente com trigger que bate com a mensagem
    const r = await query(
      `SELECT * FROM movatak_clientes WHERE ativo = true AND $1 ILIKE '%' || trigger_msg || '%'`,
      [mensagem]
    );
    if (!r.rows.length) return res.json({ ok: true });

    const cliente = r.rows[0];

    // Verificar se lead já existe para evitar duplicata
    const existe = await query(
      'SELECT id FROM movatak_leads WHERE cliente_id = $1 AND telefone = $2',
      [cliente.id, telefone]
    );
    if (existe.rows.length) return res.json({ ok: true });

    // Criar lead
    await query(
      `INSERT INTO movatak_leads (cliente_id, telefone, nome, etapa)
       VALUES ($1, $2, $3, 'lead')`,
      [cliente.id, telefone, senderName || null]
    );

    // Etiquetar no WhatsApp
    await zapiEtiquetar(
      cliente.zapi_instance,
      cliente.zapi_token,
      cliente.zapi_client_token,
      telefone,
      'Lead'
    );

    res.json({ ok: true });
  } catch (e) {
    console.error('[webhook/mensagem]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// ROTA 2 — Webhook de etiqueta aplicada
// Z-API → POST /webhook/etiqueta
// ============================================================
app.post('/movatak/webhook/etiqueta', async (req, res) => {
  try {
    // Payload Z-API label_association
    const { phone, label, instanceId } = req.body;
    if (!phone || !label) return res.json({ ok: true });

    const telefone = phone.replace(/\D/g, '');
    const etiqueta = (label || '').toLowerCase();

    // Buscar cliente pela instância
    const rc = await query(
      'SELECT * FROM movatak_clientes WHERE zapi_instance = $1 AND ativo = true',
      [instanceId]
    );
    if (!rc.rows.length) return res.json({ ok: true });

    const cliente = rc.rows[0];

    // Buscar lead
    const rl = await query(
      'SELECT * FROM movatak_leads WHERE cliente_id = $1 AND telefone = $2',
      [cliente.id, telefone]
    );
    if (!rl.rows.length) return res.json({ ok: true });

    const lead = rl.rows[0];

    // ---- Follow Up ----
    if (etiqueta === 'follow up' || etiqueta === 'followup') {
      await query(
        `UPDATE movatak_leads SET etapa = 'followup', atualizado_em = NOW() WHERE id = $1`,
        [lead.id]
      );

      // Limpar fila existente e criar nova sequência
      await query('DELETE FROM movatak_followup WHERE lead_id = $1', [lead.id]);

      const agora = new Date();
      for (const [etapa, dias] of Object.entries(DIAS_FOLLOWUP)) {
        const proximo = new Date(agora);
        proximo.setDate(proximo.getDate() + dias);
        await query(
          `INSERT INTO movatak_followup (lead_id, cliente_id, etapa_seq, proximo_envio, status)
           VALUES ($1, $2, $3, $4, 'pendente')`,
          [lead.id, cliente.id, parseInt(etapa), proximo.toISOString()]
        );
      }
    }

    // ---- Cliente (venda fechada) ----
    if (etiqueta === 'cliente') {
      await query(
        `UPDATE movatak_leads SET etapa = 'cliente', atualizado_em = NOW() WHERE id = $1`,
        [lead.id]
      );

      // Pausar follow up caso esteja rodando
      await query(
        `UPDATE movatak_followup SET status = 'pausado' WHERE lead_id = $1 AND status = 'pendente'`,
        [lead.id]
      );

      // Mensagem de boas-vindas
      const msg = `Seja bem-vindo(a)${lead.nome ? ', ' + lead.nome : ''}! Estamos muito felizes em ter você conosco. Em breve entraremos em contato com os próximos passos. Qualquer dúvida, é só chamar aqui!`;
      await zapiEnviar(
        cliente.zapi_instance,
        cliente.zapi_token,
        cliente.zapi_client_token,
        telefone,
        msg
      );

      await query(
        `INSERT INTO movatak_mensagens (lead_id, cliente_id, tipo) VALUES ($1, $2, 'boas_vindas')`,
        [lead.id, cliente.id]
      );
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('[webhook/etiqueta]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// CRON — Disparador de follow up (roda a cada hora)
// ============================================================
cron.schedule('0 * * * *', async () => {
  console.log('[cron] Verificando fila de follow up...');
  try {
    const r = await query(
      `SELECT f.*, l.telefone, l.nome, c.zapi_instance, c.zapi_token, c.zapi_client_token
       FROM movatak_followup f
       JOIN movatak_leads l ON l.id = f.lead_id
       JOIN movatak_clientes c ON c.id = f.cliente_id
       WHERE f.status = 'pendente'
         AND f.proximo_envio <= NOW()
         AND l.etapa = 'followup'`,
      []
    );

    for (const row of r.rows) {
      try {
        const gerarMsg = MSGS_FOLLOWUP[row.etapa_seq];
        if (!gerarMsg) continue;

        const msg = gerarMsg(row.nome);
        await zapiEnviar(
          row.zapi_instance,
          row.zapi_token,
          row.zapi_client_token,
          row.telefone,
          msg
        );

        await query(
          `UPDATE movatak_followup SET status = 'enviado' WHERE id = $1`,
          [row.id]
        );

        await query(
          `INSERT INTO movatak_mensagens (lead_id, cliente_id, tipo)
           VALUES ($1, $2, $3)`,
          [row.lead_id, row.cliente_id, `followup_${row.etapa_seq}`]
        );

        console.log(`[cron] Follow up ${row.etapa_seq} enviado → lead ${row.lead_id}`);
      } catch (e) {
        console.error(`[cron] Erro lead ${row.lead_id}:`, e.message);
      }
    }
  } catch (e) {
    console.error('[cron] Erro geral:', e.message);
  }
});

// ============================================================
// WEBHOOK — Lead respondeu (parar sequência)
// Z-API dispara quando lead envia qualquer mensagem
// Verificar se está em followup e pausar
// ============================================================
app.post('/movatak/webhook/resposta', async (req, res) => {
  try {
    const { phone, instanceId } = req.body;
    if (!phone) return res.json({ ok: true });

    const telefone = phone.replace(/\D/g, '');

    const rc = await query(
      'SELECT id FROM movatak_clientes WHERE zapi_instance = $1 AND ativo = true',
      [instanceId]
    );
    if (!rc.rows.length) return res.json({ ok: true });

    const clienteId = rc.rows[0].id;

    const rl = await query(
      `SELECT id FROM movatak_leads WHERE cliente_id = $1 AND telefone = $2 AND etapa = 'followup'`,
      [clienteId, telefone]
    );
    if (!rl.rows.length) return res.json({ ok: true });

    const leadId = rl.rows[0].id;

    await query(
      `UPDATE movatak_followup SET status = 'pausado'
       WHERE lead_id = $1 AND status = 'pendente'`,
      [leadId]
    );

    console.log(`[resposta] Follow up pausado → lead ${leadId}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[webhook/resposta]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// API — App do cliente (somente leitura)
// ============================================================

// Dashboard — métricas do período
app.get('/movatak/app/dashboard', authCliente, async (req, res) => {
  try {
    const { dias = 30 } = req.query;
    const clienteId = req.clienteId;

    const r = await query(
      `SELECT
         COUNT(*) FILTER (WHERE etapa != 'descartado')                          AS total_leads,
         COUNT(*) FILTER (WHERE etapa = 'cliente')                              AS convertidos,
         COUNT(*) FILTER (WHERE etapa = 'followup')                             AS em_followup,
         COUNT(*) FILTER (WHERE DATE(criado_em) = CURRENT_DATE)                AS leads_hoje,
         COUNT(*) FILTER (WHERE etapa = 'cliente' AND DATE(criado_em) = CURRENT_DATE) AS vendas_hoje,
         ROUND(
           100.0 * COUNT(*) FILTER (WHERE etapa = 'cliente') /
           NULLIF(COUNT(*) FILTER (WHERE etapa != 'descartado'), 0), 1
         )                                                                      AS taxa_conversao
       FROM movatak_leads
       WHERE cliente_id = $1
         AND criado_em >= NOW() - ($2 || ' days')::INTERVAL`,
      [clienteId, parseInt(dias)]
    );

    const planoTop = await query(
      `SELECT p.nome, COUNT(*) AS total
       FROM movatak_leads l
       JOIN movatak_planos p ON p.id = l.plano_id
       WHERE l.cliente_id = $1
         AND l.etapa = 'cliente'
         AND l.criado_em >= NOW() - ($2 || ' days')::INTERVAL
       GROUP BY p.nome
       ORDER BY total DESC
       LIMIT 1`,
      [clienteId, parseInt(dias)]
    );

    const leadsPorDia = await query(
      `SELECT DATE(criado_em) AS dia, COUNT(*) AS leads
       FROM movatak_leads
       WHERE cliente_id = $1
         AND criado_em >= NOW() - ($2 || ' days')::INTERVAL
       GROUP BY dia
       ORDER BY dia`,
      [clienteId, parseInt(dias)]
    );

    // CPL calculado: verba_diaria x dias / total_leads
    const clienteData = await query(
      'SELECT teto_cpl, verba_diaria, criado_em FROM movatak_clientes WHERE id = $1',
      [clienteId]
    );
    const cd = clienteData.rows[0] || {};
    const totalLeads = parseInt(r.rows[0].total_leads || 0);
    let cpl_calculado = null;
    let alerta_cpl = false;
    if (cd.verba_diaria && totalLeads > 0) {
      const diasRodando = Math.max(1, Math.ceil((Date.now() - new Date(cd.criado_em).getTime()) / 86400000));
      const verbaTotalGasta = parseFloat(cd.verba_diaria) * Math.min(diasRodando, parseInt(dias));
      cpl_calculado = (verbaTotalGasta / totalLeads).toFixed(2);
      if (cd.teto_cpl && parseFloat(cpl_calculado) > parseFloat(cd.teto_cpl)) {
        alerta_cpl = true;
      }
    }

    res.json({
      periodo_dias: parseInt(dias),
      ...r.rows[0],
      plano_top: planoTop.rows[0] || null,
      leads_por_dia: leadsPorDia.rows,
      cpl_calculado,
      teto_cpl: cd.teto_cpl || null,
      alerta_cpl
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// API — Painel Movatak (seus dados internos)
// ============================================================

// Listar todos os clientes com resumo
app.get('/movatak/admin/clientes', authMovatak, async (req, res) => {
  try {
    const r = await query(
      `SELECT c.id, c.nome, c.whatsapp, c.ativo, c.criado_em,
              COUNT(l.id) AS total_leads,
              COUNT(l.id) FILTER (WHERE l.etapa = 'cliente') AS convertidos,
              COUNT(l.id) FILTER (WHERE l.etapa = 'followup') AS em_followup,
              COUNT(l.id) FILTER (WHERE DATE(l.criado_em) = CURRENT_DATE) AS leads_hoje,
              COUNT(l.id) FILTER (WHERE l.etapa = 'cliente' AND DATE(l.criado_em) = CURRENT_DATE) AS vendas_hoje
       FROM movatak_clientes c
       LEFT JOIN movatak_leads l ON l.cliente_id = c.id
       GROUP BY c.id
       ORDER BY c.criado_em DESC`,
      []
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Cadastrar cliente novo (onboarding)
app.post('/movatak/admin/clientes', authMovatak, async (req, res) => {
  try {
    const {
      nome, whatsapp, zapi_instance, zapi_token, zapi_client_token,
      trigger_msg, teto_cpl, planos
    } = req.body;

    if (!nome || !whatsapp || !zapi_instance || !zapi_token || !zapi_client_token || !trigger_msg) {
      return res.status(400).json({ error: 'Campos obrigatorios: nome, whatsapp, zapi_instance, zapi_token, zapi_client_token, trigger_msg' });
    }

    const app_token = 'mvtk_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);

    const r = await query(
      `INSERT INTO movatak_clientes
         (nome, whatsapp, zapi_instance, zapi_token, zapi_client_token, trigger_msg, teto_cpl, app_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, app_token`,
      [nome, whatsapp, zapi_instance, zapi_token, zapi_client_token, trigger_msg, teto_cpl || null, app_token]
    );

    const clienteId = r.rows[0].id;

    if (Array.isArray(planos) && planos.length) {
      for (const p of planos) {
        await query(
          'INSERT INTO movatak_planos (cliente_id, nome, valor) VALUES ($1, $2, $3)',
          [clienteId, p.nome, p.valor || null]
        );
      }
    }

    res.json({ id: clienteId, app_token: r.rows[0].app_token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Leads de um cliente específico
app.get('/movatak/admin/clientes/:id/leads', authMovatak, async (req, res) => {
  try {
    const r = await query(
      `SELECT l.*, p.nome AS plano_nome
       FROM movatak_leads l
       LEFT JOIN movatak_planos p ON p.id = l.plano_id
       WHERE l.cliente_id = $1
       ORDER BY l.criado_em DESC
       LIMIT 200`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Buscar mensagens de follow up de um cliente
app.get('/movatak/admin/clientes/:id/followup', authMovatak, async (req, res) => {
  try {
    const r = await query('SELECT followup_msgs FROM movatak_clientes WHERE id = $1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Cliente nao encontrado.' });
    const row = r.rows[0];
    const msgs = row.followup_msgs || {
      msg1: 'Oi {nome}! Tudo bem? Passei aqui pra saber se ficou alguma duvida. Estou a disposicao!',
      msg2: '{nome}! Ainda temos disponibilidade pra voce. Se quiser retomar a conversa, e so chamar!',
      msg3: 'Ei! Nao quero ser chato, mas queria passar uma ultima vez. Tem algo que posso esclarecer?',
      msg4: 'Ultimo recado! Se em algum momento fizer sentido retomar, estarei aqui. Abraco!'
    };
    res.json({
      ...msgs,
      boas_vindas_msg: row.boas_vindas_msg || 'Seja bem-vindo(a){nome}! Estamos muito felizes em ter voce conosco. Em breve entraremos em contato com os proximos passos. Qualquer duvida, e so chamar!'
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Atualizar mensagens de follow up de um cliente
app.patch('/movatak/admin/clientes/:id/followup', authMovatak, async (req, res) => {
  try {
    const { msg1, msg2, msg3, msg4, boas_vindas_msg, verba_diaria } = req.body;
    if (!msg1 || !msg2 || !msg3 || !msg4) return res.status(400).json({ error: 'Todas as 4 mensagens sao obrigatorias.' });
    await query(
      'UPDATE movatak_clientes SET followup_msgs = $1, boas_vindas_msg = $2, verba_diaria = $3 WHERE id = $4',
      [JSON.stringify({ msg1, msg2, msg3, msg4 }), boas_vindas_msg || null, verba_diaria ? parseFloat(verba_diaria) : null, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Atualizar plano de um lead (quando atendente informa qual plano foi vendido)
app.patch('/movatak/admin/leads/:id/plano', authMovatak, async (req, res) => {
  try {
    const { plano_id } = req.body;
    await query(
      'UPDATE movatak_leads SET plano_id = $1, atualizado_em = NOW() WHERE id = $2',
      [plano_id, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// Health check
// ============================================================
app.get('/movatak/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// ============================================================
// Start
// ============================================================
const PORT = process.env.MOVATAK_PORT || process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[Movatak] Backend rodando na porta ${PORT}`);
});
