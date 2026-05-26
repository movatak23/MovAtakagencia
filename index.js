'use strict';

// ============================================================
// VERSÃO — incrementar a cada atualização
// ============================================================
const MOVATAK_VERSION = 'v2.1.4-cliente-cadastro-sem-gatilho';

const express = require('express');
const { Pool } = require('pg');
const cron = require('node-cron');
const axios = require('axios');
const crypto = require('crypto');

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

// Logs completos somente quando necessário. Em produção, deixe MOVATAK_DEBUG=false
// para não poluir o Railway com payloads grandes da Z-API/Rastreiobot.
const MOVATAK_DEBUG = String(process.env.MOVATAK_DEBUG || '').toLowerCase() === 'true';
function logDebug(...args) {
  if (MOVATAK_DEBUG) console.log(...args);
}

// Regras anti-spam e segurança operacional.
// Ajustáveis via Railway sem mexer no código.
const MOVATAK_REENTRADA_FU1_HORAS = parseInt(process.env.MOVATAK_REENTRADA_FU1_HORAS || '6', 10);
const MOVATAK_MAX_AUTO_MSG_DIA = parseInt(process.env.MOVATAK_MAX_AUTO_MSG_DIA || '6', 10);

const DEFAULT_CLIENTE_PERMISSOES = {
  ver_dashboard: true,
  ver_cpl: true,
  ver_vendedores: true,
  ver_campanhas: true,
  ver_eventos: true,
  editar_vendedores: false,
  editar_followup: false,
  editar_campanhas: false,
  exportar_csv: true
};

function normalizarPermissoes(permissoes) {
  return { ...DEFAULT_CLIENTE_PERMISSOES, ...(permissoes || {}) };
}

function hashSenha(senha) {
  if (!senha) return null;
  return crypto.createHash('sha256').update(String(senha) + ':' + (process.env.MOVATAK_SECRET || 'movatak')).digest('hex');
}

function gerarToken(prefixo) {
  return prefixo + '_' + Date.now() + '_' + crypto.randomBytes(8).toString('hex');
}


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


// Garante colunas usadas pelo portal do cliente e permissões do cadastro.
async function garantirColunasClientesPortal() {
  await query(`ALTER TABLE movatak_clientes
    ADD COLUMN IF NOT EXISTS permissoes_portal JSONB DEFAULT '{"ver_dashboard":true,"ver_cpl":true,"ver_vendedores":true,"ver_campanhas":true,"ver_eventos":true,"editar_vendedores":false,"editar_followup":false,"editar_campanhas":false,"exportar_csv":true}'::jsonb,
    ADD COLUMN IF NOT EXISTS comandos JSONB DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS followup_msgs_v2 JSONB DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS trigger_msg TEXT`, []);
  await query(`UPDATE movatak_clientes
     SET permissoes_portal = '{"ver_dashboard":true,"ver_cpl":true,"ver_vendedores":true,"ver_campanhas":true,"ver_eventos":true,"editar_vendedores":false,"editar_followup":false,"editar_campanhas":false,"exportar_csv":true}'::jsonb
   WHERE permissoes_portal IS NULL`, []);
}

// Garante colunas usadas pelo portal individual do vendedor.
// Mantém compatibilidade quando o deploy sobe antes da migração completa.
async function garantirColunasVendedoresPortal() {
  await query(`ALTER TABLE movatak_vendedores
    ADD COLUMN IF NOT EXISTS comando TEXT,
    ADD COLUMN IF NOT EXISTS email_acesso TEXT,
    ADD COLUMN IF NOT EXISTS senha_hash TEXT,
    ADD COLUMN IF NOT EXISTS acesso_token TEXT`, []);
  await query(`UPDATE movatak_vendedores
       SET acesso_token = 'vend_' || EXTRACT(EPOCH FROM NOW())::bigint || '_' || id || '_' || substr(md5(random()::text), 1, 10)
     WHERE acesso_token IS NULL OR acesso_token = ''`, []);
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
      'SELECT id, nome, permissoes_portal FROM movatak_clientes WHERE app_token = $1 AND ativo = true',
      [token]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'Token invalido.' });
    req.clienteId = r.rows[0].id;
    req.clienteNome = r.rows[0].nome;
    req.clientePermissoes = normalizarPermissoes(r.rows[0].permissoes_portal);
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}



async function authVendedor(req, res, next) {
  const token = req.headers['x-vendedor-token'];
  if (!token) return res.status(401).json({ error: 'Token do vendedor ausente.' });
  try {
    const r = await query(
      `SELECT v.id, v.cliente_id, v.nome, v.email_acesso, c.nome AS cliente_nome
         FROM movatak_vendedores v
         JOIN movatak_clientes c ON c.id = v.cliente_id
        WHERE v.acesso_token = $1 AND v.ativo = true AND c.ativo = true`,
      [token]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'Token do vendedor invalido.' });
    req.vendedor = r.rows[0];
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
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


const MOVATAK_ADMIN_WA = '558176041948';

async function zapiCriarEtiqueta(instance, token, clientToken, nome) {
  try {
    const url = `https://api.z-api.io/instances/${instance}/token/${token}/tags`;
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

async function enviarAlerta(instance, token, clientToken, destinatario, msg) {
  try {
    await zapiEnviar(instance, token, clientToken, destinatario, msg);
  } catch(e) {
    console.error('[enviarAlerta]', e.message);
  }
}

// ============================================================
// Auditoria operacional — histórico do lead e saúde da integração
// ============================================================
async function registrarEventoLead(leadId, clienteId, tipo, descricao, dados = {}) {
  try {
    if (!leadId || !clienteId || !tipo) return;
    await query(
      `INSERT INTO movatak_lead_eventos (lead_id, cliente_id, tipo, descricao, dados)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [leadId, clienteId, tipo, descricao || null, JSON.stringify(dados || {})]
    );
  } catch (e) {
    // Não deixa auditoria derrubar o CRM se a migração ainda não foi aplicada.
    console.error('[evento-lead]', e.message);
  }
}

async function registrarWebhookCliente(clienteId, resumo = {}) {
  try {
    await query(
      `UPDATE movatak_clientes
          SET ultimo_webhook_em = NOW(), ultimo_webhook_payload = $1::jsonb
        WHERE id = $2`,
      [JSON.stringify(resumo || {}), clienteId]
    );
  } catch (e) {
    console.error('[webhook-status]', e.message);
  }
}

async function registrarErroZapi(clienteId, mensagem, detalhes = {}) {
  try {
    await query(
      `UPDATE movatak_clientes
          SET ultimo_erro_zapi_em = NOW(), ultimo_erro_zapi = $1
        WHERE id = $2`,
      [String(mensagem || '').slice(0, 500), clienteId]
    );
  } catch (e) {
    console.error('[zapi-status]', e.message);
  }
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return '"' + s.replace(/"/g, '""') + '"';
}

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

async function localizarCampanhaPorGatilho(clienteId, texto) {
  try {
    const r = await query(
      `SELECT c.*, t.followup_v2 AS template_followup_v2, t.boas_vindas_msg AS template_boas_vindas_msg, t.comandos AS template_comandos, t.nome AS template_nome
         FROM movatak_campanhas c
         LEFT JOIN movatak_followup_templates t ON t.id = c.template_id AND t.ativo = true
        WHERE c.cliente_id = $1
          AND c.ativo = true
          AND c.excluida_em IS NULL
          AND c.gatilho IS NOT NULL
          AND TRIM(c.gatilho) <> ''
        ORDER BY LENGTH(c.gatilho) DESC, c.criado_em DESC`,
      [clienteId]
    );
    return r.rows.find(c => textoBateGatilho(texto, c.gatilho)) || null;
  } catch (e) {
    // Se a migração de campanhas ainda não existir, segue pelo gatilho geral.
    return null;
  }
}

function followupDataDaLinha(row) {
  return row.template_followup_v2 || row.followup_msgs_v2 || {};
}

function parseMoedaParaNumero(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseFloat(String(v).replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

const TEMPLATES_FOLLOWUP = {
  provedor: {
    nome: 'Provedor de Internet',
    trigger_msg: 'Olá! Tenho interesse nos planos de internet.',
    followup_v2: {
      fu1: {
        msg1: 'Oi {nome}! Tudo bem? Recebemos seu interesse nos planos de internet. Posso te ajudar a escolher o melhor plano?',
        msg2: '{nome}, temos opções com internet rápida e suporte próximo. Me diga sua cidade/bairro para verificarmos a disponibilidade.'
      },
      fu2: {
        msg1: '{nome}, passando para saber se ainda deseja contratar sua internet. Posso continuar seu atendimento?',
        msg2: 'Oi {nome}! Ainda consigo te ajudar com a instalação. Quer que eu veja as condições para sua região?',
        msg3: '{nome}, último contato por aqui. Se quiser retomar a contratação, é só me chamar.'
      }
    },
    boas_vindas_msg: 'Seja bem-vindo(a){nome}! Seu atendimento foi encaminhado e em breve nossa equipe passa os próximos passos.'
  },
  dtfuv: {
    nome: 'DTF UV / Estampas',
    trigger_msg: 'PROV >> Olá! Tenho interesse nas estampas e gostaria de informações.',
    followup_v2: {
      fu1: {
        msg1: 'Oi {nome}! Tudo bem? Recebemos seu interesse nas estampas. Vou te passar as informações e tirar suas dúvidas.',
        msg2: '{nome}, nossas estampas ajudam a identificar equipamentos com acabamento profissional e alta durabilidade. Posso te mostrar os modelos?'
      },
      fu2: {
        msg1: '{nome}, passando para saber se ainda deseja seguir com as estampas. Posso retomar seu atendimento?',
        msg2: 'Oi {nome}! Ainda temos disponibilidade para produção. Quer que eu te envie as opções?',
        msg3: '{nome}, último contato por aqui. Se quiser fechar suas estampas depois, é só me chamar.'
      }
    },
    boas_vindas_msg: 'A DTFclub agradece a preferência. Daremos nosso melhor para que suas estampas cheguem com a qualidade de sempre.'
  },
  generico: {
    nome: 'Genérico Comercial',
    trigger_msg: 'Olá! Tenho interesse e gostaria de informações.',
    followup_v2: {
      fu1: {
        msg1: 'Oi {nome}! Tudo bem? Recebemos seu contato e estou à disposição para te ajudar.',
        msg2: '{nome}, posso te passar as informações e tirar suas dúvidas por aqui.'
      },
      fu2: {
        msg1: '{nome}, passando para saber se ainda posso te ajudar.',
        msg2: 'Oi {nome}! Ainda ficou alguma dúvida sobre o atendimento?',
        msg3: '{nome}, vou encerrar por aqui, mas se quiser retomar é só chamar.'
      }
    },
    boas_vindas_msg: 'Seja bem-vindo(a){nome}! Obrigado pela preferência.'
  }
};

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
// Follow up em 2 blocos: FU1 imediatas, FU2 (D+0, D+1, D+3)
const DIAS_FOLLOWUP_V2 = {
  fu1: { 1: 0, 2: 0 },
  fu2: { 1: 0, 2: 1, 3: 3 }
};

// Agenda follow-up no novo formato FU1/FU2.
// sequenciaFu: 1 = boas-vindas imediatas; 2 = reativação.
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
}

// Envia imediatamente as mensagens pendentes de um lead.
// Usado principalmente no FU1, para não depender do cron de 10 minutos.
// Se a Z-API falhar, mantém a mensagem como pendente para o cron tentar de novo.
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
            camp.id AS campanha_id, camp.nome AS campanha_nome,
            t.followup_v2 AS template_followup_v2
       FROM movatak_followup f
       JOIN movatak_leads l ON l.id = f.lead_id
       JOIN movatak_clientes c ON c.id = f.cliente_id
       LEFT JOIN movatak_campanhas camp ON camp.id = l.campanha_id
       LEFT JOIN movatak_followup_templates t ON t.id = camp.template_id AND t.ativo = true
      WHERE f.lead_id = $1
        AND f.status = 'pendente'
        AND f.proximo_envio <= NOW()
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
      if (row.etapa !== 'followup') {
        console.log(`[followup][imediato] lead ${leadId} ignorado porque etapa=${row.etapa}`);
        continue;
      }

      const fuData = followupDataDaLinha(row);
      const seqKey = 'fu' + (row.sequencia_fu || 1);
      const msgs = fuData[seqKey] || {};
      const msgText = msgs['msg' + row.etapa_seq];

      if (!msgText || !String(msgText).trim()) {
        await query(`UPDATE movatak_followup SET status = 'enviado', enviado_em = NOW() WHERE id = $1`, [row.id]);
        console.log(`[followup][imediato] FU${row.sequencia_fu || 1} msg${row.etapa_seq} vazia; marcada como enviada -> lead ${leadId}`);
        continue;
      }

      const msg = String(msgText).replace(/{nome}/g, row.nome || 'Lead');

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

// Se o lead ficou 1h sem responder ao FU1, entra no FU2.
async function migrarFU1ParaFU2() {
  const r = await query(
    `SELECT DISTINCT l.id AS lead_id, l.cliente_id
     FROM movatak_leads l
     JOIN movatak_followup f ON f.lead_id = l.id
     WHERE l.etapa = 'followup'
       AND COALESCE(f.sequencia_fu, 1) = 1
       AND COALESCE(f.data_entrada, l.atualizado_em, l.criado_em) <= NOW() - INTERVAL '1 hour'
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
    // Não usa ILIKE direto porque pequenas diferenças como "PROV>>" vs "PROV >>" quebravam o disparo.
    const r = await query(
      `SELECT * FROM movatak_clientes WHERE ativo = true AND trigger_msg IS NOT NULL`,
      []
    );
    const cliente = r.rows.find(c => textoBateGatilho(mensagem, c.trigger_msg));
    if (!cliente) return res.json({ ok: true });

    // Verificar se lead já existe para evitar duplicata
    const existe = await query(
      'SELECT id FROM movatak_leads WHERE cliente_id = $1 AND telefone = $2',
      [cliente.id, telefone]
    );
    if (existe.rows.length) return res.json({ ok: true });

    // Criar lead direto em FU1
    const novoLead = await query(
      `INSERT INTO movatak_leads (cliente_id, telefone, nome, etapa)
       VALUES ($1, $2, $3, 'followup')
       RETURNING id`,
      [cliente.id, telefone, senderName || null]
    );

    await registrarEventoLead(novoLead.rows[0].id, cliente.id, 'lead_criado', 'Lead criado pela rota /webhook/mensagem', { telefone, origem: 'webhook/mensagem' });
    await agendarFollowupV2(novoLead.rows[0].id, cliente.id, 1, true);
    await enviarFollowupsPendentesDoLead(novoLead.rows[0].id, 1);

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

      // Follow-up manual entra no FU2 (reativacao)
      await agendarFollowupV2(lead.id, cliente.id, 2, true);
    }

    // ---- Registrar log de etiqueta (auditoria) ----
    await query(
      'INSERT INTO movatak_etiqueta_log (lead_id, cliente_id, etiqueta) VALUES ($1, $2, $3)',
      [lead.id, cliente.id, etiqueta]
    );

    // ---- Detecção de vendedor ----
    const vendedores = await query(
      'SELECT * FROM movatak_vendedores WHERE cliente_id = $1 AND ativo = true',
      [cliente.id]
    );
    const vendedorDetectado = vendedores.rows.find(v =>
      etiqueta.toLowerCase() === ('vendedor - ' + v.nome.toLowerCase())
    );

    if (vendedorDetectado) {
      // Verificar troca suspeita — se já tinha outro vendedor
      const vendedorAnterior = await query(
        `SELECT el.etiqueta FROM movatak_etiqueta_log el
         WHERE el.lead_id = $1
           AND el.etiqueta ILIKE 'vendedor - %'
           AND el.aplicado_em < NOW() - INTERVAL '10 seconds'
         ORDER BY el.aplicado_em DESC LIMIT 1`,
        [lead.id]
      );

      if (vendedorAnterior.rows.length && vendedorAnterior.rows[0].etiqueta.toLowerCase() !== etiqueta.toLowerCase()) {
        // TROCA SUSPEITA DETECTADA
        const alertMsg = `⚠️ *Alerta: Troca de vendedor detectada*\n\n*Cliente:* ${cliente.nome}\n*Lead:* ${lead.telefone}\n*Vendedor anterior:* ${vendedorAnterior.rows[0].etiqueta}\n*Trocado para:* ${etiqueta}\n*Horário:* ${new Date().toLocaleString('pt-BR')}`;

        // Alerta para Movatak (você)
        await enviarAlerta(cliente.zapi_instance, cliente.zapi_token, cliente.zapi_client_token, MOVATAK_ADMIN_WA, alertMsg);

        // Alerta para dono da empresa
        if (cliente.whatsapp_dono) {
          await enviarAlerta(cliente.zapi_instance, cliente.zapi_token, cliente.zapi_client_token, cliente.whatsapp_dono, alertMsg);
        }

        console.log(`[alerta] Troca de vendedor detectada → lead ${lead.id}`);
      }

      // Atribuir vendedor ao lead (primeiro a aplicar ganha)
      if (!lead.vendedor_id) {
        await query(
          'UPDATE movatak_leads SET vendedor_id = $1, atualizado_em = NOW() WHERE id = $2',
          [vendedorDetectado.id, lead.id]
        );
      }
    }

    // ---- Cliente (venda fechada) ----
    if (etiqueta === 'cliente' || vendedorDetectado) {
      if (etiqueta === 'cliente' || vendedorDetectado) {
        await query(
          `UPDATE movatak_leads SET etapa = 'cliente', atualizado_em = NOW() WHERE id = $1`,
          [lead.id]
        );

        await query(
          `UPDATE movatak_followup SET status = 'pausado' WHERE lead_id = $1 AND status = 'pendente'`,
          [lead.id]
        );

        if (etiqueta === 'cliente' || vendedorDetectado) {
          const boasVindasCustom = cliente.boas_vindas_msg ||
            `Seja bem-vindo(a)${lead.nome ? ', ' + lead.nome : ''}! Estamos muito felizes em ter você conosco. Em breve entraremos em contato com os próximos passos. Qualquer dúvida, é só chamar aqui!`;
          const msg = boasVindasCustom.replace('{nome}', lead.nome ? ', ' + lead.nome : '');
          await zapiEnviar(cliente.zapi_instance, cliente.zapi_token, cliente.zapi_client_token, telefone, msg);
          await query(
            `INSERT INTO movatak_mensagens (lead_id, cliente_id, tipo) VALUES ($1, $2, 'boas_vindas')`,
            [lead.id, cliente.id]
          );
        }
      }
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
cron.schedule('*/10 * * * *', async () => {
  console.log('[cron] Verificando fila de follow up (10 min)...');
  try {
    await migrarFU1ParaFU2();

    const r = await query(
      `SELECT f.*, l.telefone, l.nome, l.etapa, c.zapi_instance, c.zapi_token, c.zapi_client_token, c.followup_msgs_v2,
              camp.id AS campanha_id, camp.nome AS campanha_nome,
              t.followup_v2 AS template_followup_v2
       FROM movatak_followup f
       JOIN movatak_leads l ON l.id = f.lead_id
       JOIN movatak_clientes c ON c.id = f.cliente_id
       LEFT JOIN movatak_campanhas camp ON camp.id = l.campanha_id
       LEFT JOIN movatak_followup_templates t ON t.id = camp.template_id AND t.ativo = true
       WHERE f.status = 'pendente'
         AND f.proximo_envio <= NOW()`,
      []
    );

    for (const row of r.rows) {
      try {
        if (row.etapa !== 'followup') continue;
        
        const fu_data = followupDataDaLinha(row);
        const seq_key = 'fu' + (row.sequencia_fu || 1);
        const msgs = fu_data[seq_key] || {};
        const msg_text = msgs['msg' + row.etapa_seq];
        
        if (!msg_text || !msg_text.trim()) {
          await query(`UPDATE movatak_followup SET status = 'enviado', enviado_em = NOW() WHERE id = $1`, [row.id]);
          continue;
        }

        const msg = msg_text.replace(/{nome}/g, row.nome || 'Lead');
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
        await registrarEventoLead(row.lead_id, row.cliente_id, 'mensagem_enviada', `FU${row.sequencia_fu || 1} msg${row.etapa_seq} enviada pelo cron`, { followup_id: row.id });

        console.log(`[cron] FU${row.sequencia_fu || 1} msg${row.etapa_seq} enviado → lead ${row.lead_id}`);
      } catch (e) {
        await query(
          `UPDATE movatak_followup SET erro_envio = $1, tentativas_envio = COALESCE(tentativas_envio, 0) + 1 WHERE id = $2`,
          [String(e.message || e).slice(0, 500), row.id]
        ).catch(() => null);
        await registrarErroZapi(row.cliente_id, e.message, { lead_id: row.lead_id, followup_id: row.id });
        await registrarEventoLead(row.lead_id, row.cliente_id, 'erro_envio', 'Erro ao enviar mensagem pelo cron', { erro: e.message, followup_id: row.id });
        console.error(`[cron] Erro lead ${row.lead_id}:`, e.message);
      }
    }
  } catch (e) {
    console.error('[cron] Erro geral:', e.message);
  }
});


// ============================================================
// CRON — Alerta CPL ultrapassou teto (roda a cada hora)
// ============================================================
cron.schedule('30 * * * *', async () => {
  try {
    const clientes = await query(
      `SELECT c.*, COUNT(l.id) AS total_leads
       FROM movatak_clientes c
       LEFT JOIN movatak_leads l ON l.cliente_id = c.id AND l.etapa != 'descartado'
       WHERE c.ativo = true AND c.verba_diaria IS NOT NULL AND c.teto_cpl IS NOT NULL
       GROUP BY c.id`,
      []
    );

    for (const c of clientes.rows) {
      const totalLeads = parseInt(c.total_leads || 0);
      if (totalLeads === 0) continue;
      const diasRodando = Math.max(1, Math.ceil((Date.now() - new Date(c.criado_em).getTime()) / 86400000));
      const verbaTotalGasta = parseFloat(c.verba_diaria) * Math.min(diasRodando, 90);
      const cpl = verbaTotalGasta / totalLeads;

      if (cpl > parseFloat(c.teto_cpl)) {
        const msg = `🚨 *Alerta CPL — ${c.nome}*\n\nCPL atual: *R$ ${cpl.toFixed(2)}*\nTeto acordado: *R$ ${parseFloat(c.teto_cpl).toFixed(2)}*\n\nRevise as campanhas ou aumente a verba.`;
        await enviarAlerta(c.zapi_instance, c.zapi_token, c.zapi_client_token, MOVATAK_ADMIN_WA, msg);
        if (c.whatsapp_dono) {
          await enviarAlerta(c.zapi_instance, c.zapi_token, c.zapi_client_token, c.whatsapp_dono, msg);
        }
        console.log(`[cron-cpl] Alerta enviado → ${c.nome} CPL R${cpl.toFixed(2)}`);
      }
    }
  } catch(e) {
    console.error('[cron-cpl]', e.message);
  }
});

// ============================================================
// CRON — Alerta de lead parado sem etiqueta após 24h
// ============================================================
cron.schedule('0 9 * * *', async () => {
  try {
    const leads = await query(
      `SELECT l.*, c.nome AS cliente_nome, c.zapi_instance, c.zapi_token, c.zapi_client_token, c.whatsapp_dono
       FROM movatak_leads l
       JOIN movatak_clientes c ON c.id = l.cliente_id
       WHERE l.etapa = 'lead'
         AND l.criado_em <= NOW() - INTERVAL '24 hours'
         AND c.ativo = true`,
      []
    );

    for (const lead of leads.rows) {
      const msg = `⏰ *Lead parado há mais de 24h*\n\n*Cliente:* ${lead.cliente_nome}\n*Lead:* ${lead.telefone}${lead.nome ? ' (' + lead.nome + ')' : ''}\n\nEsse lead ainda não recebeu etiqueta Follow Up ou Cliente. Verifique com a equipe de vendas.`;
      await enviarAlerta(lead.zapi_instance, lead.zapi_token, lead.zapi_client_token, MOVATAK_ADMIN_WA, msg);
      if (lead.whatsapp_dono) {
        await enviarAlerta(lead.zapi_instance, lead.zapi_token, lead.zapi_client_token, lead.whatsapp_dono, msg);
      }
      console.log(`[cron-parado] Alerta lead parado → ${lead.id}`);
    }
  } catch(e) {
    console.error('[cron-parado]', e.message);
  }
});

// ============================================================
// CRON — Relatório diário para o dono do cliente
// Ative com MOVATAK_RELATORIO_DIARIO=true
// ============================================================
async function montarRelatorioDiarioCliente(clienteId) {
  const r = await query(
    `SELECT c.nome, c.whatsapp_dono, c.zapi_instance, c.zapi_token, c.zapi_client_token,
            COUNT(l.id) FILTER (WHERE DATE(l.criado_em) = CURRENT_DATE - INTERVAL '1 day') AS leads_ontem,
            COUNT(l.id) FILTER (WHERE l.etapa = 'cliente' AND DATE(l.atualizado_em) = CURRENT_DATE - INTERVAL '1 day') AS vendas_ontem,
            COUNT(l.id) FILTER (WHERE l.etapa = 'followup') AS em_followup,
            COUNT(l.id) FILTER (WHERE l.etapa = 'descartado' AND DATE(l.atualizado_em) = CURRENT_DATE - INTERVAL '1 day') AS descartados_ontem
       FROM movatak_clientes c
       LEFT JOIN movatak_leads l ON l.cliente_id = c.id
      WHERE c.id = $1
      GROUP BY c.id`,
    [clienteId]
  );
  if (!r.rows.length) return null;
  const c = r.rows[0];
  const vend = await query(
    `SELECT v.nome, COUNT(l.id) AS vendas
       FROM movatak_vendedores v
       LEFT JOIN movatak_leads l ON l.vendedor_id = v.id
        AND l.etapa = 'cliente'
        AND DATE(l.atualizado_em) = CURRENT_DATE - INTERVAL '1 day'
      WHERE v.cliente_id = $1 AND v.ativo = true
      GROUP BY v.id, v.nome
      ORDER BY vendas DESC
      LIMIT 1`,
    [clienteId]
  );
  const top = vend.rows[0];
  return {
    cliente: c,
    mensagem: `📊 *Resumo de ontem — ${c.nome}*

` +
      `Leads recebidos: *${c.leads_ontem || 0}*
` +
      `Vendas marcadas: *${c.vendas_ontem || 0}*
` +
      `Em follow-up agora: *${c.em_followup || 0}*
` +
      `Descartados ontem: *${c.descartados_ontem || 0}*
` +
      `Melhor vendedor: *${top && parseInt(top.vendas || 0) > 0 ? `${top.nome} — ${top.vendas}` : 'sem vendas registradas'}*

` +
      `_Relatório automático Movatak FollowUp CRM_`
  };
}

async function enviarRelatorioDiarioClientes() {
  const enabled = String(process.env.MOVATAK_RELATORIO_DIARIO || '').toLowerCase() === 'true';
  if (!enabled) return;
  const clientes = await query(
    `SELECT id FROM movatak_clientes WHERE ativo = true AND whatsapp_dono IS NOT NULL AND whatsapp_dono <> ''`,
    []
  );
  for (const row of clientes.rows) {
    try {
      const rel = await montarRelatorioDiarioCliente(row.id);
      if (!rel || !rel.cliente.whatsapp_dono) continue;
      await zapiEnviar(rel.cliente.zapi_instance, rel.cliente.zapi_token, rel.cliente.zapi_client_token, rel.cliente.whatsapp_dono, rel.mensagem);
      console.log(`[relatorio-diario] enviado -> cliente ${row.id}`);
    } catch (e) {
      console.error('[relatorio-diario]', e.message);
    }
  }
}

cron.schedule('30 8 * * *', enviarRelatorioDiarioClientes, { timezone: 'America/Sao_Paulo' });

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
      `UPDATE movatak_leads SET etapa = 'lead', atualizado_em = NOW() WHERE id = $1`,
      [leadId]
    );

    await query(
      `UPDATE movatak_followup SET status = 'pausado'
       WHERE lead_id = $1 AND status = 'pendente'`,
      [leadId]
    );

    console.log(`[resposta] Follow up pausado e lead voltou para atendimento → lead ${leadId}`);
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
    await garantirColunasClientesPortal();
    const {
      nome, whatsapp, zapi_instance, zapi_token, zapi_client_token,
      trigger_msg, teto_cpl, planos, permissoes_portal
    } = req.body;

    if (!nome || !whatsapp || !zapi_instance || !zapi_token || !zapi_client_token) {
      return res.status(400).json({ error: 'Campos obrigatorios: nome, whatsapp, zapi_instance, zapi_token, zapi_client_token' });
    }

    const triggerPadrao = (trigger_msg && String(trigger_msg).trim()) ? String(trigger_msg).trim() : 'USAR_GATILHOS_DAS_CAMPANHAS';
    const app_token = gerarToken('mvtk');

    const r = await query(
      `INSERT INTO movatak_clientes
         (nome, whatsapp, zapi_instance, zapi_token, zapi_client_token, trigger_msg, teto_cpl, app_token, permissoes_portal)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       RETURNING id, app_token`,
      [nome, whatsapp, zapi_instance, zapi_token, zapi_client_token, triggerPadrao, teto_cpl || null, app_token, JSON.stringify(normalizarPermissoes(permissoes_portal))]
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

// Buscar dados de um cliente para edição (sem expor token/client-token)
app.get('/movatak/admin/clientes/:id/dados', authMovatak, async (req, res) => {
  try {
    await garantirColunasClientesPortal();
    const r = await query(
      `SELECT id, nome, whatsapp, zapi_instance, trigger_msg, teto_cpl, permissoes_portal
       FROM movatak_clientes WHERE id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Cliente nao encontrado.' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Editar dados de um cliente. Token e client-token só são alterados se enviados.
app.patch('/movatak/admin/clientes/:id/dados', authMovatak, async (req, res) => {
  try {
    await garantirColunasClientesPortal();
    const { nome, whatsapp, zapi_instance, zapi_token, zapi_client_token, trigger_msg, teto_cpl, permissoes_portal } = req.body;

    if (!nome || !whatsapp || !zapi_instance) {
      return res.status(400).json({ error: 'Nome, WhatsApp e Instance ID sao obrigatorios.' });
    }

    const triggerPadrao = (trigger_msg && String(trigger_msg).trim()) ? String(trigger_msg).trim() : 'USAR_GATILHOS_DAS_CAMPANHAS';
    // Monta o UPDATE dinamicamente — token/client-token só entram se preenchidos
    const campos = ['nome = $1', 'whatsapp = $2', 'zapi_instance = $3', 'trigger_msg = $4', 'teto_cpl = $5'];
    const valores = [nome, whatsapp, zapi_instance, triggerPadrao, teto_cpl ? parseFloat(teto_cpl) : null];
    let idx = 6;
    if (permissoes_portal) { campos.push('permissoes_portal = $' + idx + '::jsonb'); valores.push(JSON.stringify(normalizarPermissoes(permissoes_portal))); idx++; }

    if (zapi_token && zapi_token.trim()) {
      campos.push('zapi_token = $' + idx);
      valores.push(zapi_token.trim());
      idx++;
    }
    if (zapi_client_token && zapi_client_token.trim()) {
      campos.push('zapi_client_token = $' + idx);
      valores.push(zapi_client_token.trim());
      idx++;
    }

    valores.push(req.params.id);
    await query(
      `UPDATE movatak_clientes SET ${campos.join(', ')} WHERE id = $${idx}`,
      valores
    );
    res.json({ ok: true });
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
    const r = await query(
      `SELECT followup_msgs_v2, followup_msgs, boas_vindas_msg, verba_diaria, whatsapp_dono, trigger_msg, comandos
       FROM movatak_clientes WHERE id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Cliente nao encontrado.' });

    const row = r.rows[0];

    // Garante compatibilidade com bancos que ainda tenham mensagens no formato antigo.
    const legado = row.followup_msgs || {};
    const padrao = {
      fu1: {
        msg1: 'Oi {nome}! Tudo bem? Passei aqui pra saber se ficou alguma duvida. Estou a disposicao!',
        msg2: '{nome}! Ainda temos disponibilidade pra voce. Se quiser retomar a conversa, e so chamar!'
      },
      fu2: {
        msg1: '',
        msg2: '',
        msg3: ''
      }
    };

    const v2 = row.followup_msgs_v2 || {
      fu1: {
        msg1: legado.msg1 || padrao.fu1.msg1,
        msg2: legado.msg2 || padrao.fu1.msg2
      },
      fu2: {
        msg1: legado.msg3 || padrao.fu2.msg1,
        msg2: legado.msg4 || padrao.fu2.msg2,
        msg3: legado.msg5 || padrao.fu2.msg3
      }
    };

    const followup_v2 = {
      fu1: {
        msg1: (v2.fu1 && v2.fu1.msg1) || padrao.fu1.msg1,
        msg2: (v2.fu1 && v2.fu1.msg2) || padrao.fu1.msg2
      },
      fu2: {
        msg1: (v2.fu2 && v2.fu2.msg1) || '',
        msg2: (v2.fu2 && v2.fu2.msg2) || '',
        msg3: (v2.fu2 && v2.fu2.msg3) || ''
      }
    };

    // Retorna em formatos diferentes para não quebrar o admin.html, mesmo que ele esteja lendo nomes antigos.
    res.json({
      followup_v2,
      followup_msgs_v2: followup_v2,
      fu1: followup_v2.fu1,
      fu2: followup_v2.fu2,
      msg1: followup_v2.fu1.msg1,
      msg2: followup_v2.fu1.msg2,
      msg3: followup_v2.fu2.msg1,
      msg4: followup_v2.fu2.msg2,
      msg5: followup_v2.fu2.msg3,
      boas_vindas_msg: row.boas_vindas_msg || 'Seja bem-vindo(a){nome}! Estamos muito felizes em ter voce conosco. Em breve entraremos em contato com os proximos passos. Qualquer duvida, e so chamar!',
      verba_diaria: row.verba_diaria || null,
      whatsapp_dono: row.whatsapp_dono || null,
      trigger_msg: row.trigger_msg || '',
      comandos: row.comandos || { followup: [], convertido: [], descartar: [], desfazer: [] },
      comando_followup: ((row.comandos || {}).followup || []).join(', '),
      comando_convertido: ((row.comandos || {}).convertido || []).join(', '),
      comando_descartar: ((row.comandos || {}).descartar || []).join(', '),
      comando_desfazer: ((row.comandos || {}).desfazer || []).join(', ')
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Atualizar mensagens de follow up de um cliente (novo formato: 2 blocos)
app.patch('/movatak/admin/clientes/:id/followup', authMovatak, async (req, res) => {
  try {
    const { boas_vindas_msg, verba_diaria, whatsapp_dono, trigger_msg } = req.body;

    // O painel pode enviar como followup_v2, followup_msgs_v2, fu1/fu2 ou campos soltos.
    // Esta normalização evita o problema de "aparece na tela, mas não grava".
    const recebido = req.body.followup_v2 || req.body.followup_msgs_v2 || {};
    const followup_v2 = {
      fu1: {
        msg1: String((recebido.fu1 && recebido.fu1.msg1) || (req.body.fu1 && req.body.fu1.msg1) || req.body.fu1_msg1 || req.body.msg1 || '').trim(),
        msg2: String((recebido.fu1 && recebido.fu1.msg2) || (req.body.fu1 && req.body.fu1.msg2) || req.body.fu1_msg2 || req.body.msg2 || '').trim()
      },
      fu2: {
        msg1: String((recebido.fu2 && recebido.fu2.msg1) || (req.body.fu2 && req.body.fu2.msg1) || req.body.fu2_msg1 || req.body.msg3 || '').trim(),
        msg2: String((recebido.fu2 && recebido.fu2.msg2) || (req.body.fu2 && req.body.fu2.msg2) || req.body.fu2_msg2 || req.body.msg4 || '').trim(),
        msg3: String((recebido.fu2 && recebido.fu2.msg3) || (req.body.fu2 && req.body.fu2.msg3) || req.body.fu2_msg3 || req.body.msg5 || '').trim()
      }
    };

    await query(
      `UPDATE movatak_clientes
         SET followup_msgs_v2 = $1::jsonb,
             boas_vindas_msg = $2,
             verba_diaria = $3,
             whatsapp_dono = $4,
             trigger_msg = COALESCE($5, trigger_msg)
       WHERE id = $6`,
      [
        JSON.stringify(followup_v2),
        boas_vindas_msg || null,
        verba_diaria ? parseFloat(String(verba_diaria).replace(',', '.')) : null,
        whatsapp_dono ? String(whatsapp_dono).replace(/\D/g, '') : null,
        (trigger_msg && String(trigger_msg).trim()) ? String(trigger_msg).trim() : null,
        req.params.id
      ]
    );

    // Alguns admin.html salvam todos os blocos pela própria rota /followup.
    // Se vierem comandos no mesmo payload, salva também para não perder o bloco 6 da tela.
    const temComandosNoPayload = req.body.comandos || req.body.followup || req.body.convertido || req.body.descartar || req.body.desfazer ||
      req.body.comando_followup || req.body.comando_convertido || req.body.comando_vendido || req.body.comando_descartar || req.body.comando_desfazer || req.body.comando_estornar;
    let comandosSalvos = null;
    if (temComandosNoPayload) {
      comandosSalvos = extrairComandosDoBody(req.body);
      await query(
        'UPDATE movatak_clientes SET comandos = $1::jsonb WHERE id = $2',
        [JSON.stringify(comandosSalvos), req.params.id]
      );
      console.log('[comandos][salvo-via-followup]', JSON.stringify({ clienteId: req.params.id, comandos: comandosSalvos }));
    }

    console.log('[followup][salvo]', JSON.stringify({ clienteId: req.params.id, followup_v2 }));
    res.json({ ok: true, followup_v2, comandos: comandosSalvos });
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


// Listar vendedores de um cliente
app.get('/movatak/admin/clientes/:id/vendedores', authMovatak, async (req, res) => {
  try {
    await garantirColunasVendedoresPortal();
    const r = await query(
      `SELECT id, cliente_id, nome, comando, email_acesso, acesso_token, ativo, criado_em,
              CASE WHEN senha_hash IS NULL OR senha_hash = '' THEN false ELSE true END AS tem_senha
         FROM movatak_vendedores
        WHERE cliente_id = $1 AND ativo = true
        ORDER BY nome`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch(e) {
    console.error('[admin/vendedores:list]', e.message);
    // Fallback para bancos antigos/parcialmente migrados: permite o painel abrir e mostra os dados básicos.
    try {
      const r2 = await query(
        `SELECT id, cliente_id, nome, NULL::text AS comando, NULL::text AS email_acesso,
                NULL::text AS acesso_token, ativo, criado_em, false AS tem_senha
           FROM movatak_vendedores
          WHERE cliente_id = $1 AND ativo = true
          ORDER BY nome`,
        [req.params.id]
      );
      return res.json(r2.rows);
    } catch(e2) {
      console.error('[admin/vendedores:list:fallback]', e2.message);
      res.status(500).json({ error: e.message });
    }
  }
});

// Cadastrar vendedor e criar etiqueta na Z-API
app.post('/movatak/admin/clientes/:id/vendedores', authMovatak, async (req, res) => {
  try {
    await garantirColunasVendedoresPortal();
    const { nome, email_acesso, senha_acesso, comando } = req.body;
    if (!nome) return res.status(400).json({ error: 'Nome obrigatorio.' });

    const rc = await query('SELECT * FROM movatak_clientes WHERE id = $1', [req.params.id]);
    if (!rc.rows.length) return res.status(404).json({ error: 'Cliente nao encontrado.' });
    const cliente = rc.rows[0];

    // Salvar vendedor — etiqueta deve ser criada manualmente no WhatsApp Business
    // com o nome exato: 'Vendedor - ' + nome
    const r = await query(
      `INSERT INTO movatak_vendedores (cliente_id, nome, email_acesso, senha_hash, acesso_token, comando)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, cliente_id, nome, comando, email_acesso, acesso_token, ativo, criado_em`,
      [req.params.id, nome, email_acesso || null, hashSenha(senha_acesso), gerarToken('vend'), comando ? String(comando).trim().toLowerCase() : null]
    );
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Remover vendedor
app.delete('/movatak/admin/clientes/:clienteId/vendedores/:id', authMovatak, async (req, res) => {
  try {
    await query('UPDATE movatak_vendedores SET ativo = false WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Ranking de vendedores
app.get('/movatak/admin/clientes/:id/ranking', authMovatak, async (req, res) => {
  try {
    const r = await query(
      `SELECT v.nome, COUNT(l.id) AS vendas, COUNT(l.id) FILTER (WHERE l.etapa = 'cliente') AS fechamentos
       FROM movatak_vendedores v
       LEFT JOIN movatak_leads l ON l.vendedor_id = v.id
       WHERE v.cliente_id = $1 AND v.ativo = true
       GROUP BY v.id, v.nome
       ORDER BY fechamentos DESC`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Ranking de vendedores para o app do cliente
app.get('/movatak/app/ranking', authCliente, async (req, res) => {
  try {
    const r = await query(
      `SELECT v.nome,
              COUNT(l.id) FILTER (WHERE l.etapa = 'cliente') AS fechamentos,
              COUNT(l.id) AS leads_atribuidos
       FROM movatak_vendedores v
       LEFT JOIN movatak_leads l ON l.vendedor_id = v.id
       WHERE v.cliente_id = $1 AND v.ativo = true
       GROUP BY v.id, v.nome
       ORDER BY fechamentos DESC`,
      [req.clienteId]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Evolução semanal (últimos 90 dias) para o app do cliente
app.get('/movatak/app/evolucao', authCliente, async (req, res) => {
  try {
    const r = await query(
      `SELECT
         DATE_TRUNC('week', criado_em) AS semana,
         COUNT(*) AS leads,
         COUNT(*) FILTER (WHERE etapa = 'cliente') AS convertidos
       FROM movatak_leads
       WHERE cliente_id = $1
         AND criado_em >= NOW() - INTERVAL '90 days'
       GROUP BY semana
       ORDER BY semana`,
      [req.clienteId]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Resumo completo para o app do cliente (somente leitura, via app_token)
app.get('/movatak/app/resumo', authCliente, async (req, res) => {
  try {
    const id = req.clienteId;
    const dias = [0, 7, 30, 90].includes(parseInt(req.query.dias))
      ? parseInt(req.query.dias) : 30;
    const periodoSQL = dias === 0
      ? "AND DATE(criado_em) = CURRENT_DATE"
      : `AND criado_em >= NOW() - INTERVAL '${dias} days'`;

    // Métricas do período
    const m = await query(
      `SELECT
         COUNT(*) FILTER (WHERE etapa != 'descartado')  AS total_leads,
         COUNT(*) FILTER (WHERE etapa = 'cliente')      AS convertidos,
         COUNT(*) FILTER (WHERE etapa = 'followup')     AS em_followup,
         COUNT(*) FILTER (WHERE DATE(criado_em) = CURRENT_DATE)                      AS leads_hoje,
         COUNT(*) FILTER (WHERE etapa = 'cliente' AND DATE(criado_em) = CURRENT_DATE) AS vendas_hoje
       FROM movatak_leads
       WHERE cliente_id = $1 ${periodoSQL}`,
      [id]
    );

    // Leads por hora do dia atual
    const h = await query(
      `SELECT EXTRACT(HOUR FROM criado_em)::int AS hora, COUNT(*) AS leads
       FROM movatak_leads
       WHERE cliente_id = $1 AND DATE(criado_em) = CURRENT_DATE
       GROUP BY hora ORDER BY hora`,
      [id]
    );
    const leadsPorHora = Array.from({ length: 24 }, (_, i) => {
      const found = h.rows.find(r => r.hora === i);
      return { hora: i, leads: found ? parseInt(found.leads) : 0 };
    });

    // Vendas por vendedor no período
    const v = await query(
      `SELECT vd.nome,
              COUNT(l.id) FILTER (WHERE l.etapa = 'cliente') AS fechamentos,
              COUNT(l.id) AS leads_atribuidos
       FROM movatak_vendedores vd
       LEFT JOIN movatak_leads l ON l.vendedor_id = vd.id ${periodoSQL.replace('criado_em', 'l.criado_em')}
       WHERE vd.cliente_id = $1 AND vd.ativo = true
       GROUP BY vd.id, vd.nome
       ORDER BY fechamentos DESC`,
      [id]
    );

    // CPL calculado
    const cd = await query(
      'SELECT teto_cpl, verba_diaria, criado_em FROM movatak_clientes WHERE id = $1',
      [id]
    );
    const dados = cd.rows[0] || {};
    const totalLeads = parseInt(m.rows[0].total_leads || 0);
    let investimento_total_campanhas = null;
    try {
      const inv = await query(
        `SELECT COALESCE(SUM(COALESCE(investimento_valor, verba_diaria, 0)),0) AS total
           FROM movatak_campanhas
          WHERE cliente_id = $1 AND ativo = true`,
        [id]
      );
      investimento_total_campanhas = inv.rows[0] ? inv.rows[0].total : null;
    } catch(e) {}
    let cpl_calculado = null, alerta_cpl = false;
    const investimentoBase = parseFloat(investimento_total_campanhas || 0) > 0 ? parseFloat(investimento_total_campanhas) : (dados.verba_diaria ? parseFloat(dados.verba_diaria) : null);
    if (investimentoBase && totalLeads > 0) {
      cpl_calculado = (investimentoBase / totalLeads).toFixed(2);
      if (dados.teto_cpl && parseFloat(cpl_calculado) > parseFloat(dados.teto_cpl)) alerta_cpl = true;
    }

    // Comparativo com período anterior
    const baseDias = dias === 0 ? 1 : dias;
    const comparativo = await query(
      `SELECT
         COUNT(*) FILTER (WHERE etapa != 'descartado')  AS total_leads,
         COUNT(*) FILTER (WHERE etapa = 'cliente')      AS convertidos,
         COUNT(*) FILTER (WHERE etapa = 'followup')     AS em_followup
       FROM movatak_leads
       WHERE cliente_id = $1
         AND criado_em >= NOW() - ($2 || ' days')::INTERVAL * 2
         AND criado_em <  NOW() - ($2 || ' days')::INTERVAL`,
      [id, baseDias]
    );

    const campanhaTop = await query(
      `SELECT c.nome, COUNT(l.id)::int AS leads,
              COUNT(l.id) FILTER (WHERE l.etapa = 'cliente')::int AS vendas
         FROM movatak_campanhas c
         LEFT JOIN movatak_leads l ON l.campanha_id = c.id
        WHERE c.cliente_id = $1
          AND l.criado_em >= NOW() - ($2 || ' days')::INTERVAL
        GROUP BY c.id, c.nome
        ORDER BY vendas DESC, leads DESC
        LIMIT 1`, [id, baseDias]
    ).catch(() => ({ rows: [] }));

    const permissoes = req.clientePermissoes || normalizarPermissoes({});
    const totalAtual = parseInt(m.rows[0].total_leads || 0);
    const convAtual = parseInt(m.rows[0].convertidos || 0);
    const totalAnt = parseInt((comparativo.rows[0] || {}).total_leads || 0);
    const convAnt = parseInt((comparativo.rows[0] || {}).convertidos || 0);
    const melhorVendedor = (v.rows || [])[0] || null;
    const resumo_executivo = `${req.clienteNome || 'Sua campanha'} recebeu ${totalAtual} lead${totalAtual === 1 ? '' : 's'} no período e gerou ${convAtual} venda${convAtual === 1 ? '' : 's'}. ` +
      `${melhorVendedor ? 'Melhor vendedor: ' + melhorVendedor.nome + ' com ' + melhorVendedor.fechamentos + ' venda(s). ' : ''}` +
      `${campanhaTop.rows[0] ? 'Campanha destaque: ' + campanhaTop.rows[0].nome + '. ' : ''}` +
      `${parseInt(m.rows[0].em_followup || 0)} lead(s) seguem em follow-up.`;

    res.json({
      cliente_nome: req.clienteNome,
      periodo_dias: dias,
      ...m.rows[0],
      leads_por_hora: leadsPorHora,
      vendedores: permissoes.ver_vendedores ? v.rows : [],
      permissoes,
      resumo_executivo,
      comparativo: { total_leads: totalAnt, convertidos: convAnt, delta_leads: totalAtual - totalAnt, delta_convertidos: convAtual - convAnt },
      campanha_top: campanhaTop.rows[0] || null,
      investimento_total_campanhas,
      cpl_calculado: permissoes.ver_cpl ? cpl_calculado : null,
      teto_cpl: permissoes.ver_cpl ? (dados.teto_cpl || null) : null,
      alerta_cpl: permissoes.ver_cpl ? alerta_cpl : false
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// Campanhas no portal do cliente
app.get('/movatak/app/campanhas', authCliente, async (req, res) => {
  try {
    await garantirEstruturaCampanhasTemplates();
    if (!req.clientePermissoes.ver_campanhas) return res.json([]);
    const dias = [0, 7, 30, 90].includes(parseInt(req.query.dias)) ? parseInt(req.query.dias) : 30;
    const periodo = dias === 0 ? "AND DATE(l.criado_em) = CURRENT_DATE" : `AND l.criado_em >= NOW() - INTERVAL '${dias} days'`;
    const r = await query(
      `WITH camp AS (
           SELECT c.*,
                  COUNT(*) OVER (PARTITION BY c.cliente_id, LOWER(TRIM(COALESCE(c.gatilho,'')))) AS qtd_mesmo_gatilho
             FROM movatak_campanhas c
            WHERE c.cliente_id = $1
              AND c.excluida_em IS NULL
        )
        SELECT c.id, c.nome, c.gatilho, c.verba_diaria, c.investimento_tipo, c.investimento_valor, c.ativo, t.nome AS template_nome,
              c.qtd_mesmo_gatilho::int AS campanhas_mesmo_gatilho,
              (c.qtd_mesmo_gatilho > 1) AS gatilho_compartilhado,
              COUNT(l.id)::int AS leads,
              COUNT(l.id) FILTER (WHERE l.etapa = 'cliente')::int AS vendas,
              COALESCE(ROUND((100.0 * COUNT(l.id) FILTER (WHERE l.etapa = 'cliente') / NULLIF(COUNT(l.id),0))::numeric, 1), 0) AS conversao,
              COALESCE(c.investimento_valor, c.verba_diaria, 0) AS investimento,
              CASE WHEN COUNT(l.id) > 0 THEN ROUND((COALESCE(c.investimento_valor, c.verba_diaria, 0) / NULLIF(COUNT(l.id),0))::numeric, 2) ELSE NULL END AS cpl,
              CASE WHEN COUNT(l.id) FILTER (WHERE l.etapa = 'cliente') > 0 THEN ROUND((COALESCE(c.investimento_valor, c.verba_diaria, 0) / NULLIF(COUNT(l.id) FILTER (WHERE l.etapa = 'cliente'),0))::numeric, 2) ELSE NULL END AS custo_venda
         FROM camp c
         LEFT JOIN movatak_followup_templates t ON t.id = c.template_id
         LEFT JOIN movatak_leads l
           ON (CASE WHEN c.qtd_mesmo_gatilho > 1
                    THEN LOWER(TRIM(COALESCE(l.gatilho_detectado,''))) = LOWER(TRIM(COALESCE(c.gatilho,'')))
                    ELSE l.campanha_id = c.id
               END) ${periodo}
        GROUP BY c.id, c.nome, c.gatilho, c.verba_diaria, c.investimento_tipo, c.investimento_valor, c.ativo, c.qtd_mesmo_gatilho, t.nome
        ORDER BY c.ativo DESC, vendas DESC, leads DESC`,
      [req.clienteId]
    );
    res.json(r.rows);
  } catch(e) { if (erroEstruturaBanco(e)) return res.json([]); res.status(500).json({ error: e.message }); }
});

app.get('/movatak/app/eventos', authCliente, async (req, res) => {
  try {
    if (!req.clientePermissoes.ver_eventos) return res.json([]);
    const r = await query(
      `SELECT e.id, e.tipo, e.descricao, e.criado_em, l.nome, l.telefone, l.etapa
         FROM movatak_lead_eventos e
         LEFT JOIN movatak_leads l ON l.id = e.lead_id
        WHERE e.cliente_id = $1
        ORDER BY e.criado_em DESC
        LIMIT 25`, [req.clienteId]
    );
    res.json(r.rows);
  } catch(e) { if (erroEstruturaBanco(e)) return res.json([]); res.status(500).json({ error: e.message }); }
});



app.get('/movatak/app/exportar-leads', authCliente, async (req, res) => {
  try {
    if (!req.clientePermissoes.exportar_csv) return res.status(403).json({ error: 'Exportação não liberada para este acesso.' });
    const r = await query(
      `SELECT l.id, l.nome, l.telefone, l.etapa, l.criado_em, l.atualizado_em,
              v.nome AS vendedor, c.nome AS campanha
         FROM movatak_leads l
         LEFT JOIN movatak_vendedores v ON v.id = l.vendedor_id
         LEFT JOIN movatak_campanhas c ON c.id = l.campanha_id
        WHERE l.cliente_id = $1
        ORDER BY l.criado_em DESC
        LIMIT 5000`, [req.clienteId]
    );
    const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const linhas = [['ID','Nome','Telefone','Etapa','Vendedor','Campanha','Criado em','Atualizado em'].map(esc).join(',')]
      .concat(r.rows.map(x => [x.id,x.nome,x.telefone,x.etapa,x.vendedor,x.campanha,x.criado_em,x.atualizado_em].map(esc).join(',')));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="leads-movatak.csv"');
    res.send('\ufeff' + linhas.join('\n'));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/app/configuracoes', authCliente, async (req, res) => {
  try {
    const dados = await query('SELECT followup_msgs_v2, boas_vindas_msg, trigger_msg, comandos, permissoes_portal FROM movatak_clientes WHERE id = $1', [req.clienteId]);
    const vendedores = req.clientePermissoes.editar_vendedores ? await query(
      `SELECT id, nome, comando, email_acesso, acesso_token, CASE WHEN senha_hash IS NULL OR senha_hash = '' THEN false ELSE true END AS tem_senha FROM movatak_vendedores WHERE cliente_id = $1 AND ativo = true ORDER BY nome`, [req.clienteId]
    ) : { rows: [] };
    let templates = Object.entries(TEMPLATES_FOLLOWUP).map(([id, t]) => ({ id, nome: t.nome, tipo: 'padrao' }));
    if (req.clientePermissoes.editar_campanhas || req.clientePermissoes.editar_followup) {
      try {
        const custom = (await listarTemplatesCustom(req.clienteId)).map(t => ({ id: 'custom:' + t.id, nome: t.nome, tipo: 'cliente' }));
        templates = [...templates, ...custom];
      } catch(e) {}
    }
    res.json({ permissoes: req.clientePermissoes, cliente: dados.rows[0] || {}, vendedores: vendedores.rows, templates });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/app/followup', authCliente, async (req, res) => {
  try {
    if (!req.clientePermissoes.editar_followup) return res.status(403).json({ error: 'Este cliente não tem permissão para editar follow-up.' });
    const { followup_v2, boas_vindas_msg } = req.body || {};
    await query(`UPDATE movatak_clientes SET followup_msgs_v2 = COALESCE($1::jsonb, followup_msgs_v2), boas_vindas_msg = COALESCE($2, boas_vindas_msg) WHERE id = $3`,
      [followup_v2 ? JSON.stringify(followup_v2) : null, boas_vindas_msg || null, req.clienteId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/app/vendedores', authCliente, async (req, res) => {
  try {
    if (!req.clientePermissoes.editar_vendedores) return res.status(403).json({ error: 'Este cliente não tem permissão para cadastrar vendedores.' });
    const { nome, comando, email_acesso, senha_acesso } = req.body || {};
    if (!nome) return res.status(400).json({ error: 'Nome obrigatório.' });
    const r = await query(`INSERT INTO movatak_vendedores (cliente_id, nome, comando, email_acesso, senha_hash, acesso_token) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, nome, comando, email_acesso, acesso_token`,
      [req.clienteId, String(nome).trim(), comando ? String(comando).trim().toLowerCase() : null, email_acesso || null, hashSenha(senha_acesso), gerarToken('vend')]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/app/vendedores/:id', authCliente, async (req, res) => {
  try {
    if (!req.clientePermissoes.editar_vendedores) return res.status(403).json({ error: 'Este cliente não tem permissão para editar vendedores.' });
    const { nome, comando, email_acesso, senha_acesso } = req.body || {};
    const campos = [], valores = [];
    let idx = 1;
    if (nome !== undefined) { campos.push('nome = $' + idx++); valores.push(String(nome).trim()); }
    if (comando !== undefined) { campos.push('comando = $' + idx++); valores.push(comando ? String(comando).trim().toLowerCase() : null); }
    if (email_acesso !== undefined) { campos.push('email_acesso = $' + idx++); valores.push(email_acesso ? String(email_acesso).trim().toLowerCase() : null); }
    if (senha_acesso) { campos.push('senha_hash = $' + idx++); valores.push(hashSenha(senha_acesso)); }
    if (!campos.length) return res.json({ ok: true });
    valores.push(req.clienteId, req.params.id);
    const r = await query(`UPDATE movatak_vendedores SET ${campos.join(', ')} WHERE cliente_id = $${idx++} AND id = $${idx} RETURNING id, nome, comando, email_acesso, acesso_token`, valores);
    if (!r.rows.length) return res.status(404).json({ error: 'Vendedor não encontrado.' });
    res.json({ ok: true, vendedor: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/app/campanhas', authCliente, async (req, res) => {
  try {
    await garantirEstruturaCampanhasTemplates();
    if (!req.clientePermissoes.editar_campanhas) return res.status(403).json({ error: 'Este cliente não tem permissão para cadastrar campanhas.' });
    const { nome, gatilho, verba_diaria, investimento_tipo, investimento_valor, template_id } = req.body || {};
    if (!nome) return res.status(400).json({ error: 'Nome da campanha é obrigatório.' });
    const gatilhoFinal = gatilho ? String(gatilho).trim() : null;
    if (!gatilhoFinal) return res.status(400).json({ error: 'Frase-gatilho da campanha é obrigatória.' });
    const investimentoTipo = ['diario','total'].includes(String(investimento_tipo || '').toLowerCase()) ? String(investimento_tipo).toLowerCase() : 'diario';
    const investimentoValor = parseMoedaParaNumero(investimento_valor !== undefined ? investimento_valor : verba_diaria);
    // A partir da v2.1.3 permitimos o mesmo gatilho em mais de uma campanha.
    // Observação: quando isso acontece, a atribuição exata por campanha fica compartilhada pelo gatilho.
    const templateDbId = await resolverTemplateCampanha(req.clienteId, template_id);
    const r = await query(`INSERT INTO movatak_campanhas (cliente_id, nome, gatilho, verba_diaria, investimento_tipo, investimento_valor, template_id, ativo) VALUES ($1,$2,$3,$4,$5,$6,$7,true) RETURNING *`,
      [req.clienteId, String(nome).trim(), gatilhoFinal, investimentoValor, investimentoTipo, investimentoValor, templateDbId]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Atualizar whatsapp_dono
app.patch('/movatak/admin/clientes/:id/dono', authMovatak, async (req, res) => {
  try {
    const { whatsapp_dono } = req.body;
    await query('UPDATE movatak_clientes SET whatsapp_dono = $1 WHERE id = $2', [whatsapp_dono, req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// ROTA UNIFICADA — Webhook Z-API (substitui /webhook/mensagem,
// /webhook/etiqueta e /webhook/resposta)
// Trata: novo lead, comandos #followup/#convertido/#vendedor,
// pausa de followup ao responder. Repassa payload ao rastreiobot.
// ============================================================
const RASTREIOBOT_URL = process.env.RASTREIOBOT_URL || 'https://rastreiobot-production-e904.up.railway.app';

// Normaliza texto para comparar comandos e gatilhos
function normalizarTexto(t) {
  return (t || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Normalização mais agressiva para frase-gatilho de tráfego.
// Corrige diferenças comuns como "PROV>>" vs "PROV >>", acentos e espaços duplicados.
function normalizarGatilho(t) {
  return normalizarTexto(t)
    .replace(/\s*>>\s*/g, '>>')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function textoBateGatilho(texto, gatilho) {
  const msg = normalizarGatilho(texto);
  const trigger = normalizarGatilho(gatilho);
  if (!trigger || !msg) return false;

  // Comparação principal: mensagem contém gatilho ou gatilho contém mensagem.
  // A segunda condição ajuda quando o anúncio/WhatsApp corta parte do texto.
  if (msg.includes(trigger) || trigger.includes(msg)) return true;

  // Fallback seguro: ignora o prefixo antes de >> e compara o corpo da frase.
  // Ex.: "PROV>> Olá!..." e "PROV >> Olá!..."
  const corpoMsg = msg.includes('>>') ? msg.split('>>').slice(1).join('>>').trim() : msg;
  const corpoTrigger = trigger.includes('>>') ? trigger.split('>>').slice(1).join('>>').trim() : trigger;
  return !!corpoTrigger && !!corpoMsg && (corpoMsg.includes(corpoTrigger) || corpoTrigger.includes(corpoMsg));
}

// Verifica se o texto contém algum dos comandos da lista
function contemComando(texto, comandos) {
  if (!Array.isArray(comandos) || !comandos.length) return false;
  const t = normalizarTexto(texto);
  return comandos.some(cmd => {
    const c = normalizarTexto(cmd);
    return c && t.includes(c);
  });
}

function slugComando(nome) {
  return normalizarTexto(nome).replace(/[^a-z0-9]+/g, '');
}

function comandosDoVendedor(vendedor) {
  const lista = [];

  // Campo oficial: comando (ex.: #rebeka)
  if (vendedor.comando) lista.push(String(vendedor.comando));

  // Segurança caso algum cadastro antigo tenha salvo mais de um comando no mesmo campo
  if (vendedor.comando && String(vendedor.comando).includes(',')) {
    String(vendedor.comando).split(',').forEach(c => lista.push(c));
  }

  // Segurança caso exista uma coluna JSON/array chamada comandos em algum banco já migrado
  if (Array.isArray(vendedor.comandos)) {
    vendedor.comandos.forEach(c => lista.push(c));
  }

  // Fallback automático pelo nome do vendedor.
  // Ex.: Rebeka => #rebeka | Ronaldo Valério => #ronaldovalerio
  const slug = slugComando(vendedor.nome || '');
  if (slug) {
    lista.push('#' + slug);
    lista.push(slug);
  }

  return [...new Set(
    lista
      .map(c => String(c || '').trim().toLowerCase())
      .filter(Boolean)
  )];
}

function vendedorBateComando(vendedor, texto) {
  return contemComando(texto, comandosDoVendedor(vendedor));
}

function textoPareceComandoInterno(texto, comandos, vendedores) {
  const t = String(texto || '').trim();
  if (!t) return false;
  // Segurança: comandos internos devem começar com #. Isso evita que uma mensagem comum enviada pela equipe seja interpretada como automação.
  if (!t.startsWith('#')) return false;
  if (contemComando(t, comandos.followup || [])) return true;
  if (contemComando(t, comandos.convertido || [])) return true;
  if (contemComando(t, comandos.descartar || [])) return true;
  if (contemComando(t, comandos.desfazer || [])) return true;
  return Array.isArray(vendedores) && vendedores.some(v => vendedorBateComando(v, t));
}


// Extrai telefone numérico de vários formatos possíveis do payload Z-API.
// Em alguns eventos fromMe, o phone pode vir como @lid; por isso testamos campos alternativos.
function extrairTelefonePayload(body) {
  const candidatos = [
    body.phone,
    body.senderPhone,
    body.connectedPhone,
    body.participantPhone,
    body.from,
    body.to
  ];

  for (const valor of candidatos) {
    if (!valor) continue;
    const raw = String(valor);
    if (raw.includes('@lid') || raw.includes('@g.us') || raw.includes('@newsletter')) continue;
    const digitos = raw.replace(/\D/g, '');
    if (digitos.length >= 10 && digitos.length <= 15) return digitos;
  }

  return null;
}

app.post('/movatak/webhook/zapi', async (req, res) => {
  res.json({ ok: true }); // responde imediato

  const body = req.body || {};

  // ---- Repasse para o rastreiobot (mantém DTF funcionando) ----
  try {
    await axios.post(`${RASTREIOBOT_URL}/webhook/zapi`, body, { timeout: 8000 });
  } catch (e) {
    console.error('[zapi] repasse rastreiobot falhou:', e.message);
  }

  // ---- Processamento Movatak ----
  try {
    const instanceId = body.instanceId || body.instance || '';
    const chatLid    = body.chatLid || null;
    const phoneRaw   = String(body.phone || '');
    // Telefone real: tenta extrair de vários campos porque eventos fromMe podem vir com @lid
    const telefone   = extrairTelefonePayload(body);
    const texto      = (body.text && body.text.message) ? body.text.message
                       : (typeof body.text === 'string' ? body.text : '');

    logDebug('[zapi][entrada]', JSON.stringify({
      fromMe: !!body.fromMe,
      isGroup: !!body.isGroup,
      isNewsletter: !!body.isNewsletter,
      instanceId,
      chatLid,
      phone: body.phone || null,
      telefoneExtraido: telefone,
      senderName: body.senderName || null,
      texto: texto || null,
      keys: Object.keys(body).slice(0, 30)
    }));

    if (body.isGroup || body.isNewsletter) {
      logDebug('[zapi][ignorado] grupo ou newsletter');
      return;
    }

    if (!instanceId) {
      logDebug('[zapi][ignorado] payload sem instanceId/instance');
      return;
    }

    // Buscar cliente pela instância
    const rc = await query(
      'SELECT * FROM movatak_clientes WHERE zapi_instance = $1 AND ativo = true',
      [instanceId]
    );
    if (!rc.rows.length) {
      console.log('[zapi][ignorado] nenhum cliente ativo encontrado para instanceId ' + instanceId);
      return;
    }
    const cliente = rc.rows[0];
    const comandos = cliente.comandos || {};
    await registrarWebhookCliente(cliente.id, {
      fromMe: !!body.fromMe,
      isGroup: !!body.isGroup,
      telefone,
      chatLid,
      tipo: body.type || null,
      texto_preview: texto ? String(texto).slice(0, 120) : null
    });
    logDebug('[zapi][cliente]', cliente.nome + ' id=' + cliente.id);

    // ===== MENSAGEM ENVIADA PELO VENDEDOR (fromMe) =====
    // Busca o lead primeiro pelo chat_lid. Se não encontrar, usa telefone como fallback.
    // Isso corrige casos em que leads antigos ainda não tinham chat_lid salvo.
    if (body.fromMe) {
      logDebug('[zapi][fromMe] recebido', JSON.stringify({ texto, chatLid, telefone }));

      const rvPre = await query(
        'SELECT * FROM movatak_vendedores WHERE cliente_id = $1 AND ativo = true',
        [cliente.id]
      );

      if (!textoPareceComandoInterno(texto, comandos, rvPre.rows)) {
        logDebug('[zapi][fromMe] mensagem enviada sem comando interno — ignorada pelo CRM');
        return;
      }

      let rl;

      if (chatLid) {
        rl = await query(
          'SELECT * FROM movatak_leads WHERE cliente_id = $1 AND chat_lid = $2 ORDER BY atualizado_em DESC NULLS LAST, criado_em DESC LIMIT 1',
          [cliente.id, chatLid]
        );
      }

      if ((!rl || !rl.rows.length) && telefone) {
        rl = await query(
          'SELECT * FROM movatak_leads WHERE cliente_id = $1 AND telefone = $2 ORDER BY atualizado_em DESC NULLS LAST, criado_em DESC LIMIT 1',
          [cliente.id, telefone]
        );
      }

      if (!rl || !rl.rows.length) {
        console.log('[zapi] comando ignorado — lead nao encontrado para chatLid ' + (chatLid || 'sem-chatLid') + ' telefone ' + (telefone || 'sem-telefone'));
        return;
      }

      const lead = rl.rows[0];

      // Se encontrou pelo telefone, já grava o chat_lid para os próximos comandos funcionarem direto.
      if (chatLid && lead.chat_lid !== chatLid) {
        await query('UPDATE movatak_leads SET chat_lid = $1, atualizado_em = NOW() WHERE id = $2', [chatLid, lead.id]);
        lead.chat_lid = chatLid;
      }

      // -- Comando: vendedor especifico (conversao atribuida) --
      const rv = { rows: rvPre.rows };
      const vendedorDetectado = rv.rows.find(v => vendedorBateComando(v, texto));
      if (!vendedorDetectado) {
        console.log('[zapi][fromMe] nenhum vendedor bateu com o comando. Cadastrados:', JSON.stringify(
          rv.rows.map(v => ({ nome: v.nome, comando: v.comando || null, comandos_validos: comandosDoVendedor(v) }))
        ));
      }
      if (vendedorDetectado) {
        await query(
          `UPDATE movatak_leads SET etapa = 'cliente', vendedor_id = $1, atualizado_em = NOW() WHERE id = $2`,
          [vendedorDetectado.id, lead.id]
        );
        await query(
          `UPDATE movatak_followup SET status = 'pausado' WHERE lead_id = $1 AND status = 'pendente'`,
          [lead.id]
        );
        await registrarEventoLead(lead.id, cliente.id, 'convertido_vendedor', `Lead convertido por ${vendedorDetectado.nome}`, { vendedor_id: vendedorDetectado.id, comando: texto });
        console.log(`[zapi] Convertido por ${vendedorDetectado.nome} -> lead ${lead.id}`);
        return;
      }

      // -- Comando: convertido --
      if (contemComando(texto, comandos.convertido)) {
        await query(
          `UPDATE movatak_leads SET etapa = 'cliente', atualizado_em = NOW() WHERE id = $1`,
          [lead.id]
        );
        await query(
          `UPDATE movatak_followup SET status = 'pausado' WHERE lead_id = $1 AND status = 'pendente'`,
          [lead.id]
        );
        await registrarEventoLead(lead.id, cliente.id, 'convertido', 'Lead marcado como cliente por comando geral', { comando: texto });
        console.log(`[zapi] Convertido -> lead ${lead.id}`);
        return;
      }

      // -- Comando: descartar --
      if (contemComando(texto, comandos.descartar)) {
        await query(
          `UPDATE movatak_leads SET etapa = 'descartado', atualizado_em = NOW() WHERE id = $1`,
          [lead.id]
        );
        await query(
          `UPDATE movatak_followup SET status = 'pausado' WHERE lead_id = $1 AND status = 'pendente'`,
          [lead.id]
        );
        await registrarEventoLead(lead.id, cliente.id, 'descartado', 'Lead descartado por comando', { comando: texto });
        console.log(`[zapi] Descartado -> lead ${lead.id}`);
        return;
      }

      // -- Comando: desfazer venda (so reverte se o lead estiver convertido) --
      if (contemComando(texto, comandos.desfazer)) {
        if (lead.etapa === 'cliente') {
          await query(
            `UPDATE movatak_leads SET etapa = 'lead', vendedor_id = NULL, atualizado_em = NOW() WHERE id = $1`,
            [lead.id]
          );
          await registrarEventoLead(lead.id, cliente.id, 'venda_desfeita', 'Conversão revertida por comando', { comando: texto });
          console.log(`[zapi] Venda desfeita -> lead ${lead.id}`);
        } else {
          console.log(`[zapi] Desfazer ignorado — lead ${lead.id} nao estava convertido`);
        }
        return;
      }

      // -- Comando: followup --
      if (contemComando(texto, comandos.followup)) {
        await query(
          `UPDATE movatak_leads SET etapa = 'followup', atualizado_em = NOW() WHERE id = $1`,
          [lead.id]
        );
        // Follow-up manual entra no FU2 (reativacao)
        await agendarFollowupV2(lead.id, cliente.id, 2, true);
        await registrarEventoLead(lead.id, cliente.id, 'followup_manual', 'Follow-up FU2 ativado manualmente por comando', { comando: texto });
        console.log(`[zapi] Follow up FU2 ativado -> lead ${lead.id}`);
        return;
      }

      // Evita poluir o log com mensagens normais enviadas pelo próprio WhatsApp
      // conectado, como avisos de rastreio, pós-venda e respostas manuais.
      if (texto && texto.trim().startsWith('#')) {
        console.log('[zapi][fromMe] mensagem do vendedor sem comando reconhecido:', texto || '(sem texto)');
      } else {
        logDebug('[zapi][fromMe] mensagem enviada sem comando interno — ignorada pelo CRM');
      }
      return; // mensagem do vendedor sem comando reconhecido
    }

    // ===== MENSAGEM RECEBIDA DO LEAD =====
    if (!String(texto || '').trim()) {
      logDebug('[zapi][lead] ignorado: evento sem texto util');
      return;
    }

    if (!telefone) {
      console.log('[zapi][lead] ignorado: nao consegui extrair telefone real do payload');
      return;
    }

    // Buscar lead pelo telefone
    const rl = await query(
      'SELECT * FROM movatak_leads WHERE cliente_id = $1 AND telefone = $2',
      [cliente.id, telefone]
    );
    const lead = rl.rows[0] || null;

    // Calcula o gatilho antes de tratar lead existente.
    // Assim, se a mesma pessoa clicar no anúncio novamente, conseguimos reativar o FU1.
    const campanhaDetectada = await localizarCampanhaPorGatilho(cliente.id, texto);
    const msg = normalizarGatilho(texto);
    const trigger = normalizarGatilho(campanhaDetectada ? campanhaDetectada.gatilho : cliente.trigger_msg);
    const triggerOk = !!campanhaDetectada || textoBateGatilho(texto, cliente.trigger_msg);

    // -- Lead existe: garantir chat_lid salvo + pausar followup se respondeu --
    if (lead) {
      // Salva o chat_lid se ainda nao tiver (essencial para os comandos)
      if (chatLid && lead.chat_lid !== chatLid) {
        await query('UPDATE movatak_leads SET chat_lid = $1, atualizado_em = NOW() WHERE id = $2', [chatLid, lead.id]);
      }

      // Se o lead ja existia e clicou no anuncio/frase-gatilho de novo,
      // reabre o atendimento e agenda novamente o FU1, exceto se ja estiver convertido.
      if (triggerOk && lead.etapa !== 'cliente') {
        if (!(await reentradaFU1Permitida(lead.id))) {
          await registrarEventoLead(lead.id, cliente.id, 'anti_spam_reentrada', 'Reentrada no FU1 bloqueada por intervalo mínimo', { telefone, horas: MOVATAK_REENTRADA_FU1_HORAS });
          console.log(`[anti-spam] reentrada FU1 bloqueada -> lead ${lead.id}`);
          return;
        }
        await query(
          `UPDATE movatak_leads
             SET etapa = 'followup', nome = COALESCE($1, nome), atualizado_em = NOW()
           WHERE id = $2`,
          [body.senderName || null, lead.id]
        );
        if (campanhaDetectada) {
          await query('UPDATE movatak_leads SET campanha_id = COALESCE(campanha_id, $1), campanha_id_ultimo_toque = $1, template_id_origem = COALESCE(template_id_origem, $2), gatilho_detectado = $3 WHERE id = $4', [campanhaDetectada.id, campanhaDetectada.template_id || null, campanhaDetectada.gatilho || null, lead.id]).catch(() => null);
        }
        await agendarFollowupV2(lead.id, cliente.id, 1, true);
        await enviarFollowupsPendentesDoLead(lead.id, 1);
        await registrarEventoLead(lead.id, cliente.id, 'reativado_gatilho', 'Lead existente reativado no FU1 por nova frase-gatilho', { telefone, texto });
        console.log(`[zapi] Lead existente reativado em FU1 -> lead ${lead.id} telefone ${telefone}`);
        return;
      }

      if (lead.etapa === 'followup') {
        await query(
          `UPDATE movatak_leads SET etapa = 'lead', atualizado_em = NOW() WHERE id = $1`,
          [lead.id]
        );
        await query(
          `UPDATE movatak_followup SET status = 'pausado' WHERE lead_id = $1 AND status = 'pendente'`,
          [lead.id]
        );
        await registrarEventoLead(lead.id, cliente.id, 'lead_respondeu', 'Lead respondeu e saiu do follow-up', { texto_preview: texto ? String(texto).slice(0, 160) : null });
        console.log(`[zapi] Follow up pausado e lead voltou para atendimento -> lead ${lead.id}`);
      }
      return;
    }

    // -- Novo lead: mensagem bate com o trigger do trafego --
    console.log('[zapi][novo-lead] comparando trigger', JSON.stringify({
      msg_original: texto,
      trigger_original: cliente.trigger_msg,
      msg,
      trigger,
      triggerOk
    }));
    if (triggerOk) {
      const novoLead = await query(
        `INSERT INTO movatak_leads
           (cliente_id, telefone, nome, etapa, chat_lid, campanha_id, campanha_id_ultimo_toque, template_id_origem, gatilho_detectado)
         VALUES ($1, $2, $3, 'followup', $4, $5, $5, $6, $7)
         RETURNING id`,
        [cliente.id, telefone, body.senderName || null, chatLid, campanhaDetectada ? campanhaDetectada.id : null, campanhaDetectada ? (campanhaDetectada.template_id || null) : null, campanhaDetectada ? (campanhaDetectada.gatilho || null) : null]
      );
      await registrarEventoLead(novoLead.rows[0].id, cliente.id, 'lead_criado', 'Lead criado pela rota unificada da Z-API', { telefone, chatLid, texto, campanha_id: campanhaDetectada ? campanhaDetectada.id : null });
      await agendarFollowupV2(novoLead.rows[0].id, cliente.id, 1, true);
      await enviarFollowupsPendentesDoLead(novoLead.rows[0].id, 1);
      console.log(`[zapi] Novo lead criado em FU1 -> ${telefone} (${cliente.nome})`);
    }
  } catch (e) {
    console.error('[zapi] erro processamento:', e.message);
  }
});

// ============================================================
// API — Comandos de automação por cliente
// ============================================================

function normalizarListaComandos(input) {
  if (input == null) return [];
  const bruto = Array.isArray(input) ? input.join(',') : String(input);
  return bruto
    .split(/[\n,;]+/)
    .map(s => String(s).trim().toLowerCase())
    .filter(Boolean)
    .filter((v, i, arr) => arr.indexOf(v) === i);
}

function extrairComandosDoBody(body) {
  const src = body.comandos && typeof body.comandos === 'object' ? body.comandos : body;
  return {
    followup: normalizarListaComandos(src.followup || src.comando_followup || src.comandos_followup),
    convertido: normalizarListaComandos(src.convertido || src.comando_convertido || src.comando_convertido_venda || src.vendido || src.comando_vendido),
    descartar: normalizarListaComandos(src.descartar || src.comando_descartar || src.descartado || src.comando_descartado),
    desfazer: normalizarListaComandos(src.desfazer || src.comando_desfazer || src.estornar || src.comando_estornar)
  };
}

// Buscar comandos de um cliente
app.get('/movatak/admin/clientes/:id/comandos', authMovatak, async (req, res) => {
  try {
    const r = await query(
      'SELECT comandos FROM movatak_clientes WHERE id = $1', [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Cliente nao encontrado.' });
    res.json(r.rows[0].comandos || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Atualizar comandos de um cliente
app.patch('/movatak/admin/clientes/:id/comandos', authMovatak, async (req, res) => {
  try {
    // O painel envia os comandos como texto: "#vendido, #fechou".
    // A versão anterior só aceitava arrays, por isso a tela parecia salvar, mas voltava ao padrão.
    const comandos = extrairComandosDoBody(req.body);

    // Validação: nenhum comando pode se repetir entre os campos
    const todos = [
      ...comandos.followup, ...comandos.convertido,
      ...comandos.descartar, ...comandos.desfazer
    ];
    const duplicado = todos.find((c, i) => todos.indexOf(c) !== i);
    if (duplicado) {
      return res.status(400).json({ error: 'O comando "' + duplicado + '" esta repetido. Cada comando deve ser unico.' });
    }

    // Validação: não pode colidir com comando de vendedor já cadastrado
    const rv = await query(
      'SELECT comando FROM movatak_vendedores WHERE cliente_id = $1 AND ativo = true AND comando IS NOT NULL',
      [req.params.id]
    );
    const cmdsVendedores = rv.rows
      .flatMap(r => normalizarListaComandos(r.comando))
      .map(c => String(c).trim().toLowerCase());
    const colisao = todos.find(c => cmdsVendedores.includes(c));
    if (colisao) {
      return res.status(400).json({ error: 'O comando "' + colisao + '" ja pertence a um vendedor.' });
    }

    await query(
      'UPDATE movatak_clientes SET comandos = $1::jsonb WHERE id = $2',
      [JSON.stringify(comandos), req.params.id]
    );
    console.log('[comandos][salvo]', JSON.stringify({ clienteId: req.params.id, comandos }));
    res.json({ ok: true, comandos });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Atualizar comando de um vendedor
app.patch('/movatak/admin/vendedores/:id/comando', authMovatak, async (req, res) => {
  try {
    await garantirColunasVendedoresPortal();
    const comando = req.body.comando ? String(req.body.comando).trim().toLowerCase() : null;

    if (comando) {
      // Descobrir o cliente deste vendedor
      const rv = await query('SELECT cliente_id FROM movatak_vendedores WHERE id = $1', [req.params.id]);
      if (!rv.rows.length) return res.status(404).json({ error: 'Vendedor nao encontrado.' });
      const clienteId = rv.rows[0].cliente_id;

      // Não pode colidir com comandos do cliente
      const rc = await query('SELECT comandos FROM movatak_clientes WHERE id = $1', [clienteId]);
      const cmds = rc.rows[0] && rc.rows[0].comandos ? rc.rows[0].comandos : {};
      const todosCliente = [
        ...(cmds.followup || []), ...(cmds.convertido || []),
        ...(cmds.descartar || []), ...(cmds.desfazer || [])
      ].map(c => String(c).trim().toLowerCase());
      if (todosCliente.includes(comando)) {
        return res.status(400).json({ error: 'Esse comando ja esta em uso na automacao do cliente.' });
      }

      // Não pode colidir com outro vendedor
      const ro = await query(
        'SELECT comando FROM movatak_vendedores WHERE cliente_id = $1 AND id != $2 AND ativo = true AND comando IS NOT NULL',
        [clienteId, req.params.id]
      );
      if (ro.rows.some(r => String(r.comando).trim().toLowerCase() === comando)) {
        return res.status(400).json({ error: 'Esse comando ja pertence a outro vendedor.' });
      }
    }

    await query(
      'UPDATE movatak_vendedores SET comando = $1 WHERE id = $2',
      [comando, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});



// Atualizar acesso do vendedor ao portal individual
app.patch('/movatak/admin/vendedores/:id/acesso', authMovatak, async (req, res) => {
  try {
    await garantirColunasVendedoresPortal();
    const { email_acesso, senha_acesso, nome, comando } = req.body || {};
    const campos = [];
    const valores = [];
    let idx = 1;
    if (nome !== undefined) { campos.push('nome = $' + idx++); valores.push(String(nome).trim()); }
    if (email_acesso !== undefined) { campos.push('email_acesso = $' + idx++); valores.push(email_acesso ? String(email_acesso).trim().toLowerCase() : null); }
    if (senha_acesso) { campos.push('senha_hash = $' + idx++); valores.push(hashSenha(senha_acesso)); }
    if (comando !== undefined) { campos.push('comando = $' + idx++); valores.push(comando ? String(comando).trim().toLowerCase() : null); }
    if (!campos.length) return res.json({ ok: true });
    valores.push(req.params.id);
    const r = await query(`UPDATE movatak_vendedores SET ${campos.join(', ')} WHERE id = $${idx} RETURNING id, nome, comando, email_acesso, acesso_token`, valores);
    if (!r.rows.length) return res.status(404).json({ error: 'Vendedor não encontrado.' });
    res.json({ ok: true, vendedor: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/vendedor/login', async (req, res) => {
  try {
    await garantirColunasVendedoresPortal();
    const { email, senha } = req.body || {};
    if (!email || !senha) return res.status(400).json({ error: 'Informe email e senha.' });
    const r = await query(
      `SELECT v.id, v.nome, v.email_acesso, v.acesso_token, c.nome AS cliente_nome
         FROM movatak_vendedores v
         JOIN movatak_clientes c ON c.id = v.cliente_id
        WHERE LOWER(v.email_acesso) = LOWER($1) AND v.senha_hash = $2 AND v.ativo = true AND c.ativo = true
        LIMIT 1`,
      [String(email).trim().toLowerCase(), hashSenha(senha)]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'Acesso inválido.' });
    res.json({ token: r.rows[0].acesso_token, vendedor: { nome: r.rows[0].nome, cliente_nome: r.rows[0].cliente_nome } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/vendedor/resumo', authVendedor, async (req, res) => {
  try {
    const dias = [0, 7, 30, 90].includes(parseInt(req.query.dias)) ? parseInt(req.query.dias) : 30;
    const periodoSQL = dias === 0 ? "AND DATE(l.criado_em) = CURRENT_DATE" : `AND l.criado_em >= NOW() - INTERVAL '${dias} days'`;
    const m = await query(
      `SELECT COUNT(l.id)::int AS leads_atribuidos,
              COUNT(l.id) FILTER (WHERE l.etapa = 'cliente')::int AS vendas,
              COUNT(l.id) FILTER (WHERE l.etapa = 'followup')::int AS em_followup,
              COUNT(l.id) FILTER (WHERE DATE(l.criado_em) = CURRENT_DATE)::int AS leads_hoje,
              COUNT(l.id) FILTER (WHERE l.etapa = 'cliente' AND DATE(l.criado_em) = CURRENT_DATE)::int AS vendas_hoje
         FROM movatak_leads l
        WHERE l.vendedor_id = $1 ${periodoSQL}`,
      [req.vendedor.id]
    );
    const ranking = await query(
      `SELECT v.nome,
              COUNT(l.id) FILTER (WHERE l.etapa = 'cliente')::int AS vendas
         FROM movatak_vendedores v
         LEFT JOIN movatak_leads l ON l.vendedor_id = v.id AND l.criado_em >= NOW() - INTERVAL '30 days'
        WHERE v.cliente_id = $1 AND v.ativo = true
        GROUP BY v.id, v.nome
        ORDER BY vendas DESC`,
      [req.vendedor.cliente_id]
    );
    const eventos = await query(
      `SELECT l.id, l.nome, l.telefone, l.etapa, l.criado_em, l.atualizado_em
         FROM movatak_leads l
        WHERE l.vendedor_id = $1
        ORDER BY l.atualizado_em DESC NULLS LAST, l.criado_em DESC
        LIMIT 30`,
      [req.vendedor.id]
    );
    const row = m.rows[0] || {};
    const total = parseInt(row.leads_atribuidos || 0);
    const vendas = parseInt(row.vendas || 0);
    res.json({ vendedor: req.vendedor, periodo_dias: dias, ...row, taxa_conversao: total ? ((vendas/total)*100).toFixed(1) : '0.0', ranking: ranking.rows, leads: eventos.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// API — Resumo de um cliente (cards do topo do dashboard)
// ============================================================
app.get('/movatak/admin/clientes/:id/resumo', authMovatak, async (req, res) => {
  try {
    const id = req.params.id;
    // Período em dias: 0 = hoje, 7, 30, 90. Default 30.
    const dias = [0, 7, 30, 90].includes(parseInt(req.query.dias))
      ? parseInt(req.query.dias) : 30;

    // Cláusula de período reutilizável
    const periodoSQL = dias === 0
      ? "AND DATE(criado_em) = CURRENT_DATE"
      : `AND criado_em >= NOW() - INTERVAL '${dias} days'`;

    // Métricas do cliente no período
    const m = await query(
      `SELECT
         COUNT(*) FILTER (WHERE etapa != 'descartado')  AS total_leads,
         COUNT(*) FILTER (WHERE etapa = 'cliente')      AS convertidos,
         COUNT(*) FILTER (WHERE etapa = 'followup')     AS em_followup,
         COUNT(*) FILTER (WHERE DATE(criado_em) = CURRENT_DATE)                      AS leads_hoje,
         COUNT(*) FILTER (WHERE etapa = 'cliente' AND DATE(criado_em) = CURRENT_DATE) AS vendas_hoje
       FROM movatak_leads
       WHERE cliente_id = $1 ${periodoSQL}`,
      [id]
    );

    // Leads por hora do dia de hoje (0-23) — sempre do dia atual
    const h = await query(
      `SELECT EXTRACT(HOUR FROM criado_em)::int AS hora, COUNT(*) AS leads
       FROM movatak_leads
       WHERE cliente_id = $1 AND DATE(criado_em) = CURRENT_DATE
       GROUP BY hora ORDER BY hora`,
      [id]
    );
    const leadsPorHora = Array.from({ length: 24 }, (_, i) => {
      const found = h.rows.find(r => r.hora === i);
      return { hora: i, leads: found ? parseInt(found.leads) : 0 };
    });

    // Vendas por vendedor no período
    const v = await query(
      `SELECT vd.nome,
              COUNT(l.id) FILTER (WHERE l.etapa = 'cliente') AS fechamentos,
              COUNT(l.id) AS leads_atribuidos
       FROM movatak_vendedores vd
       LEFT JOIN movatak_leads l ON l.vendedor_id = vd.id ${periodoSQL.replace('criado_em', 'l.criado_em')}
       WHERE vd.cliente_id = $1 AND vd.ativo = true
       GROUP BY vd.id, vd.nome
       ORDER BY fechamentos DESC`,
      [id]
    );

    res.json({
      periodo_dias: dias,
      ...m.rows[0],
      leads_por_hora: leadsPorHora,
      vendedores: v.rows
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ============================================================
// API — Operação e fila de follow-up
// ============================================================
app.get('/movatak/admin/clientes/:id/operacao', authMovatak, async (req, res) => {
  try {
    const clienteId = req.params.id;

    const cliente = await query(
      `SELECT id, nome, ativo, zapi_instance, trigger_msg, criado_em, ultimo_webhook_em, ultimo_erro_zapi_em, ultimo_erro_zapi
         FROM movatak_clientes
        WHERE id = $1`,
      [clienteId]
    );
    if (!cliente.rows.length) return res.status(404).json({ error: 'Cliente nao encontrado.' });

    const leads = await query(
      `SELECT
         COUNT(*) FILTER (WHERE etapa != 'descartado') AS total_leads,
         COUNT(*) FILTER (WHERE etapa = 'lead') AS em_atendimento,
         COUNT(*) FILTER (WHERE etapa = 'followup') AS em_followup,
         COUNT(*) FILTER (WHERE etapa = 'cliente') AS clientes,
         COUNT(*) FILTER (WHERE etapa = 'descartado') AS descartados,
         MAX(criado_em) AS ultimo_lead_em,
         MAX(atualizado_em) AS ultima_atualizacao_em
       FROM movatak_leads
       WHERE cliente_id = $1`,
      [clienteId]
    );

    const fila = await query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pendente') AS pendentes,
         COUNT(*) FILTER (WHERE status = 'pendente' AND COALESCE(sequencia_fu,1) = 1) AS pendentes_fu1,
         COUNT(*) FILTER (WHERE status = 'pendente' AND COALESCE(sequencia_fu,1) = 2) AS pendentes_fu2,
         COUNT(*) FILTER (WHERE status = 'pendente' AND proximo_envio <= NOW()) AS pendentes_atrasadas,
         COUNT(*) FILTER (WHERE status = 'enviado') AS enviadas,
         COUNT(*) FILTER (WHERE status = 'pausado') AS pausadas,
         MAX(COALESCE(enviado_em, proximo_envio)) FILTER (WHERE status = 'enviado') AS ultimo_envio_em,
         MIN(proximo_envio) FILTER (WHERE status = 'pendente') AS proximo_envio_em
       FROM movatak_followup
       WHERE cliente_id = $1`,
      [clienteId]
    );

    const ultimoLead = await query(
      `SELECT id, nome, telefone, etapa, criado_em, atualizado_em
       FROM movatak_leads
       WHERE cliente_id = $1
       ORDER BY criado_em DESC
       LIMIT 1`,
      [clienteId]
    );

    const proximo = await query(
      `SELECT f.id, f.lead_id, f.sequencia_fu, f.etapa_seq, f.proximo_envio, f.status,
              l.nome, l.telefone, l.etapa
       FROM movatak_followup f
       JOIN movatak_leads l ON l.id = f.lead_id
       WHERE f.cliente_id = $1 AND f.status = 'pendente'
       ORDER BY f.proximo_envio ASC
       LIMIT 1`,
      [clienteId]
    );

    res.json({
      cliente: cliente.rows[0],
      leads: leads.rows[0],
      fila: fila.rows[0],
      ultimo_lead: ultimoLead.rows[0] || null,
      proxima_mensagem: proximo.rows[0] || null,
      debug_ativo: MOVATAK_DEBUG,
      relatorio_diario_ativo: String(process.env.MOVATAK_RELATORIO_DIARIO || '').toLowerCase() === 'true',
      version: MOVATAK_VERSION
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/movatak/admin/clientes/:id/fila-followup', authMovatak, async (req, res) => {
  try {
    const status = String(req.query.status || '').trim();
    const limit = Math.min(Math.max(parseInt(req.query.limit || '80'), 1), 200);
    const params = [req.params.id, limit];
    let filtroStatus = '';
    if (status) {
      params.push(status);
      filtroStatus = ' AND f.status = $3';
    }

    const r = await query(
      `SELECT f.id, f.lead_id, f.etapa_seq, COALESCE(f.sequencia_fu, 1) AS sequencia_fu,
              f.proximo_envio, f.status, f.data_entrada,
              l.nome, l.telefone, l.etapa, l.criado_em, l.atualizado_em,
              v.nome AS vendedor_nome
       FROM movatak_followup f
       JOIN movatak_leads l ON l.id = f.lead_id
       LEFT JOIN movatak_vendedores v ON v.id = l.vendedor_id
       WHERE f.cliente_id = $1 ${filtroStatus}
       ORDER BY
         CASE WHEN f.status = 'pendente' THEN 0 ELSE 1 END,
         f.proximo_envio ASC
       LIMIT $2`,
      params
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/movatak/admin/leads/:id/followup/pausar', authMovatak, async (req, res) => {
  try {
    const leadId = req.params.id;
    const lead = await query('SELECT id, cliente_id FROM movatak_leads WHERE id = $1', [leadId]);
    await query(`UPDATE movatak_leads SET etapa = 'lead', atualizado_em = NOW() WHERE id = $1`, [leadId]);
    await query(`UPDATE movatak_followup SET status = 'pausado' WHERE lead_id = $1 AND status = 'pendente'`, [leadId]);
    if (lead.rows.length) await registrarEventoLead(leadId, lead.rows[0].cliente_id, 'followup_pausado_manual', 'Follow-up pausado manualmente pelo painel');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/movatak/admin/leads/:id/followup/reativar', authMovatak, async (req, res) => {
  try {
    const leadId = req.params.id;
    const sequencia = parseInt(req.body && req.body.sequencia_fu ? req.body.sequencia_fu : 2);
    const enviarImediato = !!(req.body && req.body.enviar_imediato);
    if (![1, 2].includes(sequencia)) return res.status(400).json({ error: 'sequencia_fu deve ser 1 ou 2.' });

    const lead = await query('SELECT id, cliente_id FROM movatak_leads WHERE id = $1', [leadId]);
    if (!lead.rows.length) return res.status(404).json({ error: 'Lead nao encontrado.' });

    await query(`UPDATE movatak_leads SET etapa = 'followup', atualizado_em = NOW() WHERE id = $1`, [leadId]);
    await agendarFollowupV2(leadId, lead.rows[0].cliente_id, sequencia, true);
    await registrarEventoLead(leadId, lead.rows[0].cliente_id, 'followup_reativado_manual', `Follow-up FU${sequencia} reativado pelo painel`, { enviar_imediato: enviarImediato });
    if (enviarImediato) await enviarFollowupsPendentesDoLead(leadId, sequencia);
    res.json({ ok: true, sequencia_fu: sequencia });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/movatak/admin/clientes/:id/testar-gatilho', authMovatak, async (req, res) => {
  try {
    const texto = req.body && req.body.texto ? String(req.body.texto) : '';
    const r = await query('SELECT trigger_msg FROM movatak_clientes WHERE id = $1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Cliente nao encontrado.' });
    const campanha = await localizarCampanhaPorGatilho(req.params.id, texto);
    const bateuGeral = textoBateGatilho(texto, r.rows[0].trigger_msg);
    res.json({
      texto_original: texto,
      trigger_original: campanha ? campanha.gatilho : r.rows[0].trigger_msg,
      texto_normalizado: normalizarGatilho(texto),
      trigger_normalizado: normalizarGatilho(campanha ? campanha.gatilho : r.rows[0].trigger_msg),
      bateu: !!campanha || bateuGeral,
      campanha: campanha ? { id: campanha.id, nome: campanha.nome, template_id: campanha.template_id || null, template_nome: campanha.template_nome || null } : null,
      origem: campanha ? 'campanha' : (bateuGeral ? 'gatilho_geral' : null)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// Histórico completo de um lead
app.get('/movatak/admin/leads/:id/historico', authMovatak, async (req, res) => {
  try {
    const leadId = req.params.id;
    const lead = await query(
      `SELECT l.*, c.nome AS cliente_nome, v.nome AS vendedor_nome
         FROM movatak_leads l
         JOIN movatak_clientes c ON c.id = l.cliente_id
         LEFT JOIN movatak_vendedores v ON v.id = l.vendedor_id
        WHERE l.id = $1`,
      [leadId]
    );
    if (!lead.rows.length) return res.status(404).json({ error: 'Lead nao encontrado.' });

    const eventos = await query(
      `SELECT id, tipo, descricao, dados, criado_em
         FROM movatak_lead_eventos
        WHERE lead_id = $1
        ORDER BY criado_em DESC
        LIMIT 100`,
      [leadId]
    );

    const fila = await query(
      `SELECT id, etapa_seq, COALESCE(sequencia_fu, 1) AS sequencia_fu, proximo_envio,
              status, data_entrada, enviado_em, tentativas_envio, erro_envio
         FROM movatak_followup
        WHERE lead_id = $1
        ORDER BY proximo_envio DESC
        LIMIT 100`,
      [leadId]
    );

    res.json({ lead: lead.rows[0], eventos: eventos.rows, fila: fila.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lista operacional de leads do cliente
app.get('/movatak/admin/clientes/:id/leads-operacao', authMovatak, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit || '80'), 1), 200);
    const etapa = String(req.query.etapa || '').trim();
    const busca = String(req.query.busca || '').trim();
    const params = [req.params.id, limit];
    let where = 'WHERE l.cliente_id = $1';
    if (etapa) { params.push(etapa); where += ` AND l.etapa = $${params.length}`; }
    if (busca) { params.push('%' + busca + '%'); where += ` AND (l.telefone ILIKE $${params.length} OR l.nome ILIKE $${params.length})`; }

    const r = await query(
      `SELECT l.id, l.nome, l.telefone, l.etapa, l.criado_em, l.atualizado_em,
              v.nome AS vendedor_nome,
              COUNT(f.id) FILTER (WHERE f.status = 'pendente') AS pendentes
         FROM movatak_leads l
         LEFT JOIN movatak_vendedores v ON v.id = l.vendedor_id
         LEFT JOIN movatak_followup f ON f.lead_id = l.id
        ${where}
        GROUP BY l.id, v.nome
        ORDER BY l.atualizado_em DESC NULLS LAST, l.criado_em DESC
        LIMIT $2`,
      params
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Exportação CSV simples para reunião/prestação de contas
app.get('/movatak/admin/clientes/:id/leads.csv', authMovatak, async (req, res) => {
  try {
    const r = await query(
      `SELECT l.id, l.nome, l.telefone, l.etapa, v.nome AS vendedor_nome, l.criado_em, l.atualizado_em
         FROM movatak_leads l
         LEFT JOIN movatak_vendedores v ON v.id = l.vendedor_id
        WHERE l.cliente_id = $1
        ORDER BY l.criado_em DESC`,
      [req.params.id]
    );
    const header = ['id','nome','telefone','etapa','vendedor','criado_em','atualizado_em'];
    const linhas = [header.map(csvEscape).join(',')].concat(r.rows.map(row => [
      row.id, row.nome, row.telefone, row.etapa, row.vendedor_nome, row.criado_em, row.atualizado_em
    ].map(csvEscape).join(',')));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="leads-movatak.csv"');
    res.send('\ufeff' + linhas.join('\n'));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Envio manual do relatório diário para teste/implantação
app.post('/movatak/admin/clientes/:id/relatorio-diario/enviar', authMovatak, async (req, res) => {
  try {
    const rel = await montarRelatorioDiarioCliente(req.params.id);
    if (!rel) return res.status(404).json({ error: 'Cliente nao encontrado.' });
    if (!rel.cliente.whatsapp_dono) return res.status(400).json({ error: 'WhatsApp do dono nao configurado.' });
    await zapiEnviar(rel.cliente.zapi_instance, rel.cliente.zapi_token, rel.cliente.zapi_client_token, rel.cliente.whatsapp_dono, rel.mensagem);
    res.json({ ok: true, mensagem: rel.mensagem });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ============================================================
// API — Campanhas, templates, ações do lead e teste Z-API
// ============================================================
function erroEstruturaBanco(e) {
  const msg = String((e && e.message) || '').toLowerCase();
  return msg.includes('does not exist') || msg.includes('não existe') || msg.includes('nao existe') || msg.includes('column') || msg.includes('relation');
}

async function garantirEstruturaCampanhasTemplates() {
  // Proteção contra migrações parciais no Railway. Mantém o painel funcionando
  // mesmo quando alguma versão anterior não criou todas as colunas.
  await query(`CREATE TABLE IF NOT EXISTS movatak_followup_templates (
    id SERIAL PRIMARY KEY,
    cliente_id INTEGER,
    nome TEXT NOT NULL,
    trigger_msg TEXT,
    followup_v2 JSONB DEFAULT '{}'::jsonb,
    boas_vindas_msg TEXT,
    comandos JSONB DEFAULT '{}'::jsonb,
    ativo BOOLEAN DEFAULT true,
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS movatak_campanhas (
    id SERIAL PRIMARY KEY,
    cliente_id INTEGER NOT NULL,
    nome TEXT NOT NULL,
    gatilho TEXT,
    verba_diaria NUMERIC,
    investimento_tipo TEXT DEFAULT 'diario',
    investimento_valor NUMERIC,
    template_id INTEGER,
    ativo BOOLEAN DEFAULT true,
    excluida_em TIMESTAMPTZ,
    criado_em TIMESTAMPTZ DEFAULT NOW(),
    atualizado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  await query(`ALTER TABLE movatak_followup_templates
    ADD COLUMN IF NOT EXISTS cliente_id INTEGER,
    ADD COLUMN IF NOT EXISTS nome TEXT,
    ADD COLUMN IF NOT EXISTS trigger_msg TEXT,
    ADD COLUMN IF NOT EXISTS followup_v2 JSONB DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS boas_vindas_msg TEXT,
    ADD COLUMN IF NOT EXISTS comandos JSONB DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS ativo BOOLEAN DEFAULT true,
    ADD COLUMN IF NOT EXISTS excluida_em TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS criado_em TIMESTAMPTZ DEFAULT NOW()`);

  await query(`ALTER TABLE movatak_campanhas
    ADD COLUMN IF NOT EXISTS cliente_id INTEGER,
    ADD COLUMN IF NOT EXISTS nome TEXT,
    ADD COLUMN IF NOT EXISTS gatilho TEXT,
    ADD COLUMN IF NOT EXISTS verba_diaria NUMERIC,
    ADD COLUMN IF NOT EXISTS investimento_tipo TEXT DEFAULT 'diario',
    ADD COLUMN IF NOT EXISTS investimento_valor NUMERIC,
    ADD COLUMN IF NOT EXISTS template_id INTEGER,
    ADD COLUMN IF NOT EXISTS ativo BOOLEAN DEFAULT true,
    ADD COLUMN IF NOT EXISTS excluida_em TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS criado_em TIMESTAMPTZ DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMPTZ DEFAULT NOW()`);

  await query(`ALTER TABLE movatak_campanhas ALTER COLUMN gatilho DROP NOT NULL`).catch(() => null);
  await query(`UPDATE movatak_campanhas
                 SET investimento_valor = COALESCE(investimento_valor, verba_diaria),
                     investimento_tipo = COALESCE(investimento_tipo, 'diario'),
                     atualizado_em = COALESCE(atualizado_em, NOW())
               WHERE investimento_valor IS NULL OR investimento_tipo IS NULL OR atualizado_em IS NULL`).catch(() => null);

  await query(`ALTER TABLE movatak_leads
    ADD COLUMN IF NOT EXISTS campanha_id INTEGER,
    ADD COLUMN IF NOT EXISTS campanha_id_ultimo_toque INTEGER,
    ADD COLUMN IF NOT EXISTS template_id_origem INTEGER,
    ADD COLUMN IF NOT EXISTS gatilho_detectado TEXT`).catch(() => null);

  await query(`CREATE INDEX IF NOT EXISTS idx_movatak_campanhas_cliente_ativo ON movatak_campanhas(cliente_id, ativo)`).catch(() => null);
  await query(`CREATE INDEX IF NOT EXISTS idx_movatak_campanhas_template ON movatak_campanhas(template_id)`).catch(() => null);
  await query(`CREATE INDEX IF NOT EXISTS idx_movatak_leads_campanha ON movatak_leads(campanha_id)`).catch(() => null);
}


async function resolverTemplateCampanha(clienteId, templateRef) {
  await garantirEstruturaCampanhasTemplates();
  const ref = String(templateRef || '').trim();
  if (!ref) return null;
  if (ref.startsWith('custom:')) {
    const n = parseInt(ref.replace('custom:', '').replace(/\D/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  }
  if (/^\d+$/.test(ref)) return parseInt(ref, 10);
  const t = TEMPLATES_FOLLOWUP[ref];
  if (!t) return null;
  const r = await query(
    `INSERT INTO movatak_followup_templates
       (cliente_id, nome, trigger_msg, followup_v2, boas_vindas_msg, comandos, ativo)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, true)
     RETURNING id`,
    [clienteId, t.nome, t.trigger_msg || null, JSON.stringify(t.followup_v2 || {}), t.boas_vindas_msg || null, JSON.stringify(t.comandos || {})]
  );
  return r.rows[0].id;
}

app.get('/movatak/admin/clientes/:id/campanhas', authMovatak, async (req, res) => {
  try {
    await garantirEstruturaCampanhasTemplates();
    const r = await query(
      `WITH camp AS (
           SELECT c.*,
                  COUNT(*) OVER (PARTITION BY c.cliente_id, LOWER(TRIM(COALESCE(c.gatilho,'')))) AS qtd_mesmo_gatilho
             FROM movatak_campanhas c
            WHERE c.cliente_id = $1
              AND c.excluida_em IS NULL
        )
        SELECT c.id, c.cliente_id, c.nome, c.gatilho, c.verba_diaria, c.investimento_tipo, c.investimento_valor, c.template_id, c.ativo, c.criado_em, c.atualizado_em,
              t.nome AS template_nome,
              c.qtd_mesmo_gatilho::int AS campanhas_mesmo_gatilho,
              (c.qtd_mesmo_gatilho > 1) AS gatilho_compartilhado,
              COUNT(l.id)::int AS leads,
              COUNT(l.id) FILTER (WHERE l.etapa = 'cliente')::int AS vendas,
              COALESCE(ROUND((100.0 * COUNT(l.id) FILTER (WHERE l.etapa = 'cliente') / NULLIF(COUNT(l.id),0))::numeric, 1), 0) AS conversao,
              COALESCE(c.investimento_valor, c.verba_diaria, 0) AS investimento,
              CASE WHEN COUNT(l.id) > 0 THEN ROUND((COALESCE(c.investimento_valor, c.verba_diaria, 0) / NULLIF(COUNT(l.id),0))::numeric, 2) ELSE NULL END AS cpl,
              CASE WHEN COUNT(l.id) FILTER (WHERE l.etapa = 'cliente') > 0 THEN ROUND((COALESCE(c.investimento_valor, c.verba_diaria, 0) / NULLIF(COUNT(l.id) FILTER (WHERE l.etapa = 'cliente'),0))::numeric, 2) ELSE NULL END AS custo_venda
         FROM camp c
         LEFT JOIN movatak_followup_templates t ON t.id = c.template_id
         LEFT JOIN movatak_leads l
           ON (CASE WHEN c.qtd_mesmo_gatilho > 1
                    THEN LOWER(TRIM(COALESCE(l.gatilho_detectado,''))) = LOWER(TRIM(COALESCE(c.gatilho,'')))
                    ELSE l.campanha_id = c.id
               END)
        GROUP BY c.id, c.cliente_id, c.nome, c.gatilho, c.verba_diaria, c.investimento_tipo, c.investimento_valor, c.template_id, c.ativo, c.criado_em, c.atualizado_em, c.qtd_mesmo_gatilho, t.nome
        ORDER BY c.ativo DESC, c.criado_em DESC`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (e) {
    console.error('[campanhas][listar]', e.message);
    // Não quebra o painel se a migração de campanhas ainda não foi executada.
    if (erroEstruturaBanco(e)) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

app.post('/movatak/admin/clientes/:id/campanhas', authMovatak, async (req, res) => {
  try {
    await garantirEstruturaCampanhasTemplates();
    const { nome, gatilho, verba_diaria, investimento_tipo, investimento_valor, template_id } = req.body || {};
    if (!nome) return res.status(400).json({ error: 'Nome da campanha é obrigatório.' });
    const gatilhoFinal = gatilho ? String(gatilho).trim() : null;
    if (!gatilhoFinal) return res.status(400).json({ error: 'Frase-gatilho da campanha é obrigatória para atribuição confiável.' });
    const investimentoTipo = ['diario','total'].includes(String(investimento_tipo || '').toLowerCase()) ? String(investimento_tipo).toLowerCase() : 'diario';
    const investimentoValor = parseMoedaParaNumero(investimento_valor !== undefined ? investimento_valor : verba_diaria);
    // A partir da v2.1.3 permitimos o mesmo gatilho em mais de uma campanha.
    // Observação: quando isso acontece, a atribuição exata por campanha fica compartilhada pelo gatilho.
    const templateDbId = await resolverTemplateCampanha(req.params.id, template_id);
    const r = await query(
      `INSERT INTO movatak_campanhas (cliente_id, nome, gatilho, verba_diaria, investimento_tipo, investimento_valor, template_id, ativo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true) RETURNING *`,
      [req.params.id, String(nome).trim(), gatilhoFinal, investimentoValor, investimentoTipo, investimentoValor, templateDbId]
    );
    res.json(r.rows[0]);
  } catch (e) {
    console.error('[campanhas][criar]', e.message);
    if (erroEstruturaBanco(e)) return res.status(400).json({ error: 'Tabela de campanhas não existe ou está desatualizada. Rode a MIGRACOES-v2.1.1.sql no PostgreSQL do Railway.' });
    res.status(500).json({ error: e.message });
  }
});

app.patch('/movatak/admin/campanhas/:id', authMovatak, async (req, res) => {
  try {
    await garantirEstruturaCampanhasTemplates();
    const { nome, gatilho, verba_diaria, investimento_tipo, investimento_valor, template_id, ativo } = req.body || {};
    const investimentoValor = investimento_valor !== undefined ? parseMoedaParaNumero(investimento_valor) : (verba_diaria !== undefined ? parseMoedaParaNumero(verba_diaria) : null);
    const investimentoTipo = investimento_tipo === undefined ? null : (['diario','total'].includes(String(investimento_tipo).toLowerCase()) ? String(investimento_tipo).toLowerCase() : 'diario');
    const templateDbId = template_id === undefined ? undefined : await resolverTemplateCampanha(null, template_id);
    const r = await query(
      `UPDATE movatak_campanhas
          SET nome = COALESCE($1, nome),
              gatilho = CASE WHEN $2::text IS NULL THEN gatilho ELSE $2 END,
              verba_diaria = CASE WHEN $3::text IS NULL THEN verba_diaria ELSE $3::numeric END,
              investimento_valor = CASE WHEN $3::text IS NULL THEN investimento_valor ELSE $3::numeric END,
              investimento_tipo = COALESCE($4, investimento_tipo),
              template_id = CASE WHEN $5::text IS NULL THEN template_id ELSE $5::int END,
              ativo = COALESCE($6, ativo),
              atualizado_em = NOW()
        WHERE id = $7 RETURNING *`,
      [nome ? String(nome).trim() : null, gatilho === undefined ? null : String(gatilho || '').trim(), investimentoValor, investimentoTipo, template_id === undefined ? null : templateDbId, typeof ativo === 'boolean' ? ativo : null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Campanha não encontrada.' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});


app.delete('/movatak/admin/campanhas/:id', authMovatak, async (req, res) => {
  try {
    await garantirEstruturaCampanhasTemplates();
    const r = await query(
      `UPDATE movatak_campanhas
          SET ativo = false,
              excluida_em = NOW(),
              atualizado_em = NOW()
        WHERE id = $1 AND excluida_em IS NULL
        RETURNING id, nome`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Campanha não encontrada ou já excluída.' });
    res.json({ ok: true, campanha: r.rows[0] });
  } catch (e) {
    console.error('[campanhas][excluir]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/movatak/admin/templates-followup/:id', authMovatak, async (req, res) => {
  try {
    await garantirEstruturaCampanhasTemplates();
    const templateId = String(req.params.id || '').replace(/\D/g, '');
    if (!templateId) return res.status(400).json({ error: 'Template inválido.' });

    const usado = await query(
      `SELECT COUNT(*)::int AS total
         FROM movatak_campanhas
        WHERE template_id = $1
          AND ativo = true
          AND excluida_em IS NULL`,
      [templateId]
    );
    if (parseInt((usado.rows[0] || {}).total || 0, 10) > 0) {
      return res.status(400).json({ error: 'Este template está vinculado a campanha ativa. Exclua a campanha ou troque o template antes.' });
    }

    const r = await query(
      `UPDATE movatak_followup_templates
          SET ativo = false
        WHERE id = $1 AND ativo = true
        RETURNING id, nome`,
      [templateId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Template personalizado não encontrado.' });
    res.json({ ok: true, template: r.rows[0] });
  } catch (e) {
    console.error('[templates][excluir]', e.message);
    res.status(500).json({ error: e.message });
  }
});

async function listarTemplatesCustom(clienteId) {
  await garantirEstruturaCampanhasTemplates();
  const r = await query(
    `SELECT id, nome, trigger_msg, followup_v2, boas_vindas_msg, comandos, criado_em
       FROM movatak_followup_templates
      WHERE cliente_id = $1 AND ativo = true
      ORDER BY criado_em DESC`,
    [clienteId]
  );
  return r.rows;
}

app.get('/movatak/admin/templates-followup', authMovatak, async (req, res) => {
  try {
    await garantirEstruturaCampanhasTemplates();
    const clienteId = req.query.cliente_id || req.query.clienteId || null;
    const padroes = Object.entries(TEMPLATES_FOLLOWUP).map(([id, t]) => ({
      id,
      nome: t.nome,
      tipo: 'padrao'
    }));
    if (!clienteId) return res.json(padroes);

    let custom = [];
    try {
      custom = (await listarTemplatesCustom(clienteId)).map(t => ({
        id: 'custom:' + t.id,
        nome: t.nome,
        tipo: 'cliente'
      }));
    } catch (e) {
      if (!erroEstruturaBanco(e)) throw e;
      console.error('[templates][listar-custom]', e.message);
    }

    res.json([...padroes, ...custom]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/clientes/:id/templates-followup', authMovatak, async (req, res) => {
  try {
    await garantirEstruturaCampanhasTemplates();
    const body = req.body || {};
    const nome = String(body.nome || '').trim();
    const followup = body.followup_v2 || body.followup || {};
    if (!nome) return res.status(400).json({ error: 'Informe o nome do template.' });
    if (!followup || typeof followup !== 'object') return res.status(400).json({ error: 'Template sem mensagens de follow-up.' });

    const r = await query(
      `INSERT INTO movatak_followup_templates
         (cliente_id, nome, trigger_msg, followup_v2, boas_vindas_msg, comandos, ativo)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, true)
       RETURNING id, nome`,
      [
        req.params.id,
        nome,
        body.trigger_msg ? String(body.trigger_msg).trim() : null,
        JSON.stringify(followup),
        body.boas_vindas_msg || null,
        JSON.stringify(body.comandos || {})
      ]
    );
    res.json({ ok: true, id: 'custom:' + r.rows[0].id, nome: r.rows[0].nome });
  } catch (e) {
    console.error('[templates][criar]', e.message);
    if (erroEstruturaBanco(e)) return res.status(400).json({ error: 'Tabela de templates não existe no banco. Rode a MIGRACOES-v2.1.1.sql no PostgreSQL do Railway.' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/movatak/admin/clientes/:id/aplicar-template', authMovatak, async (req, res) => {
  try {
    await garantirEstruturaCampanhasTemplates();
    const templateId = String((req.body || {}).template || '').trim();
    let t = null;

    if (templateId.startsWith('custom:')) {
      const templateDbId = templateId.replace('custom:', '').replace(/\D/g, '');
      const r = await query(
        `SELECT * FROM movatak_followup_templates
          WHERE id = $1 AND cliente_id = $2 AND ativo = true`,
        [templateDbId, req.params.id]
      );
      if (!r.rows.length) return res.status(400).json({ error: 'Template personalizado não encontrado.' });
      const row = r.rows[0];
      t = {
        nome: row.nome,
        trigger_msg: row.trigger_msg,
        followup_v2: row.followup_v2 || {},
        boas_vindas_msg: row.boas_vindas_msg || '',
        comandos: row.comandos || null
      };
    } else {
      t = TEMPLATES_FOLLOWUP[templateId];
    }

    if (!t) return res.status(400).json({ error: 'Template inválido.' });

    const comandosJson = t.comandos ? JSON.stringify(t.comandos) : null;
    await query(
      `UPDATE movatak_clientes
          SET followup_msgs_v2 = $1::jsonb,
              boas_vindas_msg = $2,
              trigger_msg = COALESCE(NULLIF($3,''), trigger_msg),
              comandos = COALESCE($4::jsonb, comandos)
        WHERE id = $5`,
      [JSON.stringify(t.followup_v2), t.boas_vindas_msg, t.trigger_msg || '', comandosJson, req.params.id]
    );
    res.json({ ok: true, template: templateId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/clientes/:id/testar-zapi', authMovatak, async (req, res) => {
  try {
    const r = await query('SELECT * FROM movatak_clientes WHERE id = $1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const c = r.rows[0];
    const destino = String((req.body || {}).telefone || c.whatsapp_dono || MOVATAK_ADMIN_WA).replace(/\D/g, '');
    if (!destino) return res.status(400).json({ error: 'Informe um telefone para teste.' });
    const msg = `Teste Z-API Movatak CRM ${MOVATAK_VERSION} — ${new Date().toLocaleString('pt-BR')}`;
    await zapiEnviar(c.zapi_instance, c.zapi_token, c.zapi_client_token, destino, msg);
    res.json({ ok: true, telefone: destino });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/movatak/admin/leads/:id/cliente', authMovatak, async (req, res) => {
  try {
    const lead = await query('SELECT id, cliente_id FROM movatak_leads WHERE id = $1', [req.params.id]);
    if (!lead.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    await query(`UPDATE movatak_leads SET etapa = 'cliente', atualizado_em = NOW() WHERE id = $1`, [req.params.id]);
    await query(`UPDATE movatak_followup SET status = 'pausado' WHERE lead_id = $1 AND status = 'pendente'`, [req.params.id]);
    await registrarEventoLead(req.params.id, lead.rows[0].cliente_id, 'cliente_manual', 'Lead marcado como cliente pelo painel');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/admin/leads/:id/descartar', authMovatak, async (req, res) => {
  try {
    const lead = await query('SELECT id, cliente_id FROM movatak_leads WHERE id = $1', [req.params.id]);
    if (!lead.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    await query(`UPDATE movatak_leads SET etapa = 'descartado', atualizado_em = NOW() WHERE id = $1`, [req.params.id]);
    await query(`UPDATE movatak_followup SET status = 'pausado' WHERE lead_id = $1 AND status = 'pendente'`, [req.params.id]);
    await registrarEventoLead(req.params.id, lead.rows[0].cliente_id, 'descartado_manual', 'Lead descartado pelo painel');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/admin/leads/:id/vendedor', authMovatak, async (req, res) => {
  try {
    const vendedorId = req.body && req.body.vendedor_id ? parseInt(req.body.vendedor_id) : null;
    const lead = await query('SELECT id, cliente_id FROM movatak_leads WHERE id = $1', [req.params.id]);
    if (!lead.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    await query(`UPDATE movatak_leads SET vendedor_id = $1, atualizado_em = NOW() WHERE id = $2`, [vendedorId, req.params.id]);
    await registrarEventoLead(req.params.id, lead.rows[0].cliente_id, 'vendedor_atribuido_manual', 'Vendedor atribuído manualmente pelo painel', { vendedor_id: vendedorId });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// Health check + Versão
// ============================================================
app.get('/movatak/health', (req, res) => {
  res.json({ status: 'ok', version: MOVATAK_VERSION, ts: new Date().toISOString() });
});

app.get('/movatak/version', (req, res) => {
  res.json({ version: MOVATAK_VERSION });
});

// ============================================================
// Start
// ============================================================
const PORT = process.env.MOVATAK_PORT || process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[Movatak] Backend ${MOVATAK_VERSION} rodando na porta ${PORT}`);
});
