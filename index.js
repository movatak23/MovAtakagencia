'use strict';

// ============================================================
// VERSÃO — incrementar a cada atualização
// ============================================================
const MOVATAK_VERSION = 'v2.5.4-kanban-historico-zap-fix';

const express = require('express');
const { Pool } = require('pg');
const cron = require('node-cron');
const axios = require('axios');
const crypto = require('crypto');

const path = require('path');
const app = express();
app.use(express.json({ limit: '30mb' }));
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
const MOVATAK_QUEST_LEMBRETE_HORAS = parseInt(process.env.MOVATAK_QUEST_LEMBRETE_HORAS || '6', 10);
const MOVATAK_QUEST_MAX_LEMBRETES = parseInt(process.env.MOVATAK_QUEST_MAX_LEMBRETES || '1', 10);

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

async function zapiEnviarImagem(instance, token, clientToken, telefone, imageUrl, caption) {
  const url = `${ZAPI_BASE}/${instance}/token/${token}/send-image`;
  await axios.post(url, { phone: telefone, image: imageUrl, caption: caption || '' }, {
    headers: { 'Client-Token': clientToken }
  });
}

async function zapiEnviarVideo(instance, token, clientToken, telefone, videoUrl, caption) {
  const url = `${ZAPI_BASE}/${instance}/token/${token}/send-video`;
  await axios.post(url, { phone: telefone, video: videoUrl, caption: caption || '' }, {
    headers: { 'Client-Token': clientToken }
  });
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

// Verdadeiro se o lead já estava em conversa ativa: tem 2+ mensagens de entrada
// na janela de horas (a mensagem atual já foi gravada antes desta checagem, então
// exigimos pelo menos mais uma anterior). Evita reativar o FU1 no meio da conversa.
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
  const raw = String(v).trim().replace(/[R$\s]/g, '');
  if (!raw) return null;

  // Aceita 99,90 / 99.90 / 1.299,90 / 1,299.90.
  const lastComma = raw.lastIndexOf(',');
  const lastDot = raw.lastIndexOf('.');
  let normalized = raw;

  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) {
      normalized = raw.replace(/\./g, '').replace(',', '.');
    } else {
      normalized = raw.replace(/,/g, '');
    }
  } else if (lastComma >= 0) {
    normalized = raw.replace(/\./g, '').replace(',', '.');
  } else if (lastDot >= 0) {
    const parts = raw.split('.');
    // Quando há mais de um ponto, trata os anteriores como milhar.
    normalized = parts.length > 2 ? parts.slice(0, -1).join('') + '.' + parts.at(-1) : raw;
  }

  const n = parseFloat(normalized);
  return Number.isFinite(n) ? n : null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizarDelayQuestionario(passo) {
  const n = parseInt(passo && (passo.delay_segundos ?? passo.delaySegundos ?? passo.delay), 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, 300); // limite operacional: 5 minutos por mensagem
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
      const templateFonte = row.template_followup_v2 ? `template:${row.template_nome_debug}` : 'cliente:followup_msgs_v2';
      console.log(`[imediato][fu] lead=${leadId} campanha=${row.campanha_nome||'—'} fonte=${templateFonte} seq=${seqKey} etapa=${row.etapa_seq}`);

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
      registrarConversa(leadId, row.cliente_id, 'saida', msg || '', null).catch(() => null);
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

    // Verificar se lead já existe para evitar duplicata (tolerante ao 9º dígito)
    const _varDup = variantesTelefone(telefone);
    const existe = await query(
      `SELECT id FROM movatak_leads WHERE cliente_id = $1 AND telefone IN (${_varDup.map((_, i) => '$' + (i + 2)).join(',')})`,
      [cliente.id, ..._varDup]
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

    // Buscar lead (tolerante ao 9º dígito)
    const _varRl = variantesTelefone(telefone);
    const rl = await query(
      `SELECT * FROM movatak_leads WHERE cliente_id = $1 AND telefone IN (${_varRl.map((_, i) => '$' + (i + 2)).join(',')}) ORDER BY atualizado_em DESC NULLS LAST, criado_em DESC LIMIT 1`,
      [cliente.id, ..._varRl]
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
      'SELECT * FROM movatak_vendedores WHERE cliente_id = $1 AND COALESCE(ativo, true) = true',
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
          `UPDATE movatak_leads SET etapa = 'cliente', convertido_em = NOW(), atualizado_em = NOW() WHERE id = $1`,
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
            t.followup_v2 AS template_followup_v2, t.nome AS template_nome_debug
     FROM movatak_followup f
     JOIN movatak_leads l ON l.id = f.lead_id
     JOIN movatak_clientes c ON c.id = f.cliente_id
     LEFT JOIN movatak_campanhas camp ON camp.id = l.campanha_id
     LEFT JOIN movatak_followup_templates t
            ON t.id = COALESCE(camp.template_id, l.template_id_origem) AND t.ativo = true
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
        const templateFonte = row.template_followup_v2 ? `template:${row.template_nome_debug}` : 'cliente:followup_msgs_v2';
        console.log(`[cron][fu] lead=${row.lead_id} campanha=${row.campanha_nome||'—'} fonte=${templateFonte} seq=${seq_key} etapa=${row.etapa_seq}`);
        
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
        registrarConversa(row.lead_id, row.cliente_id, 'saida', msg || '', null).catch(() => null);
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
      WHERE v.cliente_id = $1 AND COALESCE(v.ativo, true) = true
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

// Reativador de questionário: lembrete por inatividade e devolução ao follow-up.
cron.schedule('*/15 * * * *', async () => {
  await processarQuestionariosParados();
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

    const _varResp = variantesTelefone(telefone);
    const rl = await query(
      `SELECT id FROM movatak_leads WHERE cliente_id = $1 AND telefone IN (${_varResp.map((_, i) => '$' + (i + 2)).join(',')}) AND etapa = 'followup'`,
      [clienteId, ..._varResp]
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
         COUNT(*) FILTER (WHERE etapa = 'cliente' AND DATE(COALESCE(convertido_em, atualizado_em)) = CURRENT_DATE) AS vendas_hoje,
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
              COUNT(l.id) FILTER (WHERE l.etapa = 'cliente' AND DATE(COALESCE(l.convertido_em, l.atualizado_em)) = CURRENT_DATE) AS vendas_hoje
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
      `SELECT id, nome, whatsapp, zapi_instance, trigger_msg, teto_cpl, permissoes_portal, acao_arquivar_ao_final, acao_marcar_nao_lido
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
    const { nome, whatsapp, zapi_instance, zapi_token, zapi_client_token, trigger_msg, teto_cpl, permissoes_portal, acao_arquivar_ao_final, acao_marcar_nao_lido } = req.body;

    if (!nome || !whatsapp || !zapi_instance) {
      return res.status(400).json({ error: 'Nome, WhatsApp e Instance ID sao obrigatorios.' });
    }

    const triggerPadrao = (trigger_msg && String(trigger_msg).trim()) ? String(trigger_msg).trim() : 'USAR_GATILHOS_DAS_CAMPANHAS';
    const campos = ['nome = $1', 'whatsapp = $2', 'zapi_instance = $3', 'trigger_msg = $4', 'teto_cpl = $5'];
    const valores = [nome, whatsapp, zapi_instance, triggerPadrao, teto_cpl ? parseFloat(teto_cpl) : null];
    let idx = 6;
    if (permissoes_portal) { campos.push('permissoes_portal = $' + idx + '::jsonb'); valores.push(JSON.stringify(normalizarPermissoes(permissoes_portal))); idx++; }
    if (acao_arquivar_ao_final !== undefined) { campos.push('acao_arquivar_ao_final = $' + idx); valores.push(!!acao_arquivar_ao_final); idx++; }
    if (acao_marcar_nao_lido !== undefined) { campos.push('acao_marcar_nao_lido = $' + idx); valores.push(!!acao_marcar_nao_lido); idx++; }

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
        WHERE cliente_id = $1 AND COALESCE(ativo, true) = true
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
          WHERE cliente_id = $1 AND COALESCE(ativo, true) = true
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
       WHERE v.cliente_id = $1 AND COALESCE(v.ativo, true) = true
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
       WHERE v.cliente_id = $1 AND COALESCE(v.ativo, true) = true
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
    const leadPeriodoSQL = dias === 0
      ? "DATE(criado_em) = CURRENT_DATE"
      : `criado_em >= NOW() - INTERVAL '${dias} days'`;
    const vendaPeriodoSQL = dias === 0
      ? "DATE(COALESCE(convertido_em, atualizado_em)) = CURRENT_DATE"
      : `COALESCE(convertido_em, atualizado_em) >= NOW() - INTERVAL '${dias} days'`;

    // Métricas do período: leads pela data de entrada; vendas pela data de conversão.
    const m = await query(
      `SELECT
         COUNT(*) FILTER (WHERE etapa != 'descartado' AND ${leadPeriodoSQL})  AS total_leads,
         COUNT(*) FILTER (WHERE etapa = 'cliente' AND ${vendaPeriodoSQL})     AS convertidos,
         COUNT(*) FILTER (WHERE etapa = 'followup')                           AS em_followup,
         COUNT(*) FILTER (WHERE DATE(criado_em) = CURRENT_DATE)               AS leads_hoje,
         COUNT(*) FILTER (WHERE etapa = 'cliente' AND DATE(COALESCE(convertido_em, atualizado_em)) = CURRENT_DATE) AS vendas_hoje
       FROM movatak_leads
       WHERE cliente_id = $1`,
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
              COUNT(l.id) FILTER (WHERE l.etapa = 'cliente' AND ${vendaPeriodoSQL.replace(/COALESCE\(convertido_em, atualizado_em\)/g, 'COALESCE(l.convertido_em, l.atualizado_em)')}) AS fechamentos,
              COUNT(l.id) FILTER (WHERE ${leadPeriodoSQL.replace(/criado_em/g, 'l.criado_em')}) AS leads_atribuidos
       FROM movatak_vendedores vd
       LEFT JOIN movatak_leads l ON l.vendedor_id = vd.id AND l.cliente_id = $1
       WHERE vd.cliente_id = $1 AND COALESCE(vd.ativo, true) = true
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
          WHERE cliente_id = $1 AND COALESCE(ativo, true) = true`,
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
      `SELECT id, nome, comando, email_acesso, acesso_token, CASE WHEN senha_hash IS NULL OR senha_hash = '' THEN false ELSE true END AS tem_senha FROM movatak_vendedores WHERE cliente_id = $1 AND COALESCE(ativo, true) = true ORDER BY nome`, [req.clienteId]
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
function normalizarComandoComparacao(t) {
  return normalizarTexto(t)
    .replace(/#\s+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

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

  // Match forte: a mensagem contém o gatilho inteiro (cliente colou a frase do anúncio).
  if (msg.includes(trigger)) return true;

  // Match reverso (gatilho contém a mensagem): só vale quando a mensagem é
  // substancial — pelo menos 12 caracteres e 3 palavras. Isso evita que respostas
  // curtas do questionário ("Esse", "internet", "sim") sejam confundidas com o
  // gatilho só por aparecerem dentro da frase do anúncio.
  const msgPalavras = msg.split(' ').filter(Boolean).length;
  const msgSubstancial = msg.length >= 12 && msgPalavras >= 3;
  if (msgSubstancial && trigger.includes(msg)) return true;

  // Fallback seguro: ignora o prefixo antes de >> e compara o corpo da frase.
  // Ex.: "PROV>> Olá!..." e "PROV >> Olá!..."
  const corpoMsg = msg.includes('>>') ? msg.split('>>').slice(1).join('>>').trim() : msg;
  const corpoTrigger = trigger.includes('>>') ? trigger.split('>>').slice(1).join('>>').trim() : trigger;
  if (!corpoTrigger || !corpoMsg) return false;
  if (corpoMsg.includes(corpoTrigger)) return true;
  const corpoMsgSubstancial = corpoMsg.length >= 12 && corpoMsg.split(' ').filter(Boolean).length >= 3;
  return corpoMsgSubstancial && corpoTrigger.includes(corpoMsg);
}

// Verifica se o texto contém algum dos comandos da lista
function contemComando(texto, comandos) {
  if (!Array.isArray(comandos) || !comandos.length) return false;
  const t = normalizarComandoComparacao(texto);
  return comandos.some(cmd => {
    const c = normalizarComandoComparacao(cmd);
    return c && (t === c || t.includes(c));
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

function textoBateComandoParar(texto, comandoParar) {
  const c = String(comandoParar || '').trim();
  if (!c) return false;
  return contemComando(texto, [c]);
}

// Para TODA a automação de um lead: marca a flag, pausa follow-ups pendentes e
// cancela o questionário em andamento. Usada pelo comando de parar atendimento,
// disparado tanto pelo cliente quanto pelo vendedor/dono.
async function pararAtendimentoLead(clienteId, leadId, origem, comando) {
  await query(
    `UPDATE movatak_leads SET automacao_pausada = true, atualizado_em = NOW() WHERE id = $1`,
    [leadId]
  );
  await query(
    `UPDATE movatak_followup SET status = 'pausado' WHERE lead_id = $1 AND status = 'pendente'`,
    [leadId]
  );
  await query(
    `UPDATE movatak_questionario_estado SET status = 'cancelado', atualizado_em = NOW()
       WHERE lead_id = $1 AND status = 'em_andamento'`,
    [leadId]
  ).catch(() => null);
  await registrarEventoLead(leadId, clienteId, 'atendimento_parado', 'Automação encerrada por comando de atendente', { origem: origem || null, comando: comando || null }).catch(() => null);
  console.log(`[zapi] Atendimento parado (${origem}) -> lead ${leadId}`);
}

function textoBateComandoAtivar(texto, comandoAtivar) {
  const c = String(comandoAtivar || '').trim();
  if (!c) return false;
  return contemComando(texto, [c]);
}

// Procura uma coluna do funil cujo "comando" bate o texto e move o lead pra ela.
// Retorna true se moveu. Usado pelos comandos de coluna (fromMe).
async function moverLeadPorComandoColuna(cliente, lead, texto) {
  try {
    const cols = await query(
      `SELECT id, nome, comando FROM movatak_funil_colunas
        WHERE cliente_id=$1 AND ativo=true AND comando IS NOT NULL AND TRIM(comando) <> ''`,
      [cliente.id]
    );
    const alvo = cols.rows.find(c => contemComando(texto, [c.comando]));
    if (!alvo) return false;
    await moverLeadParaColunaFunil(lead.id, alvo.id, false);
    await registrarEventoLead(lead.id, cliente.id, 'movido_por_comando', `Lead movido para "${alvo.nome}" por comando`, { comando: alvo.comando, coluna_id: alvo.id }).catch(() => null);
    console.log(`[zapi] Lead ${lead.id} movido para coluna "${alvo.nome}" por comando`);
    return true;
  } catch (e) {
    console.error('[comando-coluna]', e.message);
    return false;
  }
}

// Reinicia o autoatendimento de um lead do zero: religa a automação, fecha
// qualquer estado de questionário anterior e dispara o questionário novamente.
async function reiniciarQuestionarioLead(cliente, lead, comando) {
  await query(
    `UPDATE movatak_leads SET automacao_pausada = false, etapa = 'followup', atualizado_em = NOW() WHERE id = $1`,
    [lead.id]
  );
  await query(
    `UPDATE movatak_questionario_estado SET status = 'cancelado', atualizado_em = NOW()
       WHERE lead_id = $1 AND status IN ('em_andamento','abandonado')`,
    [lead.id]
  ).catch(() => null);
  await registrarEventoLead(lead.id, cliente.id, 'questionario_reiniciado', 'Autoatendimento reiniciado por comando do vendedor', { comando: comando || null }).catch(() => null);
  await iniciarQuestionario(cliente, lead);
  console.log(`[zapi] Autoatendimento reiniciado -> lead ${lead.id}`);
}

function textoPareceComandoInterno(texto, comandos, vendedores, comandoParar, comandoAtivar) {
  const t = String(texto || '').trim();
  if (!t) return false;
  // Segurança: a mensagem deve conter pelo menos um # para ser interpretada como comando.
  // Permite que o código apareça em qualquer posição da mensagem (ex: "Fechado! #rebeka").
  if (!t.includes('#')) return false;
  if (contemComando(t, comandos.followup || [])) return true;
  if (contemComando(t, comandos.convertido || [])) return true;
  if (contemComando(t, comandos.descartar || [])) return true;
  if (contemComando(t, comandos.desfazer || [])) return true;
  if (contemComando(t, comandos.pausar || [])) return true;
  if (textoBateComandoParar(t, comandoParar)) return true;
  if (textoBateComandoAtivar(t, comandoAtivar)) return true;
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

// Gera as variantes de um telefone BR considerando o 9º dígito do celular.
// Ex.: "5581976041948" (com 9) e "558176041948" (sem 9) são tratados como o mesmo número.
// Retorna lista de variantes (sempre inclui o original), sem duplicatas.
function variantesTelefone(tel) {
  const d = String(tel || '').replace(/\D/g, '');
  if (!d) return [];
  const set = new Set([d]);
  // Formato BR: 55 (DDI) + DD (2) + número (8 ou 9 dígitos)
  if (d.startsWith('55') && d.length >= 12) {
    const ddi = d.slice(0, 2);
    const ddd = d.slice(2, 4);
    const numero = d.slice(4);
    if (numero.length === 9 && numero[0] === '9') {
      // tem o 9 → adiciona versão sem o 9
      set.add(ddi + ddd + numero.slice(1));
    } else if (numero.length === 8) {
      // sem o 9 → adiciona versão com o 9
      set.add(ddi + ddd + '9' + numero);
    }
  }
  return Array.from(set);
}

// Busca um lead por telefone tolerando a diferença do 9º dígito.
async function buscarLeadPorTelefone(clienteId, telefone, extraWhere = '', extraParams = []) {
  const variantes = variantesTelefone(telefone);
  if (!variantes.length) return { rows: [] };
  const placeholders = variantes.map((_, i) => '$' + (i + 2)).join(',');
  const sql = `SELECT * FROM movatak_leads
                WHERE cliente_id = $1 AND telefone IN (${placeholders}) ${extraWhere}
                ORDER BY atualizado_em DESC NULLS LAST, criado_em DESC LIMIT 1`;
  return query(sql, [clienteId, ...variantes, ...extraParams]).catch(() => ({ rows: [] }));
}

function extrairTextoPayloadZapi(body) {
  return (body.text && body.text.message) ? String(body.text.message)
    : (typeof body.text === 'string') ? String(body.text)
    : (body.image && body.image.caption) ? String(body.image.caption || '')
    : (body.video && body.video.caption) ? String(body.video.caption || '')
    : (body.document && body.document.caption) ? String(body.document.caption || '')
    : (body.caption ? String(body.caption) : '');
}

function extrairMidiaPayloadZapi(body) {
  return (body.image && (body.image.imageUrl || body.image.url)) ||
    (body.video && (body.video.videoUrl || body.video.url)) ||
    (body.audio && (body.audio.audioUrl || body.audio.url)) ||
    (body.document && (body.document.documentUrl || body.document.url)) ||
    body.fileUrl || body.mediaUrl || null;
}

async function localizarLeadPorPayload(clienteId, telefone, chatLid, permitirFallbackRecente = false) {
  let rl = null;

  if (chatLid) {
    rl = await query(
      'SELECT * FROM movatak_leads WHERE cliente_id = $1 AND chat_lid = $2 ORDER BY atualizado_em DESC NULLS LAST, criado_em DESC LIMIT 1',
      [clienteId, chatLid]
    );
  }

  if ((!rl || !rl.rows.length) && telefone) {
    // Busca tolerante ao 9º dígito do celular (com/sem o 9).
    const variantes = variantesTelefone(telefone);
    const placeholders = variantes.map((_, i) => '$' + (i + 2)).join(',');
    rl = await query(
      `SELECT * FROM movatak_leads WHERE cliente_id = $1 AND telefone IN (${placeholders}) ORDER BY atualizado_em DESC NULLS LAST, criado_em DESC LIMIT 1`,
      [clienteId, ...variantes]
    );
  }

  if ((!rl || !rl.rows.length) && permitirFallbackRecente) {
    const fallback = await query(
      `SELECT * FROM movatak_leads
        WHERE cliente_id = $1
          AND etapa IN ('lead','followup','auto_atendimento','negociacao')
          AND criado_em >= NOW() - INTERVAL '48 hours'
        ORDER BY atualizado_em DESC NULLS LAST, criado_em DESC
        LIMIT 2`,
      [clienteId]
    );
    if (fallback.rows.length === 1) rl = { rows: [fallback.rows[0]] };
  }

  if (rl && rl.rows.length && chatLid && rl.rows[0].chat_lid !== chatLid) {
    await query('UPDATE movatak_leads SET chat_lid = $1, atualizado_em = NOW() WHERE id = $2', [chatLid, rl.rows[0].id]).catch(() => null);
    rl.rows[0].chat_lid = chatLid;
  }

  return rl && rl.rows.length ? rl.rows[0] : null;
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

    // Mensagem apagada (revogada) — ignorar para não disparar "Não entendi" no questionário
    if (body.type === 'revoked' || body.isDeleted || body.revoked) {
      logDebug('[zapi][ignorado] mensagem apagada/revogada');
      return;
    }

    // Notificações de status (leitura, entrega, etc.) — não são mensagens reais
    if (body.type && ['ack', 'status', 'delivery', 'read', 'presence'].includes(String(body.type).toLowerCase())) {
      logDebug('[zapi][ignorado] evento de status: ' + body.type);
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

    // ===== MENSAGEM ENVIADA PELO VENDEDOR / PRÓPRIO WHATSAPP (fromMe) =====
    // Antes o CRM descartava toda mensagem fromMe que não fosse comando interno.
    // Isso quebrava o histórico do Kanban, porque respostas manuais do vendedor nunca eram gravadas.
    // Agora a mensagem é registrada primeiro; depois a lógica de comandos continua igual.
    if (body.fromMe) {
      logDebug('[zapi][fromMe] recebido', JSON.stringify({ texto, chatLid, telefone }));

      const rvPre = await query(
        'SELECT * FROM movatak_vendedores WHERE cliente_id = $1 AND COALESCE(ativo, true) = true',
        [cliente.id]
      );

      const colsComandoPre = await query(
        `SELECT comando FROM movatak_funil_colunas
          WHERE cliente_id=$1 AND ativo=true AND comando IS NOT NULL AND TRIM(comando) <> ''`,
        [cliente.id]
      ).catch(() => ({ rows: [] }));
      const comandosColuna = colsComandoPre.rows.map(c => c.comando);

      const ehComandoInterno = textoPareceComandoInterno(texto, comandos, rvPre.rows, cliente.questionario_comando_parar, cliente.questionario_comando_ativar)
        || contemComando(texto, comandosColuna);
      const leadFromMe = await localizarLeadPorPayload(cliente.id, telefone, chatLid, ehComandoInterno);

      if (!leadFromMe) {
        console.log('[zapi][fromMe] lead nao encontrado para registrar mensagem/comando', JSON.stringify({ chatLid, telefone, ehComandoInterno }));
        return;
      }

      const midiaFromMe = extrairMidiaPayloadZapi(body);
      if ((texto && String(texto).trim()) || midiaFromMe) {
        await registrarConversa(leadFromMe.id, cliente.id, 'saida', texto || '', midiaFromMe).catch(() => null);
      }

      if (!ehComandoInterno) {
        logDebug('[zapi][fromMe] mensagem normal registrada no histórico do Kanban');
        return;
      }

      const lead = leadFromMe;

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
          `UPDATE movatak_leads SET etapa = 'cliente', vendedor_id = $1, convertido_em = NOW(), atualizado_em = NOW() WHERE id = $2`,
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
          `UPDATE movatak_leads SET etapa = 'cliente', convertido_em = NOW(), atualizado_em = NOW() WHERE id = $1`,
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
            `UPDATE movatak_leads SET etapa = 'lead', vendedor_id = NULL, convertido_em = NULL, atualizado_em = NOW() WHERE id = $1`,
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

      // -- Comando: pausar automação --
      if (contemComando(texto, comandos.pausar)) {
        await query(
          `UPDATE movatak_leads SET automacao_pausada = true, atualizado_em = NOW() WHERE id = $1`,
          [lead.id]
        );
        await query(
          `UPDATE movatak_followup SET status = 'pausado' WHERE lead_id = $1 AND status = 'pendente'`,
          [lead.id]
        );
        await query(
          `UPDATE movatak_questionario_estado SET status = 'cancelado', atualizado_em = NOW()
           WHERE lead_id = $1 AND status = 'em_andamento'`,
          [lead.id]
        ).catch(() => null);
        await registrarEventoLead(lead.id, cliente.id, 'automacao_pausada', 'Automação pausada manualmente por comando', { comando: texto });
        console.log(`[zapi] Automação pausada -> lead ${lead.id}`);
        return;
      }

      // -- Comando: parar atendimento (autoatendimento) --
      if (textoBateComandoParar(texto, cliente.questionario_comando_parar)) {
        await pararAtendimentoLead(cliente.id, lead.id, 'vendedor', texto);
        return;
      }

      // -- Comando: ativar/reiniciar autoatendimento (questionário do zero) --
      if (textoBateComandoAtivar(texto, cliente.questionario_comando_ativar)) {
        if (!cliente.questionario_ativo) {
          console.log(`[zapi] Comando ativar ignorado — questionário desativado para cliente ${cliente.id}`);
          return;
        }
        await reiniciarQuestionarioLead(cliente, lead, texto);
        return;
      }

      // -- Comando: mover lead para uma coluna do kanban --
      if (await moverLeadPorComandoColuna(cliente, lead, texto)) {
        return;
      }

      return;
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

    // Buscar lead pelo telefone (tolerante ao 9º dígito)
    const _varMsg = variantesTelefone(telefone);
    const rl = await query(
      `SELECT * FROM movatak_leads WHERE cliente_id = $1 AND telefone IN (${_varMsg.map((_, i) => '$' + (i + 2)).join(',')}) ORDER BY atualizado_em DESC NULLS LAST, criado_em DESC LIMIT 1`,
      [cliente.id, ..._varMsg]
    );
    const lead = rl.rows[0] || null;

    // Gravar mensagem recebida na conversa (agora que o lead está disponível)
    if (lead && texto) {
      registrarConversa(lead.id, cliente.id, 'entrada', texto, null).catch(() => null);
    }

    // Se automação pausada manualmente: apenas grava a mensagem, ignora toda lógica de automação.
    // Retomar: vendedor usa o comando de followup ou convertido para reativar.
    if (lead && lead.automacao_pausada) {
      logDebug('[zapi][lead] automacao pausada — mensagem gravada, automacao ignorada');
      return;
    }

    // ===== COMANDO: PARAR ATENDIMENTO (cliente pede atendente humano) =====
    // Funciona em qualquer ponto, inclusive durante o questionário.
    if (lead && textoBateComandoParar(texto, cliente.questionario_comando_parar)) {
      await pararAtendimentoLead(cliente.id, lead.id, 'cliente', texto);
      return;
    }

    // ===== QUESTIONÁRIO EM ANDAMENTO (venda consultiva) =====
    // Se existe um estado em andamento para o lead, a mensagem é tratada pelo
    // motor do questionário. Não depende do flag global do cliente, pois o
    // questionário pode ter sido iniciado por um template vinculado à campanha.
    if (lead) {
      const estQ = await query(
        `SELECT * FROM movatak_questionario_estado
          WHERE cliente_id = $1 AND lead_id = $2 AND status = 'em_andamento'
          ORDER BY id DESC LIMIT 1`,
        [cliente.id, lead.id]
      ).catch(() => ({ rows: [] }));
      if (estQ.rows.length) {
        await processarRespostaQuestionario(cliente, lead, estQ.rows[0], texto);
        return;
      }
    }

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

      // Reentrada por gatilho só vale para leads "frios": novo contato, em follow-up
      // ou descartado. Nunca reativa quem está no meio do questionário (auto_atendimento),
      // já qualificado (negociacao) ou fechado (cliente) — isso causava o reinício do fluxo.
      const etapasReentrada = ['lead', 'followup', 'descartado'];
      if (triggerOk && etapasReentrada.includes(lead.etapa)) {
        // Não reativar o FU1 se o lead já está em conversa ativa (respondeu nas últimas horas).
        // Evita reenviar boas-vindas/follow-up quando a mensagem com gatilho é continuação do papo.
        if (await leadRespondeuRecentemente(lead.id, MOVATAK_REENTRADA_FU1_HORAS)) {
          await registrarEventoLead(lead.id, cliente.id, 'reentrada_ignorada_conversa_ativa', 'Reentrada FU1 ignorada: lead em conversa ativa', { telefone }).catch(() => null);
          console.log(`[anti-spam] reentrada FU1 ignorada (conversa ativa) -> lead ${lead.id}`);
          if (lead.etapa === 'followup') {
            await query(`UPDATE movatak_leads SET etapa = 'lead', atualizado_em = NOW() WHERE id = $1`, [lead.id]);
            await query(`UPDATE movatak_followup SET status = 'pausado' WHERE lead_id = $1 AND status = 'pendente'`, [lead.id]);
          }
          return;
        }
        if (!(await reentradaFU1Permitida(lead.id))) {
          await registrarEventoLead(lead.id, cliente.id, 'anti_spam_reentrada', 'Reentrada no FU1 bloqueada por intervalo mínimo', { telefone, horas: MOVATAK_REENTRADA_FU1_HORAS });
          console.log(`[anti-spam] reentrada FU1 bloqueada -> lead ${lead.id}`);
          return;
        }
        await query(
          `UPDATE movatak_leads
             SET etapa = 'followup', nome = COALESCE($1, nome), automacao_pausada = false, atualizado_em = NOW()
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
      // Registra também a primeira mensagem do lead que criou o atendimento.
      // Antes ela ficava fora do histórico porque o lead ainda não existia no momento inicial da busca.
      await registrarConversa(novoLead.rows[0].id, cliente.id, 'entrada', texto || '', extrairMidiaPayloadZapi(body)).catch(() => null);

      // Decide se inicia o questionário:
      // - Campanha com template de questionário vinculado → usa o questionário do template.
      // - Senão, usa o questionário do cliente (se ativo).
      // A flag questionario_ativo da campanha permite desligar (vai direto ao follow-up).
      const campanhaPermiteQuest = !campanhaDetectada || campanhaDetectada.questionario_ativo !== false;
      const temTemplateQuest = campanhaDetectada && campanhaDetectada.questionario_template_id;
      const deveIniciarQuest = campanhaPermiteQuest && (temTemplateQuest || cliente.questionario_ativo);
      const leadObj = { id: novoLead.rows[0].id, telefone, nome: body.senderName || null, chat_lid: chatLid, campanha_id: campanhaDetectada ? campanhaDetectada.id : null };
      if (deveIniciarQuest) {
        await iniciarQuestionario(cliente, leadObj);
        console.log(`[zapi] Novo lead + questionario iniciado -> ${telefone} (${cliente.nome})`);
      } else {
        await agendarFollowupV2(novoLead.rows[0].id, cliente.id, 1, true);
        await enviarFollowupsPendentesDoLead(novoLead.rows[0].id, 1);
        console.log(`[zapi] Novo lead criado em FU1 -> ${telefone} (${cliente.nome})`);
      }
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
    desfazer: normalizarListaComandos(src.desfazer || src.comando_desfazer || src.estornar || src.comando_estornar),
    pausar: normalizarListaComandos(src.pausar || src.comando_pausar)
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
      ...comandos.descartar, ...comandos.desfazer, ...(comandos.pausar || [])
    ];
    const duplicado = todos.find((c, i) => todos.indexOf(c) !== i);
    if (duplicado) {
      return res.status(400).json({ error: 'O comando "' + duplicado + '" esta repetido. Cada comando deve ser unico.' });
    }

    // Validação: não pode colidir com comando de vendedor já cadastrado
    const rv = await query(
      'SELECT comando FROM movatak_vendedores WHERE cliente_id = $1 AND COALESCE(ativo, true) = true AND comando IS NOT NULL',
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
        ...(cmds.descartar || []), ...(cmds.desfazer || []), ...(cmds.pausar || [])
      ].map(c => String(c).trim().toLowerCase());
      if (todosCliente.includes(comando)) {
        return res.status(400).json({ error: 'Esse comando ja esta em uso na automacao do cliente.' });
      }

      // Não pode colidir com outro vendedor
      const ro = await query(
        'SELECT comando FROM movatak_vendedores WHERE cliente_id = $1 AND id != $2 AND COALESCE(ativo, true) = true AND comando IS NOT NULL',
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
    const leadPeriodoSQL = dias === 0 ? "DATE(l.criado_em) = CURRENT_DATE" : `l.criado_em >= NOW() - INTERVAL '${dias} days'`;
    const vendaPeriodoSQL = dias === 0 ? "DATE(COALESCE(l.convertido_em, l.atualizado_em)) = CURRENT_DATE" : `COALESCE(l.convertido_em, l.atualizado_em) >= NOW() - INTERVAL '${dias} days'`;
    const m = await query(
      `SELECT COUNT(l.id) FILTER (WHERE ${leadPeriodoSQL})::int AS leads_atribuidos,
              COUNT(l.id) FILTER (WHERE l.etapa = 'cliente' AND ${vendaPeriodoSQL})::int AS vendas,
              COUNT(l.id) FILTER (WHERE l.etapa = 'followup')::int AS em_followup,
              COUNT(l.id) FILTER (WHERE DATE(l.criado_em) = CURRENT_DATE)::int AS leads_hoje,
              COUNT(l.id) FILTER (WHERE l.etapa = 'cliente' AND DATE(COALESCE(l.convertido_em, l.atualizado_em)) = CURRENT_DATE)::int AS vendas_hoje
         FROM movatak_leads l
        WHERE l.vendedor_id = $1`,
      [req.vendedor.id]
    );
    const ranking = await query(
      `SELECT v.nome,
              COUNT(l.id) FILTER (WHERE l.etapa = 'cliente')::int AS vendas
         FROM movatak_vendedores v
         LEFT JOIN movatak_leads l ON l.vendedor_id = v.id AND l.criado_em >= NOW() - INTERVAL '30 days'
        WHERE v.cliente_id = $1 AND COALESCE(v.ativo, true) = true
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

    // Períodos reutilizáveis: leads por data de entrada; vendas por data de conversão.
    const leadPeriodoSQL = dias === 0
      ? "DATE(criado_em) = CURRENT_DATE"
      : `criado_em >= NOW() - INTERVAL '${dias} days'`;
    const vendaPeriodoSQL = dias === 0
      ? "DATE(COALESCE(convertido_em, atualizado_em)) = CURRENT_DATE"
      : `COALESCE(convertido_em, atualizado_em) >= NOW() - INTERVAL '${dias} days'`;

    // Métricas do cliente no período
    const m = await query(
      `SELECT
         COUNT(*) FILTER (WHERE etapa != 'descartado' AND ${leadPeriodoSQL})  AS total_leads,
         COUNT(*) FILTER (WHERE etapa = 'cliente' AND ${vendaPeriodoSQL})     AS convertidos,
         COUNT(*) FILTER (WHERE etapa = 'followup')                           AS em_followup,
         COUNT(*) FILTER (WHERE DATE(criado_em) = CURRENT_DATE)               AS leads_hoje,
         COUNT(*) FILTER (WHERE etapa = 'cliente' AND DATE(COALESCE(convertido_em, atualizado_em)) = CURRENT_DATE) AS vendas_hoje
       FROM movatak_leads
       WHERE cliente_id = $1`,
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
              COUNT(l.id) FILTER (WHERE l.etapa = 'cliente' AND ${vendaPeriodoSQL.replace(/COALESCE\(convertido_em, atualizado_em\)/g, 'COALESCE(l.convertido_em, l.atualizado_em)')}) AS fechamentos,
              COUNT(l.id) FILTER (WHERE ${leadPeriodoSQL.replace(/criado_em/g, 'l.criado_em')}) AS leads_atribuidos
       FROM movatak_vendedores vd
       LEFT JOIN movatak_leads l ON l.vendedor_id = vd.id AND l.cliente_id = $1
       WHERE vd.cliente_id = $1 AND COALESCE(vd.ativo, true) = true
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
app.get('/movatak/admin/leads/:id/conversas', authMovatak, async (req, res) => {
  try {
    await garantirEstruturaConversas();
    // Mensagens registradas no banco
    const r = await query(
      `SELECT id, direcao, conteudo, midia_url, criado_em
         FROM movatak_conversas WHERE lead_id = $1
         ORDER BY criado_em ASC LIMIT 300`,
      [req.params.id]
    );
    const banco = r.rows.map(m => ({ ...m, fonte: 'banco' }));

    // Tenta buscar histórico do Z-API (sessão ativa)
    const rl = await query(
      `SELECT l.telefone, c.zapi_instance, c.zapi_token, c.zapi_client_token
         FROM movatak_leads l JOIN movatak_clientes c ON c.id = l.cliente_id
        WHERE l.id = $1`,
      [req.params.id]
    );
    let zapiMsgs = [];
    if (rl.rows.length) {
      const row = rl.rows[0];
      const phone = String(row.telefone || '').replace(/\D/g, '');
      try {
        // Z-API: tenta buscar histórico do chat (disponível apenas na sessão ativa)
        const endpoints = [
          `${ZAPI_BASE}/${row.zapi_instance}/token/${row.zapi_token}/chat-messages/${phone}`,
          `${ZAPI_BASE}/${row.zapi_instance}/token/${row.zapi_token}/messages?phone=${phone}&page=0&pageSize=100`,
          `${ZAPI_BASE}/${row.zapi_instance}/token/${row.zapi_token}/last-messages?phone=${phone}&qtd=100`
        ];
        let resp = null;
        for (const url of endpoints) {
          try {
            resp = await axios.get(url, {
              headers: { 'Client-Token': row.zapi_client_token || '' },
              timeout: 5000
            });
            if (resp.data && (Array.isArray(resp.data) || Array.isArray(resp.data?.messages) || Array.isArray(resp.data?.value))) break;
          } catch (e2) { /* tenta próximo */ }
        }
        if (!resp) throw new Error('Nenhum endpoint respondeu');
        const msgs = Array.isArray(resp.data) ? resp.data
          : Array.isArray(resp.data?.messages) ? resp.data.messages
          : Array.isArray(resp.data?.value) ? resp.data.value : [];
        console.log(`[conversas][zapi] ${msgs.length} msgs para lead ${req.params.id}`);
        zapiMsgs = msgs.map(m => ({
          id: 'zapi_' + (m.messageId || m.id || Math.random()),
          direcao: m.fromMe ? 'saida' : 'entrada',
          conteudo: m.text?.message || m.body || m.caption || m.text || null,
          midia_url: m.image?.imageUrl || m.video?.videoUrl || m.audio?.audioUrl || null,
          criado_em: m.timestamp
            ? new Date(m.timestamp * 1000).toISOString()
            : (m.momentsAgo ? new Date(Date.now() - m.momentsAgo * 1000).toISOString() : null),
          fonte: 'zapi'
        })).filter(m => m.criado_em && (m.conteudo || m.midia_url));
      } catch (e) {
        console.log('[conversas] Z-API histórico indisponível:', e.message);
      }
    }

    // Mescla: banco tem prioridade para deduplicação (mesmo texto + horário próximo)
    const todos = [...banco];
    for (const zm of zapiMsgs) {
      const dt = new Date(zm.criado_em).getTime();
      const duplicado = banco.some(b => {
        const diff = Math.abs(new Date(b.criado_em).getTime() - dt);
        return diff < 30000 && b.direcao === zm.direcao && b.conteudo === zm.conteudo;
      });
      if (!duplicado) todos.push(zm);
    }
    todos.sort((a, b) => new Date(a.criado_em) - new Date(b.criado_em));
    res.json(todos);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
    ADD COLUMN IF NOT EXISTS questionario_ativo BOOLEAN DEFAULT true,
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


// ============================================================
// Questionário consultivo — schema, motor e recomendação
// ============================================================
async function garantirEstruturaQuestionario() {
  await query(`ALTER TABLE movatak_clientes
    ADD COLUMN IF NOT EXISTS questionario_ativo BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS questionario_intro TEXT,
    ADD COLUMN IF NOT EXISTS questionario_final TEXT,
    ADD COLUMN IF NOT EXISTS questionario_intro_imagem TEXT,
    ADD COLUMN IF NOT EXISTS questionario_final_imagem TEXT,
    ADD COLUMN IF NOT EXISTS questionario_passos JSONB DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS questionario_recomendacao JSONB DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS questionario_comando_parar TEXT,
    ADD COLUMN IF NOT EXISTS questionario_comando_ativar TEXT`).catch(() => null);

  // Templates de autoatendimento (questionário), reutilizáveis e vinculáveis a campanhas.
  await query(`CREATE TABLE IF NOT EXISTS movatak_questionario_templates (
    id SERIAL PRIMARY KEY,
    cliente_id INTEGER,
    nome TEXT NOT NULL,
    intro TEXT,
    final TEXT,
    intro_imagem TEXT,
    final_imagem TEXT,
    passos JSONB DEFAULT '[]'::jsonb,
    recomendacao JSONB DEFAULT '[]'::jsonb,
    comando_parar TEXT,
    comando_ativar TEXT,
    ativo BOOLEAN DEFAULT true,
    criado_em TIMESTAMPTZ DEFAULT NOW(),
    atualizado_em TIMESTAMPTZ DEFAULT NOW()
  )`).catch(() => null);
  await query(`ALTER TABLE movatak_campanhas ADD COLUMN IF NOT EXISTS questionario_template_id INTEGER`).catch(() => null);
  await query(`CREATE INDEX IF NOT EXISTS idx_quest_templates_cliente ON movatak_questionario_templates(cliente_id, ativo)`).catch(() => null);

  await query(`CREATE TABLE IF NOT EXISTS movatak_questionario_estado (
    id SERIAL PRIMARY KEY,
    cliente_id INTEGER NOT NULL,
    lead_id INTEGER,
    telefone TEXT NOT NULL,
    passo_idx INTEGER DEFAULT 0,
    respostas JSONB DEFAULT '{}'::jsonb,
    status TEXT DEFAULT 'em_andamento',
    criado_em TIMESTAMPTZ DEFAULT NOW(),
    atualizado_em TIMESTAMPTZ DEFAULT NOW()
  )`).catch(() => null);

  await query(`ALTER TABLE movatak_questionario_estado ADD COLUMN IF NOT EXISTS lembretes INTEGER DEFAULT 0`).catch(() => null);

  await query(`CREATE TABLE IF NOT EXISTS movatak_cobertura_cep (
    id SERIAL PRIMARY KEY,
    cliente_id INTEGER NOT NULL,
    cep TEXT NOT NULL,
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`).catch(() => null);

  await query(`CREATE INDEX IF NOT EXISTS idx_movatak_quest_estado ON movatak_questionario_estado(cliente_id, telefone, status)`).catch(() => null);
  await query(`ALTER TABLE movatak_questionario_estado ADD COLUMN IF NOT EXISTS tentativas_invalidas INTEGER DEFAULT 0`).catch(() => null);
  await query(`ALTER TABLE movatak_leads ADD COLUMN IF NOT EXISTS automacao_pausada BOOLEAN DEFAULT false`).catch(() => null);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_movatak_cobertura_unq ON movatak_cobertura_cep(cliente_id, cep)`).catch(() => null);
}

async function garantirEstruturaPlanos() {
  await query(`CREATE TABLE IF NOT EXISTS movatak_planos (
    id SERIAL PRIMARY KEY,
    cliente_id INTEGER NOT NULL,
    nome TEXT NOT NULL,
    valor NUMERIC,
    nota_minima INTEGER DEFAULT 0,
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`).catch(() => null);
  await query(`ALTER TABLE movatak_planos ADD COLUMN IF NOT EXISTS valor NUMERIC`).catch(() => null);
  await query(`ALTER TABLE movatak_planos ADD COLUMN IF NOT EXISTS nota_minima INTEGER DEFAULT 0`).catch(() => null);
  // Vínculo plano <-> template de questionário (muitos-para-muitos).
  // Plano sem nenhum vínculo aparece em todos os questionários (compatível com o comportamento atual).
  await query(`CREATE TABLE IF NOT EXISTS movatak_plano_templates (
    plano_id INTEGER NOT NULL,
    template_id INTEGER NOT NULL,
    PRIMARY KEY (plano_id, template_id)
  )`).catch(() => null);
  await query(`CREATE INDEX IF NOT EXISTS idx_plano_templates_tpl ON movatak_plano_templates(template_id)`).catch(() => null);
}

function normalizarCep(cep) {
  return String(cep || '').replace(/\D/g, '');
}

// Envia mensagem do questionário: com mídia (legenda junto) quando houver, senão texto.
function tipoMidia(url) {
  return /\.(mp4|webm|mov|m4v|3gp)(\?|$)/i.test(String(url || '')) ? 'video' : 'image';
}
async function enviarMsgQuestionario(cliente, telefone, texto, midia) {
  // Encontra o lead_id pelo telefone para gravar na conversa
  const lr = await query('SELECT id FROM movatak_leads WHERE cliente_id=$1 AND telefone=$2 ORDER BY criado_em DESC LIMIT 1', [cliente.id, telefone]).catch(() => ({ rows: [] }));
  const leadId = lr.rows[0] ? lr.rows[0].id : null;
  let resultado;
  if (midia && String(midia).trim()) {
    const url = String(midia).trim();
    if (tipoMidia(url) === 'video') {
      resultado = await zapiEnviarVideo(cliente.zapi_instance, cliente.zapi_token, cliente.zapi_client_token, telefone, url, texto);
    } else {
      resultado = await zapiEnviarImagem(cliente.zapi_instance, cliente.zapi_token, cliente.zapi_client_token, telefone, url, texto);
    }
    if (leadId) registrarConversa(leadId, cliente.id, 'saida', texto || '', midia).catch(() => null);
  } else {
    resultado = await zapiEnviar(cliente.zapi_instance, cliente.zapi_token, cliente.zapi_client_token, telefone, texto);
    if (leadId) registrarConversa(leadId, cliente.id, 'saida', texto || '', null).catch(() => null);
  }
  return resultado;
}

// Upload de imagem para o Supabase Storage. Retorna a URL pública.
async function uploadSupabase(buffer, contentType, ext) {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  const bucket = process.env.SUPABASE_BUCKET || 'movatak';
  if (!base || !key) throw new Error('Storage não configurado: defina SUPABASE_URL e SUPABASE_SERVICE_KEY no Railway.');
  const nome = 'quest/' + Date.now() + '_' + crypto.randomBytes(6).toString('hex') + '.' + ext;
  const url = `${base.replace(/\/$/, '')}/storage/v1/object/${bucket}/${nome}`;
  await axios.post(url, buffer, {
    headers: {
      'Authorization': 'Bearer ' + key,
      'apikey': key,
      'Content-Type': contentType,
      'x-upsert': 'true'
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity
  });
  return `${base.replace(/\/$/, '')}/storage/v1/object/public/${bucket}/${nome}`;
}

async function cepTemCobertura(clienteId, cep) {
  try {
    const c = normalizarCep(cep);
    if (!c) return false;
    const r = await query(
      `SELECT 1 FROM movatak_cobertura_cep WHERE cliente_id = $1 AND $2 LIKE cep || '%' LIMIT 1`,
      [clienteId, c]
    );
    return r.rows.length > 0;
  } catch (e) {
    console.error('[questionario][cobertura] erro:', e.message);
    return false;
  }
}

function montarTextoPergunta(passo) {
  if (!passo) return '';
  const base = passo.pergunta || '';
  if (passo.tipo === 'sim_nao') {
    return base + '\n\n1 - Sim\n2 - Não';
  }
  if (passo.tipo === 'opcoes') {
    const ops = Array.isArray(passo.opcoes) ? passo.opcoes : [];
    const lista = ops.map((o, i) => `${i + 1} - ${o}`).join('\n');
    return base + (lista ? '\n\n' + lista : '');
  }
  return base; // texto e cep
}

function interpretarResposta(passo, texto) {
  const t = String(texto || '').trim();
  if (!t) return { ok: false };
  if (passo.tipo === 'cep') {
    const cep = normalizarCep(t);
    if (cep.length < 8) return { ok: false, motivo: 'cep_invalido' };
    return { ok: true, valor: cep.slice(0, 8) };
  }
  if (passo.tipo === 'sim_nao') {
    const l = t.toLowerCase();
    if (l === '1' || l === 'sim' || l === 's') return { ok: true, valor: 'Sim', indice: 1 };
    if (l === '2' || l === 'nao' || l === 'não' || l === 'n') return { ok: true, valor: 'Não', indice: 2 };
    return { ok: false };
  }
  if (passo.tipo === 'opcoes') {
    const ops = Array.isArray(passo.opcoes) ? passo.opcoes : [];
    const n = parseInt(t, 10);
    if (!isNaN(n) && n >= 1 && n <= ops.length) return { ok: true, valor: ops[n - 1], indice: n };
    const match = ops.findIndex(o => String(o).trim().toLowerCase() === t.toLowerCase());
    if (match >= 0) return { ok: true, valor: ops[match], indice: match + 1 };
    return { ok: false };
  }
  return { ok: true, valor: t }; // texto livre
}

// Resolve o próximo índice de passo considerando saltos condicionais.
// passo.saltos: { "<indice_opcao>": "<id_destino>" | "__fim__" }
// Retorna: índice do passo destino, -1 para encerrar (fim), ou null para seguir linear (idx+1).
function resolverSaltoQuestionario(passo, indiceOpcao, passos) {
  if (!passo || !passo.saltos || typeof passo.saltos !== 'object') return null;
  const destino = passo.saltos[String(indiceOpcao)];
  if (!destino) return null;
  if (destino === '__fim__') return -1;
  const idxDestino = passos.findIndex(p => p.id === destino);
  return idxDestino >= 0 ? idxDestino : null; // destino inválido → segue linear
}

// Pontuação: cada pergunta "opções numeradas" pontua pela posição da opção
// escolhida (1ª = 1 ... última = N). A soma define o plano pela nota mínima.
function calcularPontuacao(cliente, respostas) {
  const passos = Array.isArray(cliente.questionario_passos) ? cliente.questionario_passos : [];
  let total = 0;
  for (const p of passos) {
    if (p.tipo === 'opcoes' && respostas[p.id] !== undefined) {
      const ops = Array.isArray(p.opcoes) ? p.opcoes : [];
      const idx = ops.findIndex(o => String(o).trim().toLowerCase() === String(respostas[p.id]).trim().toLowerCase());
      if (idx >= 0) total += (idx + 1);
    }
  }
  return total;
}

async function calcularRecomendacao(cliente, respostas) {
  try {
    const total = calcularPontuacao(cliente, respostas);
    await garantirEstruturaPlanos();
    const tplId = cliente.__quest_template_id || null;
    let rp;
    if (tplId) {
      // Planos vinculados a este template OU sem nenhum vínculo (aparecem em todos).
      rp = await query(
        `SELECT p.id, p.nome, p.valor, p.nota_minima
           FROM movatak_planos p
          WHERE p.cliente_id = $1
            AND (
              EXISTS (SELECT 1 FROM movatak_plano_templates pt WHERE pt.plano_id = p.id AND pt.template_id = $2)
              OR NOT EXISTS (SELECT 1 FROM movatak_plano_templates pt2 WHERE pt2.plano_id = p.id)
            )
          ORDER BY p.nota_minima ASC, p.valor ASC NULLS LAST, p.id ASC`,
        [cliente.id, tplId]
      );
    } else {
      // Questionário do cliente (sem template): planos sem vínculo a nenhum template.
      // Isso evita que um produto exclusivo de um template vaze para o questionário padrão.
      rp = await query(
        `SELECT p.id, p.nome, p.valor, p.nota_minima
           FROM movatak_planos p
          WHERE p.cliente_id = $1
            AND NOT EXISTS (SELECT 1 FROM movatak_plano_templates pt WHERE pt.plano_id = p.id)
          ORDER BY p.nota_minima ASC, p.valor ASC NULLS LAST, p.id ASC`,
        [cliente.id]
      );
    }
    const planos = rp.rows || [];
    if (!planos.length) return { plano: null, total };
    let escolhido = planos[0]; // padrão: menor faixa
    for (const pl of planos) {
      if ((pl.nota_minima || 0) <= total) escolhido = pl;
    }
    return { plano: escolhido, total };
  } catch (e) {
    console.error('[questionario][recomendacao] erro:', e.message);
    return { plano: null, total: 0 };
  }
}

// Avança o questionário a partir de fromIdx: envia cada passo; em passo que
// "aguarda resposta" para e espera o lead; em passo só-material (aguardar=false)
// envia e segue para o próximo automaticamente. No fim, finaliza.
async function avancarQuestionario(cliente, lead, estadoId, respostas, fromIdx, prefix) {
  const passos = Array.isArray(cliente.questionario_passos) ? cliente.questionario_passos : [];
  let idx = fromIdx;
  let pref = prefix || '';
  let guarda = 0;
  while (guarda++ < 50) {
    const passo = passos[idx];
    if (!passo) {
      if (pref) await enviarMsgQuestionario(cliente, lead.telefone, pref, '');
      await query(`UPDATE movatak_questionario_estado SET passo_idx=$1, respostas=$2::jsonb, status='concluido', atualizado_em=NOW() WHERE id=$3`, [idx, JSON.stringify(respostas), estadoId]).catch(() => null);
      await finalizarQuestionario(cliente, lead, respostas);
      return;
    }
    const aguarda = passo.aguardar !== false;
    const corpo = aguarda ? montarTextoPergunta(passo) : (passo.pergunta || '');
    const texto = (pref ? pref + '\n\n' : '') + corpo;
    const delaySegundos = normalizarDelayQuestionario(passo);
    if (delaySegundos > 0) {
      await sleep(delaySegundos * 1000);
    }
    await enviarMsgQuestionario(cliente, lead.telefone, texto || ' ', passo.imagem);
    pref = '';
    if (aguarda) {
      await query(`UPDATE movatak_questionario_estado SET passo_idx=$1, respostas=$2::jsonb, lembretes=0, status='em_andamento', atualizado_em=NOW() WHERE id=$3`, [idx, JSON.stringify(respostas), estadoId]).catch(() => null);
      return;
    }
    // passo só-material: não espera resposta, segue para o próximo
    await query(`UPDATE movatak_questionario_estado SET passo_idx=$1, atualizado_em=NOW() WHERE id=$2`, [idx + 1, estadoId]).catch(() => null);
    idx++;
  }
}

// Retorna um objeto "cliente efetivo": uma cópia do cliente com os campos de
// questionário sobrescritos pelo template de autoatendimento vinculado à campanha
// do lead. Se a campanha não tem template, usa o questionário do próprio cliente.
async function resolverQuestionarioDoLead(cliente, lead) {
  try {
    if (!lead || !lead.campanha_id) return cliente;
    const r = await query(
      `SELECT qt.*
         FROM movatak_campanhas c
         JOIN movatak_questionario_templates qt
           ON qt.id = c.questionario_template_id AND qt.ativo = true
        WHERE c.id = $1`,
      [lead.campanha_id]
    );
    if (!r.rows.length) return cliente;
    const qt = r.rows[0];
    return {
      ...cliente,
      questionario_intro: qt.intro,
      questionario_final: qt.final,
      questionario_intro_imagem: qt.intro_imagem,
      questionario_final_imagem: qt.final_imagem,
      questionario_passos: qt.passos || [],
      questionario_recomendacao: qt.recomendacao || [],
      questionario_comando_parar: qt.comando_parar,
      questionario_comando_ativar: qt.comando_ativar,
      __quest_template_id: qt.id
    };
  } catch (e) {
    console.error('[questionario][resolver-template]', e.message);
    return cliente;
  }
}

async function iniciarQuestionario(cliente, lead) {
  try {
    cliente = await resolverQuestionarioDoLead(cliente, lead);
    const passos = Array.isArray(cliente.questionario_passos) ? cliente.questionario_passos : [];
    if (!passos.length) {
      await agendarFollowupV2(lead.id, cliente.id, 1, true);
      await enviarFollowupsPendentesDoLead(lead.id, 1);
      return;
    }
    const nome = lead.nome ? (' ' + String(lead.nome).split(' ')[0]) : '';

    // 1) boas-vindas
    const boas = (cliente.boas_vindas_msg || 'Seja bem-vindo(a){nome}! Obrigado pelo contato.').replace(/{nome}/g, nome);
    await zapiEnviar(cliente.zapi_instance, cliente.zapi_token, cliente.zapi_client_token, lead.telefone, boas);

    // pausa o follow-up automático enquanto o questionário roda
    await query(`UPDATE movatak_followup SET status = 'pausado' WHERE lead_id = $1 AND status = 'pendente'`, [lead.id]).catch(() => null);
    await moverLeadParaFunilSlug(cliente.id, lead.id, 'auto_atendimento').catch(e => console.error('[funil][auto_atendimento]', e.message));

    // cria estado
    const ins = await query(
      `INSERT INTO movatak_questionario_estado (cliente_id, lead_id, telefone, passo_idx, respostas, status)
       VALUES ($1, $2, $3, 0, '{}'::jsonb, 'em_andamento')
       RETURNING id`,
      [cliente.id, lead.id, lead.telefone]
    );
    const estadoId = ins.rows[0].id;

    // 2) introdução (opcional, texto e/ou imagem)
    const introTxt = (cliente.questionario_intro && String(cliente.questionario_intro).trim())
      ? String(cliente.questionario_intro).replace(/{nome}/g, nome)
      : '';
    const introImg = cliente.questionario_intro_imagem || '';
    if (introTxt || introImg) {
      await enviarMsgQuestionario(cliente, lead.telefone, introTxt || ' ', introImg);
    }

    // 3) primeiro passo (avança por etapas só-material até a primeira que espera resposta)
    await avancarQuestionario(cliente, lead, estadoId, {}, 0, '');

    await registrarEventoLead(lead.id, cliente.id, 'questionario_iniciado', 'Questionário consultivo iniciado', { total_perguntas: passos.length });
  } catch (e) {
    console.error('[questionario][iniciar] erro:', e.message);
  }
}

async function processarRespostaQuestionario(cliente, lead, estado, texto) {
  try {
    cliente = await resolverQuestionarioDoLead(cliente, lead);
    const passos = Array.isArray(cliente.questionario_passos) ? cliente.questionario_passos : [];
    const idx = estado.passo_idx || 0;
    const passo = passos[idx];
    if (!passo) {
      await query(`UPDATE movatak_questionario_estado SET status='concluido', atualizado_em=NOW() WHERE id=$1`, [estado.id]).catch(() => null);
      return;
    }

    const respostas = (estado.respostas && typeof estado.respostas === 'object') ? estado.respostas : {};

    // Passo só-material (não espera resposta): apenas segue adiante.
    if (passo.aguardar === false) {
      await avancarQuestionario(cliente, lead, estado.id, respostas, idx + 1, '');
      return;
    }

    const interp = interpretarResposta(passo, texto);
    if (!interp.ok) {
      const tentativas = (estado.tentativas_invalidas || 0) + 1;
      await query(
        `UPDATE movatak_questionario_estado SET tentativas_invalidas = $1, atualizado_em = NOW() WHERE id = $2`,
        [tentativas, estado.id]
      );

      if (tentativas <= 2) {
        // Ainda dentro do limite — envia dica e re-pergunta
        const dica = interp.motivo === 'cep_invalido'
          ? 'Não consegui ler o CEP. Me envia os 8 números, ex: 50000000.'
          : `Não entendi sua resposta. (${tentativas}/2)`;
        await enviarMsgQuestionario(cliente, lead.telefone, dica + '\n\n' + montarTextoPergunta(passo), passo.imagem);
      } else {
        // Limite atingido — transfere para vendedor e encerra questionário
        const cmdParar = String(cliente.questionario_comando_parar || '').trim();
        const msgTransfer = cmdParar
          ? `Vou transferir seu atendimento para um dos meus colegas. 😊\n\nSe quiser falar agora com um atendente, é só responder ${cmdParar}.`
          : 'Vou transferir seu atendimento para um dos meus colegas. 😊';
        await enviarMsgQuestionario(cliente, lead.telefone, msgTransfer, null);
        await query(`UPDATE movatak_questionario_estado SET status = 'abandonado', atualizado_em = NOW() WHERE id = $1`, [estado.id]);
        await atribuirVendedorBalanceado(cliente.id, lead.id).catch(() => null);
        await moverLeadParaFunilSlug(cliente.id, lead.id, 'em_negociacao').catch(() => null);
        await agendarFollowupV2(lead.id, cliente.id, 1, true);
        await enviarFollowupsPendentesDoLead(lead.id, 1);
        await registrarEventoLead(lead.id, cliente.id, 'questionario_transferido', 'Lead transferido após 2 respostas inválidas', { passo_idx: estado.passo_idx });
        console.log(`[questionario][transferido] lead ${lead.id} transferido após ${tentativas} tentativas inválidas`);
      }
      return;
    }

    // Resposta válida — zera o contador de tentativas inválidas
    await query(
      `UPDATE movatak_questionario_estado SET tentativas_invalidas = 0 WHERE id = $1`,
      [estado.id]
    );

    respostas[passo.id] = interp.valor;

    let notaCep = '';
    if (passo.tipo === 'cep') {
      const coberto = await cepTemCobertura(cliente.id, interp.valor);
      respostas._cobertura = coberto;
      respostas._cep = interp.valor;
      notaCep = coberto
        ? '✅ Boa notícia: atendemos a sua região!'
        : '⚠️ Vou confirmar a disponibilidade na sua região e já te retorno.';
    }

    // "Encerrar após esta pergunta": independente do tipo, ao responder esta
    // pergunta o questionário vai direto para a mensagem final (com recomendação).
    if (passo.encerrar_apos) {
      await query(`UPDATE movatak_questionario_estado SET respostas=$1::jsonb, status='concluido', atualizado_em=NOW() WHERE id=$2`, [JSON.stringify(respostas), estado.id]).catch(() => null);
      if (notaCep) await enviarMsgQuestionario(cliente, lead.telefone, notaCep, '').catch(() => null);
      await finalizarQuestionario(cliente, lead, respostas);
      return;
    }

    // Salto condicional: se a pergunta (opções/sim_não) define um destino para a
    // opção escolhida, pula para essa pergunta ou encerra (__fim__). Senão, segue linear.
    let proximoIdx = idx + 1;
    if ((passo.tipo === 'opcoes' || passo.tipo === 'sim_nao') && interp.indice) {
      const destino = resolverSaltoQuestionario(passo, interp.indice, passos);
      if (destino === -1) {
        // Salto para o fim: grava respostas e finaliza.
        await query(`UPDATE movatak_questionario_estado SET respostas=$1::jsonb, status='concluido', atualizado_em=NOW() WHERE id=$2`, [JSON.stringify(respostas), estado.id]).catch(() => null);
        if (notaCep) await enviarMsgQuestionario(cliente, lead.telefone, notaCep, '').catch(() => null);
        await finalizarQuestionario(cliente, lead, respostas);
        return;
      }
      if (destino !== null) proximoIdx = destino;
    }

    await avancarQuestionario(cliente, lead, estado.id, respostas, proximoIdx, notaCep);
  } catch (e) {
    console.error('[questionario][processar] erro:', e.message);
  }
}

async function finalizarQuestionario(cliente, lead, respostas) {
  try {
    const passos = Array.isArray(cliente.questionario_passos) ? cliente.questionario_passos : [];
    const rec = await calcularRecomendacao(cliente, respostas);
    const nome = lead.nome ? (' ' + String(lead.nome).split(' ')[0]) : '';
    const planoTxt = rec.plano
      ? (rec.plano.nome + (rec.plano.valor != null ? ' — R$ ' + Number(rec.plano.valor).toFixed(2).replace('.', ',') : ''))
      : 'um dos nossos planos';

    if (rec.plano) {
      await query(`UPDATE movatak_leads SET plano_id = $1, atualizado_em = NOW() WHERE id = $2`, [rec.plano.id, lead.id]).catch(() => null);
    }

    const finalTpl = (cliente.questionario_final && String(cliente.questionario_final).trim())
      ? cliente.questionario_final
      : 'Prontinho{nome}! Com base nas suas respostas, o plano ideal pra você é: {plano}. Um consultor já vai falar com você pra finalizar. 🙌';
    const finalMsg = finalTpl.replace(/{nome}/g, nome).replace(/{plano}/g, planoTxt);
    await enviarMsgQuestionario(cliente, lead.telefone, finalMsg, cliente.questionario_final_imagem);

    const resumoLinhas = passos
      .filter(p => p.pergunta_curta && String(p.pergunta_curta).trim() && respostas[p.id] !== undefined)
      .map(p => `${String(p.pergunta_curta).trim()}: ${respostas[p.id]}`);
    const cobTxt = (respostas._cobertura === true) ? 'SIM' : (respostas._cobertura === false ? 'NÃO (verificar)' : '—');
    const resumo =
      '🔔 Lead qualificado!\n' +
      `Nome: ${lead.nome || '—'}\n` +
      `Fone: ${lead.telefone}` +
      (resumoLinhas.length ? '\n' + resumoLinhas.join('\n') : '') +
      (respostas._cep ? `\nCEP: ${respostas._cep} | Cobertura: ${cobTxt}` : '') +
      (rec.plano ? `\nPlano sugerido: ${rec.plano.nome}` : '');

    const destino = cliente.whatsapp_dono || MOVATAK_ADMIN_WA;
    if (destino) {
      await zapiEnviar(cliente.zapi_instance, cliente.zapi_token, cliente.zapi_client_token, destino, resumo)
        .catch(e => console.error('[questionario][resumo vendedor]', e.message));
    }

    await moverLeadParaFunilSlug(cliente.id, lead.id, 'em_negociacao').catch(e => console.error('[funil][em_negociacao]', e.message));
    await atribuirVendedorBalanceado(cliente.id, lead.id).catch(e => console.error('[funil][distribuicao]', e.message));

    if (cliente.acao_arquivar_ao_final) {
      await zapiArquivar(cliente.zapi_instance, cliente.zapi_token, cliente.zapi_client_token, lead.telefone)
        .catch(e => console.error('[zapi][arquivar]', e.message));
    }
    if (cliente.acao_marcar_nao_lido) {
      await zapiMarcarNaoLido(cliente.zapi_instance, cliente.zapi_token, cliente.zapi_client_token, lead.telefone)
        .catch(e => console.error('[zapi][nao_lido]', e.message));
    }

    await registrarEventoLead(lead.id, cliente.id, 'questionario_concluido', 'Questionário concluído e plano recomendado', { respostas, plano_id: rec.plano ? rec.plano.id : null });
  } catch (e) {
    console.error('[questionario][finalizar] erro:', e.message);
  }
}

// Lead que travou no meio do questionário: manda lembrete e, se continuar sem
// responder, encerra e devolve o lead para o follow-up normal.
async function processarQuestionariosParados() {
  try {
    await garantirEstruturaQuestionario();
    const r = await query(
      `SELECT q.*, c.zapi_instance, c.zapi_token, c.zapi_client_token,
              c.questionario_passos, l.nome AS lead_nome, l.etapa AS lead_etapa
         FROM movatak_questionario_estado q
         JOIN movatak_clientes c ON c.id = q.cliente_id
         JOIN movatak_leads l ON l.id = q.lead_id
        WHERE q.status = 'em_andamento'
          AND q.atualizado_em < NOW() - make_interval(hours => $1::int)`,
      [MOVATAK_QUEST_LEMBRETE_HORAS]
    );
    for (const est of r.rows) {
      try {
        const cliente = {
          id: est.cliente_id,
          zapi_instance: est.zapi_instance,
          zapi_token: est.zapi_token,
          zapi_client_token: est.zapi_client_token,
          questionario_passos: est.questionario_passos
        };
        const lead = { id: est.lead_id, telefone: est.telefone, nome: est.lead_nome };
        const passos = Array.isArray(est.questionario_passos) ? est.questionario_passos : [];
        const passo = passos[est.passo_idx || 0];

        if ((est.lembretes || 0) < MOVATAK_QUEST_MAX_LEMBRETES) {
          if (passo) {
            await enviarMsgQuestionario(
              cliente, lead.telefone,
              '⏰ Ficou faltando só isso:\n\n' + montarTextoPergunta(passo),
              passo.imagem
            );
          }
          await query(`UPDATE movatak_questionario_estado SET lembretes = COALESCE(lembretes,0) + 1, atualizado_em = NOW() WHERE id = $1`, [est.id]);
          await registrarEventoLead(lead.id, est.cliente_id, 'questionario_lembrete', 'Lembrete enviado por inatividade no questionário', { passo_idx: est.passo_idx });
          console.log(`[questionario][lembrete] enviado -> lead ${lead.id}`);
        } else {
          await query(`UPDATE movatak_questionario_estado SET status = 'abandonado', atualizado_em = NOW() WHERE id = $1`, [est.id]);
          if (est.lead_etapa !== 'cliente') {
            await agendarFollowupV2(lead.id, est.cliente_id, 1, true);
            await enviarFollowupsPendentesDoLead(lead.id, 1);
          }
          await registrarEventoLead(lead.id, est.cliente_id, 'questionario_abandonado', 'Questionário sem resposta; lead devolvido ao follow-up', { passo_idx: est.passo_idx });
          console.log(`[questionario][abandonado] devolvido ao follow-up -> lead ${lead.id}`);
        }
      } catch (e) {
        console.error('[questionario][parado] erro no estado', est.id, e.message);
      }
    }
  } catch (e) {
    console.error('[questionario][parados] erro:', e.message);
  }
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
        SELECT c.id, c.cliente_id, c.nome, c.gatilho, c.verba_diaria, c.investimento_tipo, c.investimento_valor, c.template_id, c.ativo, c.questionario_ativo, c.questionario_template_id, c.criado_em, c.atualizado_em,
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
        GROUP BY c.id, c.cliente_id, c.nome, c.gatilho, c.verba_diaria, c.investimento_tipo, c.investimento_valor, c.template_id, c.ativo, c.questionario_ativo, c.questionario_template_id, c.criado_em, c.atualizado_em, c.qtd_mesmo_gatilho, t.nome
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
    const { nome, gatilho, verba_diaria, investimento_tipo, investimento_valor, template_id, questionario_ativo, questionario_template_id } = req.body || {};
    if (!nome) return res.status(400).json({ error: 'Nome da campanha é obrigatório.' });
    const gatilhoFinal = gatilho ? String(gatilho).trim() : null;
    if (!gatilhoFinal) return res.status(400).json({ error: 'Frase-gatilho da campanha é obrigatória para atribuição confiável.' });
    const investimentoTipo = ['diario','total'].includes(String(investimento_tipo || '').toLowerCase()) ? String(investimento_tipo).toLowerCase() : 'diario';
    const investimentoValor = parseMoedaParaNumero(investimento_valor !== undefined ? investimento_valor : verba_diaria);
    // A partir da v2.1.3 permitimos o mesmo gatilho em mais de uma campanha.
    // Observação: quando isso acontece, a atribuição exata por campanha fica compartilhada pelo gatilho.
    const templateDbId = await resolverTemplateCampanha(req.params.id, template_id);
    const questTplId = (questionario_template_id !== undefined && questionario_template_id !== null && String(questionario_template_id) !== '') ? parseInt(questionario_template_id, 10) : null;
    const r = await query(
      `INSERT INTO movatak_campanhas (cliente_id, nome, gatilho, verba_diaria, investimento_tipo, investimento_valor, template_id, questionario_ativo, questionario_template_id, ativo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true) RETURNING *`,
      [req.params.id, String(nome).trim(), gatilhoFinal, investimentoValor, investimentoTipo, investimentoValor, templateDbId, typeof questionario_ativo === 'boolean' ? questionario_ativo : true, questTplId]
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
    const { nome, gatilho, verba_diaria, investimento_tipo, investimento_valor, template_id, ativo, questionario_ativo, questionario_template_id } = req.body || {};
    const investimentoValor = investimento_valor !== undefined ? parseMoedaParaNumero(investimento_valor) : (verba_diaria !== undefined ? parseMoedaParaNumero(verba_diaria) : null);
    const investimentoTipo = investimento_tipo === undefined ? null : (['diario','total'].includes(String(investimento_tipo).toLowerCase()) ? String(investimento_tipo).toLowerCase() : 'diario');
    const templateDbId = template_id === undefined ? undefined : await resolverTemplateCampanha(null, template_id);
    const questTplProvided = questionario_template_id !== undefined;
    const questTplId = questTplProvided ? ((questionario_template_id === null || String(questionario_template_id) === '') ? null : parseInt(questionario_template_id, 10)) : null;
    const r = await query(
      `UPDATE movatak_campanhas
          SET nome = COALESCE($1, nome),
              gatilho = CASE WHEN $2::text IS NULL THEN gatilho ELSE $2 END,
              verba_diaria = CASE WHEN $3::text IS NULL THEN verba_diaria ELSE $3::numeric END,
              investimento_valor = CASE WHEN $3::text IS NULL THEN investimento_valor ELSE $3::numeric END,
              investimento_tipo = COALESCE($4, investimento_tipo),
              template_id = CASE WHEN $5::text IS NULL THEN template_id ELSE $5::int END,
              ativo = COALESCE($6, ativo),
              questionario_ativo = COALESCE($8, questionario_ativo),
              questionario_template_id = CASE WHEN $9::boolean THEN $10::int ELSE questionario_template_id END,
              atualizado_em = NOW()
        WHERE id = $7 RETURNING *`,
      [nome ? String(nome).trim() : null, gatilho === undefined ? null : String(gatilho || '').trim(), investimentoValor, investimentoTipo, template_id === undefined ? null : templateDbId, typeof ativo === 'boolean' ? ativo : null, req.params.id, typeof questionario_ativo === 'boolean' ? questionario_ativo : null, questTplProvided, questTplId]
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
      WHERE cliente_id = $1 AND COALESCE(ativo, true) = true
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

app.get('/movatak/admin/clientes/:id/template-conteudo', authMovatak, async (req, res) => {
  try {
    await garantirEstruturaCampanhasTemplates();
    const templateId = String(req.query.template || '').trim();
    if (!templateId) return res.status(400).json({ error: 'Informe o template.' });
    let t = null;

    if (templateId.startsWith('custom:')) {
      const templateDbId = templateId.replace('custom:', '').replace(/\D/g, '');
      const r = await query(
        `SELECT nome, trigger_msg, followup_v2, boas_vindas_msg, comandos
           FROM movatak_followup_templates
          WHERE id = $1 AND cliente_id = $2 AND ativo = true`,
        [templateDbId, req.params.id]
      );
      if (!r.rows.length) return res.status(404).json({ error: 'Template personalizado não encontrado.' });
      const row = r.rows[0];
      t = {
        nome: row.nome,
        trigger_msg: row.trigger_msg || '',
        followup_v2: row.followup_v2 || {},
        boas_vindas_msg: row.boas_vindas_msg || '',
        comandos: row.comandos || {}
      };
    } else {
      const base = TEMPLATES_FOLLOWUP[templateId];
      if (!base) return res.status(404).json({ error: 'Template não encontrado.' });
      t = {
        nome: base.nome,
        trigger_msg: base.trigger_msg || '',
        followup_v2: base.followup_v2 || {},
        boas_vindas_msg: base.boas_vindas_msg || '',
        comandos: base.comandos || {}
      };
    }
    res.json(t);
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    await query(`UPDATE movatak_leads SET etapa = 'cliente', convertido_em = NOW(), atualizado_em = NOW() WHERE id = $1`, [req.params.id]);
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
// ============================================================
// API — Planos/Pacotes por cliente (usados na recomendação por pontuação)
// ============================================================
app.get('/movatak/admin/clientes/:id/planos', authMovatak, async (req, res) => {
  try {
    await garantirEstruturaPlanos();
    const r = await query(
      `SELECT p.id, p.nome, p.valor, p.nota_minima,
              COALESCE(array_agg(pt.template_id) FILTER (WHERE pt.template_id IS NOT NULL), '{}') AS template_ids
         FROM movatak_planos p
         LEFT JOIN movatak_plano_templates pt ON pt.plano_id = p.id
        WHERE p.cliente_id = $1
        GROUP BY p.id, p.nome, p.valor, p.nota_minima
        ORDER BY p.nota_minima ASC, p.valor ASC NULLS LAST, p.id ASC`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/clientes/:id/planos', authMovatak, async (req, res) => {
  try {
    await garantirEstruturaPlanos();
    const { nome, valor, nota_minima } = req.body || {};
    if (!nome || !String(nome).trim()) return res.status(400).json({ error: 'Informe o nome do plano.' });
    const r = await query(
      'INSERT INTO movatak_planos (cliente_id, nome, valor, nota_minima) VALUES ($1, $2, $3, $4) RETURNING id, nome, valor, nota_minima',
      [req.params.id, String(nome).trim(), (valor !== '' && valor != null) ? parseMoedaParaNumero(valor) : null, parseInt(nota_minima, 10) || 0]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/admin/planos/:id', authMovatak, async (req, res) => {
  try {
    await garantirEstruturaPlanos();
    const { nome, valor, nota_minima, template_ids } = req.body || {};
    await query(
      `UPDATE movatak_planos
          SET nome = COALESCE($1, nome),
              valor = CASE WHEN $2::text IS NULL THEN valor ELSE $2::numeric END,
              nota_minima = COALESCE($3, nota_minima)
        WHERE id = $4`,
      [
        nome ? String(nome).trim() : null,
        (valor !== undefined && valor !== '' && valor !== null) ? parseMoedaParaNumero(valor) : null,
        (nota_minima !== undefined && nota_minima !== '') ? (parseInt(nota_minima, 10) || 0) : null,
        req.params.id
      ]
    );
    // Atualiza os vínculos de template, se enviados (lista completa = substitui tudo).
    if (Array.isArray(template_ids)) {
      await query('DELETE FROM movatak_plano_templates WHERE plano_id = $1', [req.params.id]);
      for (const tid of template_ids) {
        const t = parseInt(tid, 10);
        if (Number.isFinite(t)) {
          await query('INSERT INTO movatak_plano_templates (plano_id, template_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, t]).catch(() => null);
        }
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/movatak/admin/planos/:id', authMovatak, async (req, res) => {
  try {
    await garantirEstruturaPlanos();
    await query('DELETE FROM movatak_plano_templates WHERE plano_id = $1', [req.params.id]).catch(() => null);
    await query('DELETE FROM movatak_planos WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// API — Questionário consultivo (config por cliente + cobertura CEP)
// ============================================================
app.post('/movatak/admin/upload-imagem', authMovatak, async (req, res) => {
  try {
    const dataUrl = (req.body && req.body.dataUrl) || '';
    const m = /^data:((?:image\/(?:png|jpe?g|webp))|(?:video\/(?:mp4|webm|quicktime)));base64,(.+)$/i.exec(dataUrl);
    if (!m) return res.status(400).json({ error: 'Arquivo inválido. Envie imagem (PNG, JPG, WEBP) ou vídeo (MP4, WEBM, MOV).' });
    const contentType = m[1].toLowerCase();
    const ehVideo = contentType.startsWith('video/');
    const extMap = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };
    const ext = extMap[contentType] || (ehVideo ? 'mp4' : 'jpg');
    const buffer = Buffer.from(m[2], 'base64');
    const limite = ehVideo ? 20 * 1024 * 1024 : 8 * 1024 * 1024;
    if (buffer.length > limite) {
      return res.status(413).json({ error: ehVideo ? 'Vídeo muito grande (máx 20MB).' : 'Imagem muito grande (máx 8MB).' });
    }
    const url = await uploadSupabase(buffer, contentType, ext);
    res.json({ ok: true, url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/admin/clientes/:id/questionario', authMovatak, async (req, res) => {
  try {
    await garantirEstruturaQuestionario();
    const r = await query(
      `SELECT questionario_ativo, questionario_intro, questionario_final,
              questionario_intro_imagem, questionario_final_imagem,
              questionario_passos, questionario_recomendacao,
              questionario_comando_parar, questionario_comando_ativar,
              acao_arquivar_ao_final, acao_marcar_nao_lido
         FROM movatak_clientes WHERE id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const rp = await query('SELECT id, nome, valor, nota_minima FROM movatak_planos WHERE cliente_id = $1 ORDER BY nota_minima ASC, valor ASC NULLS LAST, id ASC', [req.params.id]);
    const cob = await query('SELECT COUNT(*)::int AS total FROM movatak_cobertura_cep WHERE cliente_id = $1', [req.params.id]);
    res.json({
      ativo: !!r.rows[0].questionario_ativo,
      intro: r.rows[0].questionario_intro || '',
      final: r.rows[0].questionario_final || '',
      intro_imagem: r.rows[0].questionario_intro_imagem || '',
      final_imagem: r.rows[0].questionario_final_imagem || '',
      passos: r.rows[0].questionario_passos || [],
      recomendacao: r.rows[0].questionario_recomendacao || [],
      comando_parar: r.rows[0].questionario_comando_parar || '',
      comando_ativar: r.rows[0].questionario_comando_ativar || '',
      planos: rp.rows,
      cobertura_total: cob.rows[0].total,
      acao_arquivar_ao_final: !!r.rows[0].acao_arquivar_ao_final,
      acao_marcar_nao_lido: !!r.rows[0].acao_marcar_nao_lido
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/admin/clientes/:id/questionario', authMovatak, async (req, res) => {
  try {
    await garantirEstruturaQuestionario();
    const { ativo, intro, final, intro_imagem, final_imagem, passos, recomendacao, comando_parar, comando_ativar, acao_arquivar_ao_final, acao_marcar_nao_lido } = req.body || {};
    await query(
      `UPDATE movatak_clientes
          SET questionario_ativo = COALESCE($1, questionario_ativo),
              questionario_intro = $2,
              questionario_final = $3,
              questionario_intro_imagem = $4,
              questionario_final_imagem = $5,
              questionario_passos = $6::jsonb,
              questionario_recomendacao = $7::jsonb,
              acao_arquivar_ao_final = COALESCE($8, acao_arquivar_ao_final),
              acao_marcar_nao_lido = COALESCE($9, acao_marcar_nao_lido),
              questionario_comando_parar = $10,
              questionario_comando_ativar = $11
        WHERE id = $12`,
      [
        typeof ativo === 'boolean' ? ativo : null,
        intro || null,
        final || null,
        intro_imagem || null,
        final_imagem || null,
        JSON.stringify(Array.isArray(passos) ? passos : []),
        JSON.stringify(Array.isArray(recomendacao) ? recomendacao : []),
        typeof acao_arquivar_ao_final === 'boolean' ? acao_arquivar_ao_final : null,
        typeof acao_marcar_nao_lido === 'boolean' ? acao_marcar_nao_lido : null,
        (typeof comando_parar === 'string' && comando_parar.trim()) ? comando_parar.trim() : null,
        (typeof comando_ativar === 'string' && comando_ativar.trim()) ? comando_ativar.trim() : null,
        req.params.id
      ]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ============================================================
// API — Templates de autoatendimento (questionário) por campanha
// ============================================================
app.get('/movatak/admin/clientes/:id/questionario-templates', authMovatak, async (req, res) => {
  try {
    await garantirEstruturaQuestionario();
    const r = await query(
      `SELECT id, nome, criado_em, atualizado_em,
              COALESCE(jsonb_array_length(passos), 0) AS qtd_passos
         FROM movatak_questionario_templates
        WHERE cliente_id = $1 AND ativo = true
        ORDER BY criado_em DESC`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/admin/questionario-templates/:tid', authMovatak, async (req, res) => {
  try {
    await garantirEstruturaQuestionario();
    const r = await query(`SELECT * FROM movatak_questionario_templates WHERE id = $1`, [req.params.tid]);
    if (!r.rows.length) return res.status(404).json({ error: 'Template de questionário não encontrado.' });
    const t = r.rows[0];
    res.json({
      id: t.id,
      nome: t.nome,
      intro: t.intro || '',
      final: t.final || '',
      intro_imagem: t.intro_imagem || '',
      final_imagem: t.final_imagem || '',
      passos: t.passos || [],
      recomendacao: t.recomendacao || [],
      comando_parar: t.comando_parar || '',
      comando_ativar: t.comando_ativar || ''
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/clientes/:id/questionario-templates', authMovatak, async (req, res) => {
  try {
    await garantirEstruturaQuestionario();
    const { nome, intro, final, intro_imagem, final_imagem, passos, recomendacao, comando_parar, comando_ativar } = req.body || {};
    if (!nome || !String(nome).trim()) return res.status(400).json({ error: 'Informe o nome do template de autoatendimento.' });
    const r = await query(
      `INSERT INTO movatak_questionario_templates
         (cliente_id, nome, intro, final, intro_imagem, final_imagem, passos, recomendacao, comando_parar, comando_ativar)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10) RETURNING id`,
      [
        req.params.id, String(nome).trim(), intro || null, final || null, intro_imagem || null, final_imagem || null,
        JSON.stringify(Array.isArray(passos) ? passos : []),
        JSON.stringify(Array.isArray(recomendacao) ? recomendacao : []),
        (typeof comando_parar === 'string' && comando_parar.trim()) ? comando_parar.trim() : null,
        (typeof comando_ativar === 'string' && comando_ativar.trim()) ? comando_ativar.trim() : null
      ]
    );
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/admin/questionario-templates/:tid', authMovatak, async (req, res) => {
  try {
    await garantirEstruturaQuestionario();
    const { nome, intro, final, intro_imagem, final_imagem, passos, recomendacao, comando_parar, comando_ativar } = req.body || {};
    const r = await query(
      `UPDATE movatak_questionario_templates
          SET nome = COALESCE($1, nome),
              intro = $2, final = $3, intro_imagem = $4, final_imagem = $5,
              passos = $6::jsonb, recomendacao = $7::jsonb,
              comando_parar = $8, comando_ativar = $9,
              atualizado_em = NOW()
        WHERE id = $10 RETURNING id`,
      [
        nome ? String(nome).trim() : null, intro || null, final || null, intro_imagem || null, final_imagem || null,
        JSON.stringify(Array.isArray(passos) ? passos : []),
        JSON.stringify(Array.isArray(recomendacao) ? recomendacao : []),
        (typeof comando_parar === 'string' && comando_parar.trim()) ? comando_parar.trim() : null,
        (typeof comando_ativar === 'string' && comando_ativar.trim()) ? comando_ativar.trim() : null,
        req.params.tid
      ]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Template de questionário não encontrado.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/movatak/admin/questionario-templates/:tid', authMovatak, async (req, res) => {
  try {
    await garantirEstruturaQuestionario();
    // Desvincula das campanhas que o usavam (elas voltam ao questionário do cliente).
    await query(`UPDATE movatak_campanhas SET questionario_template_id = NULL WHERE questionario_template_id = $1`, [req.params.tid]).catch(() => null);
    await query(`UPDATE movatak_questionario_templates SET ativo = false, atualizado_em = NOW() WHERE id = $1`, [req.params.tid]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// API — Mensagens Rápidas (enviadas manualmente do Kanban)
// ============================================================
async function garantirEstruturaConversas() {
  await query(`CREATE TABLE IF NOT EXISTS movatak_conversas (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER NOT NULL,
    cliente_id INTEGER NOT NULL,
    direcao TEXT NOT NULL CHECK (direcao IN ('entrada','saida')),
    conteudo TEXT,
    midia_url TEXT,
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`).catch(() => null);
  await query(`CREATE INDEX IF NOT EXISTS idx_conversas_lead ON movatak_conversas(lead_id, criado_em DESC)`).catch(() => null);
}

async function registrarConversa(leadId, clienteId, direcao, conteudo, midiaUrl) {
  if (!leadId || !clienteId) return;
  await garantirEstruturaConversas();
  await query(
    `INSERT INTO movatak_conversas (lead_id, cliente_id, direcao, conteudo, midia_url) VALUES ($1,$2,$3,$4,$5)`,
    [leadId, clienteId, direcao, conteudo || null, midiaUrl || null]
  ).catch(e => console.error('[conversa] erro ao registrar:', e.message));
}

async function garantirEstruturaMensagensRapidas() {
  await query(`CREATE TABLE IF NOT EXISTS movatak_mensagens_rapidas (
    id SERIAL PRIMARY KEY,
    cliente_id INTEGER NOT NULL,
    titulo TEXT NOT NULL,
    texto TEXT NOT NULL,
    midia_url TEXT,
    ordem INTEGER DEFAULT 0,
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`).catch(() => null);
  await query(`ALTER TABLE movatak_mensagens_rapidas ADD COLUMN IF NOT EXISTS midia_url TEXT`).catch(() => null);
  await query(`ALTER TABLE movatak_mensagens_rapidas ADD COLUMN IF NOT EXISTS vezes_usado INTEGER DEFAULT 0`).catch(() => null);
}

app.get('/movatak/admin/clientes/:id/mensagens-rapidas', authMovatak, async (req, res) => {
  try {
    await garantirEstruturaMensagensRapidas();
    const r = await query('SELECT id, titulo, texto, midia_url, vezes_usado, ordem FROM movatak_mensagens_rapidas WHERE cliente_id=$1 ORDER BY vezes_usado DESC, ordem ASC, id ASC', [req.params.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/clientes/:id/mensagens-rapidas', authMovatak, async (req, res) => {
  try {
    await garantirEstruturaMensagensRapidas();
    const { titulo, texto, midia_url } = req.body || {};
    if (!titulo || !texto) return res.status(400).json({ error: 'Título e texto obrigatórios.' });
    const r = await query('INSERT INTO movatak_mensagens_rapidas (cliente_id, titulo, texto, midia_url) VALUES ($1,$2,$3,$4) RETURNING id, titulo, texto, midia_url, ordem', [req.params.id, titulo.trim(), texto.trim(), midia_url || null]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/admin/mensagens-rapidas/:id', authMovatak, async (req, res) => {
  try {
    const { titulo, texto, midia_url } = req.body || {};
    await query('UPDATE movatak_mensagens_rapidas SET titulo=COALESCE($1,titulo), texto=COALESCE($2,texto), midia_url=CASE WHEN $3::text IS NULL THEN midia_url ELSE $3 END WHERE id=$4', [titulo||null, texto||null, midia_url !== undefined ? (midia_url || null) : null, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/movatak/admin/mensagens-rapidas/:id', authMovatak, async (req, res) => {
  try {
    await query('DELETE FROM movatak_mensagens_rapidas WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/leads/:id/mensagem-rapida', authMovatak, async (req, res) => {
  try {
    const { texto, midia_url } = req.body || {};
    if (!texto && !midia_url) return res.status(400).json({ error: 'Texto ou mídia obrigatório.' });
    const rl = await query('SELECT l.id, l.telefone, l.cliente_id, c.zapi_instance, c.zapi_token, c.zapi_client_token FROM movatak_leads l JOIN movatak_clientes c ON c.id=l.cliente_id WHERE l.id=$1', [req.params.id]);
    if (!rl.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    const row = rl.rows[0];
    if (midia_url) {
      const tipo = tipoMidia(midia_url);
      if (tipo === 'video') {
        await zapiEnviarVideo(row.zapi_instance, row.zapi_token, row.zapi_client_token, row.telefone, midia_url, texto || '');
      } else {
        await zapiEnviarImagem(row.zapi_instance, row.zapi_token, row.zapi_client_token, row.telefone, midia_url, texto || '');
      }
    } else {
      await zapiEnviar(row.zapi_instance, row.zapi_token, row.zapi_client_token, row.telefone, texto);
    }
    registrarConversa(row.id, row.cliente_id, 'saida', texto || '', midia_url || null).catch(() => null);
    await registrarEventoLead(row.id, row.cliente_id, 'mensagem_manual', 'Mensagem rápida enviada pelo kanban', { texto: (texto||'').slice(0, 100), midia: !!midia_url });
    // Incrementa contador de uso se o texto bate com uma mensagem rápida cadastrada
    if (texto) {
      query('UPDATE movatak_mensagens_rapidas SET vezes_usado = COALESCE(vezes_usado,0)+1 WHERE cliente_id=$1 AND texto=$2', [row.cliente_id, texto]).catch(() => null);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Alias usado pelo Kanban. Mantém compatibilidade com telas que chamam /mensagem-kanban
// em vez de /mensagem-rapida.
app.post('/movatak/admin/leads/:id/mensagem-kanban', authMovatak, async (req, res) => {
  try {
    const { texto, midia_url } = req.body || {};
    if (!texto && !midia_url) return res.status(400).json({ error: 'Texto ou mídia obrigatório.' });
    const rl = await query('SELECT l.id, l.telefone, l.cliente_id, c.zapi_instance, c.zapi_token, c.zapi_client_token FROM movatak_leads l JOIN movatak_clientes c ON c.id=l.cliente_id WHERE l.id=$1', [req.params.id]);
    if (!rl.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    const row = rl.rows[0];

    if (midia_url) {
      const tipo = tipoMidia(midia_url);
      if (tipo === 'video') {
        await zapiEnviarVideo(row.zapi_instance, row.zapi_token, row.zapi_client_token, row.telefone, midia_url, texto || '');
      } else {
        await zapiEnviarImagem(row.zapi_instance, row.zapi_token, row.zapi_client_token, row.telefone, midia_url, texto || '');
      }
    } else {
      await zapiEnviar(row.zapi_instance, row.zapi_token, row.zapi_client_token, row.telefone, texto);
    }

    await registrarConversa(row.id, row.cliente_id, 'saida', texto || '', midia_url || null).catch(() => null);
    await registrarEventoLead(row.id, row.cliente_id, 'mensagem_manual_kanban', 'Mensagem enviada manualmente pelo Kanban', { texto: (texto||'').slice(0, 100), midia: !!midia_url });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


app.post('/movatak/admin/leads/:id/reativar-followup', authMovatak, async (req, res) => {
  try {
    const rl = await query('SELECT id, cliente_id, etapa FROM movatak_leads WHERE id=$1', [req.params.id]);
    if (!rl.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    const lead = rl.rows[0];
    await query(`UPDATE movatak_leads SET etapa='followup', atualizado_em=NOW() WHERE id=$1`, [lead.id]);
    await agendarFollowupV2(lead.id, lead.cliente_id, 1, true);
    await enviarFollowupsPendentesDoLead(lead.id, 1);
    await registrarEventoLead(lead.id, lead.cliente_id, 'followup_reativado', 'Follow-up reativado manualmente pelo kanban', {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Funil de Atendimento — Kanban de leads + listas/tags WhatsApp
// ============================================================
// Distribui lead para o vendedor com menor número de leads atribuídos.
// Em empate, escolhe aleatoriamente entre os empatados.
async function atribuirVendedorBalanceado(clienteId, leadId) {
  try {
    const vRes = await query(
      `SELECT id FROM movatak_vendedores WHERE cliente_id=$1 AND COALESCE(ativo,true)=true ORDER BY id ASC`,
      [clienteId]
    );
    if (!vRes.rows.length) return null;
    const counts = await query(
      `SELECT vendedor_id, COUNT(*)::int AS cnt
         FROM movatak_leads
        WHERE cliente_id=$1 AND vendedor_id IS NOT NULL
        GROUP BY vendedor_id`,
      [clienteId]
    );
    const countMap = {};
    for (const r of counts.rows) countMap[r.vendedor_id] = r.cnt;
    let minCnt = Infinity;
    for (const v of vRes.rows) {
      const c = countMap[v.id] || 0;
      if (c < minCnt) minCnt = c;
    }
    const candidatos = vRes.rows.filter(v => (countMap[v.id] || 0) === minCnt);
    const escolhido = candidatos[Math.floor(Math.random() * candidatos.length)];
    await query(
      `UPDATE movatak_leads SET vendedor_id=$1, atualizado_em=NOW() WHERE id=$2`,
      [escolhido.id, leadId]
    );
    console.log(`[funil] Lead ${leadId} atribuído ao vendedor ${escolhido.id} (mínimo: ${minCnt} leads)`);
    return escolhido.id;
  } catch (e) {
    console.error('[funil][distribuicao] Erro ao atribuir vendedor:', e.message);
    return null;
  }
}

function slugifyFunil(nome) {
  return String(nome || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || ('etapa_' + Date.now());
}

function etapaSistemaPorSlug(slug) {
  const mapa = {
    novo_contato: 'lead',
    auto_atendimento: 'auto_atendimento',
    aguardando_resposta: 'followup',
    em_negociacao: 'negociacao',
    cliente_fechado: 'cliente',
    perdido: 'descartado'
  };
  return mapa[slug] || slug;
}

function slugFunilPorEtapa(etapa) {
  const mapa = {
    lead: 'novo_contato',
    auto_atendimento: 'auto_atendimento',
    followup: 'aguardando_resposta',
    negociacao: 'em_negociacao',
    cliente: 'cliente_fechado',
    descartado: 'perdido'
  };
  return mapa[etapa] || 'novo_contato';
}

function extrairZapiTagId(payload) {
  if (!payload) return null;
  return payload.id || payload.tagId || payload.tag_id || payload?.data?.id || payload?.data?.tagId || payload?.tag?.id || null;
}

async function garantirEstruturaFunil() {
  await query(`CREATE TABLE IF NOT EXISTS movatak_funil_colunas (
    id SERIAL PRIMARY KEY,
    cliente_id INTEGER NOT NULL,
    nome TEXT NOT NULL,
    slug TEXT NOT NULL,
    ordem INTEGER DEFAULT 0,
    cor TEXT,
    etapa_sistema TEXT,
    sincronizar_whatsapp BOOLEAN DEFAULT true,
    zapi_tag_id TEXT,
    zapi_sync_erro TEXT,
    ativo BOOLEAN DEFAULT true,
    criado_em TIMESTAMPTZ DEFAULT NOW(),
    atualizado_em TIMESTAMPTZ DEFAULT NOW()
  )`).catch(() => null);

  await query(`ALTER TABLE movatak_funil_colunas
    ADD COLUMN IF NOT EXISTS cor TEXT,
    ADD COLUMN IF NOT EXISTS etapa_sistema TEXT,
    ADD COLUMN IF NOT EXISTS sincronizar_whatsapp BOOLEAN DEFAULT true,
    ADD COLUMN IF NOT EXISTS zapi_tag_id TEXT,
    ADD COLUMN IF NOT EXISTS zapi_sync_erro TEXT,
    ADD COLUMN IF NOT EXISTS ativo BOOLEAN DEFAULT true,
    ADD COLUMN IF NOT EXISTS comando TEXT,
    ADD COLUMN IF NOT EXISTS criado_em TIMESTAMPTZ DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMPTZ DEFAULT NOW()`).catch(() => null);

  await query(`ALTER TABLE movatak_clientes ADD COLUMN IF NOT EXISTS acao_arquivar_ao_final BOOLEAN DEFAULT false`).catch(() => null);
  await query(`ALTER TABLE movatak_clientes ADD COLUMN IF NOT EXISTS acao_marcar_nao_lido BOOLEAN DEFAULT false`).catch(() => null);
  await query(`ALTER TABLE movatak_leads
    ADD COLUMN IF NOT EXISTS funil_coluna_id INTEGER`).catch(() => null);

  await query(`ALTER TABLE movatak_leads
    ADD COLUMN IF NOT EXISTS convertido_em TIMESTAMPTZ`).catch(() => null);

  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_movatak_funil_colunas_cliente_slug ON movatak_funil_colunas(cliente_id, slug)`).catch(() => null);
  await query(`CREATE INDEX IF NOT EXISTS idx_movatak_leads_funil_coluna ON movatak_leads(funil_coluna_id)`).catch(() => null);
}

async function garantirFunilPadraoCliente(clienteId) {
  await garantirEstruturaFunil();
  const padrao = [
    { nome: 'Novo contato', slug: 'novo_contato', ordem: 1, etapa: 'lead' },
    { nome: 'Auto Atendimento', slug: 'auto_atendimento', ordem: 2, etapa: 'auto_atendimento' },
    { nome: 'Aguardando resposta', slug: 'aguardando_resposta', ordem: 3, etapa: 'followup' },
    { nome: 'Em negociação', slug: 'em_negociacao', ordem: 4, etapa: 'negociacao' },
    { nome: 'Cliente fechado', slug: 'cliente_fechado', ordem: 5, etapa: 'cliente' },
    { nome: 'Perdido', slug: 'perdido', ordem: 6, etapa: 'descartado' }
  ];
  for (const c of padrao) {
    await query(
      `INSERT INTO movatak_funil_colunas (cliente_id, nome, slug, ordem, etapa_sistema, sincronizar_whatsapp)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (cliente_id, slug) DO NOTHING`,
      [clienteId, c.nome, c.slug, c.ordem, c.etapa]
    ).catch(() => null);
  }
}

async function sincronizarColunaComWhatsapp(colunaId) {
  await garantirEstruturaFunil();
  const r = await query(
    `SELECT fc.*, c.zapi_instance, c.zapi_token, c.zapi_client_token
       FROM movatak_funil_colunas fc
       JOIN movatak_clientes c ON c.id = fc.cliente_id
      WHERE fc.id = $1`,
    [colunaId]
  );
  if (!r.rows.length) throw new Error('Coluna não encontrada.');
  const col = r.rows[0];
  if (col.zapi_tag_id) return col.zapi_tag_id;
  if (!col.zapi_instance || !col.zapi_token || !col.zapi_client_token) {
    throw new Error('Z-API não configurada para este cliente.');
  }
  const payload = await zapiCriarEtiqueta(col.zapi_instance, col.zapi_token, col.zapi_client_token, col.nome);
  const tagId = extrairZapiTagId(payload);
  if (!tagId) throw new Error('A Z-API não retornou o ID da lista/tag criada.');
  await query(`UPDATE movatak_funil_colunas SET zapi_tag_id=$1, zapi_sync_erro=NULL, atualizado_em=NOW() WHERE id=$2`, [String(tagId), colunaId]);
  return String(tagId);
}

async function moverLeadParaFunilSlug(clienteId, leadId, slug) {
  await garantirFunilPadraoCliente(clienteId);
  const col = await query(
    `SELECT id FROM movatak_funil_colunas WHERE cliente_id=$1 AND slug=$2 AND ativo=true LIMIT 1`,
    [clienteId, slug]
  );
  if (!col.rows.length) return;
  await moverLeadParaColunaFunil(leadId, col.rows[0].id, false);
}

async function moverLeadParaColunaFunil(leadId, colunaId, registrar = true) {
  await garantirEstruturaFunil();
  const r = await query(
    `SELECT l.id, l.cliente_id, l.telefone, l.nome, l.funil_coluna_id AS coluna_anterior_id,
            fc.id AS coluna_id, fc.nome AS coluna_nome, fc.slug, fc.etapa_sistema, fc.sincronizar_whatsapp, fc.zapi_tag_id,
            c.zapi_instance, c.zapi_token, c.zapi_client_token
       FROM movatak_leads l
       JOIN movatak_funil_colunas fc ON fc.id = $2 AND fc.cliente_id = l.cliente_id AND fc.ativo = true
       JOIN movatak_clientes c ON c.id = l.cliente_id
      WHERE l.id = $1`,
    [leadId, colunaId]
  );
  if (!r.rows.length) throw new Error('Lead ou coluna não encontrados.');
  const row = r.rows[0];
  let tagId = row.zapi_tag_id;

  if (row.sincronizar_whatsapp && !tagId) {
    try {
      tagId = await sincronizarColunaComWhatsapp(colunaId);
    } catch (e) {
      await query(`UPDATE movatak_funil_colunas SET zapi_sync_erro=$1, atualizado_em=NOW() WHERE id=$2`, [String(e.message || e).slice(0, 500), colunaId]).catch(() => null);
    }
  }

  const etapa = row.etapa_sistema || etapaSistemaPorSlug(row.slug);
  if (etapa === 'cliente') {
    await query(`UPDATE movatak_leads SET funil_coluna_id=$1, etapa=$2, convertido_em=COALESCE(convertido_em, NOW()), atualizado_em=NOW() WHERE id=$3`, [colunaId, etapa, leadId]);
    await query(`UPDATE movatak_followup SET status='pausado' WHERE lead_id=$1 AND status='pendente'`, [leadId]).catch(() => null);
    // Distribuição balanceada: só atribui se ainda não tem vendedor
    const lr = await query(`SELECT vendedor_id FROM movatak_leads WHERE id=$1`, [leadId]);
    if (lr.rows[0] && !lr.rows[0].vendedor_id) {
      await atribuirVendedorBalanceado(row.cliente_id, leadId).catch(() => null);
    }
  } else if (etapa === 'descartado') {
    await query(`UPDATE movatak_leads SET funil_coluna_id=$1, etapa=$2, atualizado_em=NOW() WHERE id=$3`, [colunaId, etapa, leadId]);
    await query(`UPDATE movatak_followup SET status='pausado' WHERE lead_id=$1 AND status='pendente'`, [leadId]).catch(() => null);
  } else {
    await query(`UPDATE movatak_leads SET funil_coluna_id=$1, etapa=$2, atualizado_em=NOW() WHERE id=$3`, [colunaId, etapa, leadId]);
  }

  if (row.sincronizar_whatsapp && tagId && row.zapi_instance && row.zapi_token && row.zapi_client_token && row.telefone) {
    const tagsAntigas = await query(
      `SELECT zapi_tag_id FROM movatak_funil_colunas
        WHERE cliente_id=$1 AND ativo=true AND zapi_tag_id IS NOT NULL AND id <> $2`,
      [row.cliente_id, colunaId]
    ).catch(() => ({ rows: [] }));
    for (const t of tagsAntigas.rows) {
      await zapiRemoverEtiqueta(row.zapi_instance, row.zapi_token, row.zapi_client_token, row.telefone, t.zapi_tag_id);
    }
    await zapiAtribuirEtiqueta(row.zapi_instance, row.zapi_token, row.zapi_client_token, row.telefone, tagId);
  }

  if (registrar) {
    await registrarEventoLead(leadId, row.cliente_id, 'funil_movido', `Lead movido para ${row.coluna_nome}`, { coluna_id: colunaId, coluna_nome: row.coluna_nome, etapa });
  }
  return { ok: true, coluna: { id: colunaId, nome: row.coluna_nome, etapa_sistema: etapa } };
}

app.get('/movatak/admin/clientes/:id/funil', authMovatak, async (req, res) => {
  try {
    const clienteId = parseInt(req.params.id, 10);
    await garantirFunilPadraoCliente(clienteId);
    const colunasRes = await query(
      `SELECT id, nome, slug, ordem, cor, etapa_sistema, sincronizar_whatsapp, zapi_tag_id, zapi_sync_erro, comando
         FROM movatak_funil_colunas
        WHERE cliente_id=$1 AND ativo=true
        ORDER BY ordem ASC, id ASC`,
      [clienteId]
    );
    const colunas = colunasRes.rows.map(c => ({ ...c, leads: [] }));
    const colById = new Map(colunas.map(c => [Number(c.id), c]));
    const colBySlug = new Map(colunas.map(c => [c.slug, c]));

    const leads = await query(
      `SELECT l.id, l.nome, l.telefone, l.etapa, l.funil_coluna_id, l.vendedor_id,
              l.criado_em, l.atualizado_em, l.convertido_em,
              v.nome AS vendedor_nome,
              p.nome AS plano_nome, p.valor AS plano_valor,
              COUNT(f.id) FILTER (WHERE f.status='pendente')::int AS followups_pendentes
         FROM movatak_leads l
         LEFT JOIN movatak_vendedores v ON v.id = l.vendedor_id
         LEFT JOIN movatak_planos p ON p.id = l.plano_id
         LEFT JOIN movatak_followup f ON f.lead_id = l.id
        WHERE l.cliente_id=$1
        GROUP BY l.id, v.nome, p.nome, p.valor
        ORDER BY l.atualizado_em DESC NULLS LAST, l.criado_em DESC
        LIMIT 500`,
      [clienteId]
    );

    for (const lead of leads.rows) {
      let coluna = lead.funil_coluna_id ? colById.get(Number(lead.funil_coluna_id)) : null;
      if (!coluna) coluna = colBySlug.get(slugFunilPorEtapa(lead.etapa));
      if (!coluna) coluna = colunas[0];
      if (coluna) coluna.leads.push(lead);
    }

    // Colunas de vendedores (sempre as últimas — leads atribuídos de qualquer etapa)
    const vRes = await query(
      `SELECT id, nome FROM movatak_vendedores WHERE cliente_id=$1 AND COALESCE(ativo,true)=true ORDER BY nome ASC`,
      [clienteId]
    );
    const colunasVendedores = vRes.rows.map(v => ({
      id: `vendedor_${v.id}`,
      vendedor_id: v.id,
      nome: v.nome,
      leads: leads.rows.filter(l => l.vendedor_id === v.id)
    }));

    res.json({ colunas, colunasVendedores });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/clientes/:id/funil/colunas', authMovatak, async (req, res) => {
  try {
    const clienteId = parseInt(req.params.id, 10);
    await garantirFunilPadraoCliente(clienteId);
    const nome = String((req.body && req.body.nome) || '').trim();
    if (!nome) return res.status(400).json({ error: 'Informe o nome da etapa.' });
    const slugBase = slugifyFunil(nome);
    const ordemR = await query('SELECT COALESCE(MAX(ordem),0)+1 AS ordem FROM movatak_funil_colunas WHERE cliente_id=$1', [clienteId]);
    const etapa = etapaSistemaPorSlug(slugBase);
    const ins = await query(
      `INSERT INTO movatak_funil_colunas (cliente_id, nome, slug, ordem, etapa_sistema, sincronizar_whatsapp)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [clienteId, nome, slugBase, ordemR.rows[0].ordem, etapa, req.body?.sincronizar_whatsapp !== false]
    );
    let col = ins.rows[0];
    if (col.sincronizar_whatsapp) {
      try {
        await sincronizarColunaComWhatsapp(col.id);
        const rr = await query('SELECT * FROM movatak_funil_colunas WHERE id=$1', [col.id]);
        col = rr.rows[0] || col;
      } catch (e) {
        await query(`UPDATE movatak_funil_colunas SET zapi_sync_erro=$1 WHERE id=$2`, [String(e.message || e).slice(0, 500), col.id]).catch(() => null);
        col.zapi_sync_erro = e.message;
      }
    }
    res.json({ ok: true, coluna: col });
  } catch (e) {
    if (String(e.message || '').includes('duplicate')) return res.status(409).json({ error: 'Já existe uma etapa/lista com esse nome.' });
    res.status(500).json({ error: e.message });
  }
});

app.patch('/movatak/admin/funil/colunas/:id', authMovatak, async (req, res) => {
  try {
    await garantirEstruturaFunil();
    const { nome, ordem, ativo, cor, comando } = req.body || {};
    const r = await query(
      `UPDATE movatak_funil_colunas
          SET nome = COALESCE($1, nome),
              ordem = COALESCE($2, ordem),
              ativo = COALESCE($3, ativo),
              cor = CASE WHEN $5::text IS NULL THEN cor ELSE $5 END,
              comando = CASE WHEN $6::text IS NULL THEN comando ELSE NULLIF($6, '') END,
              atualizado_em = NOW()
        WHERE id = $4
        RETURNING *`,
      [nome || null, Number.isFinite(Number(ordem)) ? Number(ordem) : null, typeof ativo === 'boolean' ? ativo : null, req.params.id, cor !== undefined ? (cor || null) : null, comando !== undefined ? String(comando).trim() : null]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Coluna não encontrada.' });
    res.json({ ok: true, coluna: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/movatak/admin/funil/colunas/:id', authMovatak, async (req, res) => {
  try {
    await garantirEstruturaFunil();
    const colId = parseInt(req.params.id, 10);
    if (!Number.isFinite(colId)) return res.status(400).json({ error: 'ID inválido.' });

    const cr = await query('SELECT id, cliente_id, nome, etapa_sistema FROM movatak_funil_colunas WHERE id=$1', [colId]);
    if (!cr.rows.length) return res.status(404).json({ error: 'Coluna não encontrada.' });
    const col = cr.rows[0];

    // Colunas de sistema não podem ser excluídas (são usadas pelo motor do funil).
    const slugsSistema = ['lead', 'auto_atendimento', 'followup', 'negociacao', 'cliente', 'descartado'];
    if (col.etapa_sistema && slugsSistema.includes(col.etapa_sistema)) {
      return res.status(400).json({ error: 'Esta é uma etapa padrão do sistema e não pode ser excluída.' });
    }

    // Realoca os leads desta coluna para a etapa "Novo contato" do cliente.
    const destino = await query(
      `SELECT id FROM movatak_funil_colunas
        WHERE cliente_id=$1 AND ativo=true AND slug='novo_contato' LIMIT 1`,
      [col.cliente_id]
    );
    const destinoId = destino.rows[0] ? destino.rows[0].id : null;
    if (destinoId) {
      await query(
        `UPDATE movatak_leads SET funil_coluna_id=$1, etapa='lead', atualizado_em=NOW()
          WHERE funil_coluna_id=$2`,
        [destinoId, colId]
      ).catch(() => null);
    } else {
      await query(`UPDATE movatak_leads SET funil_coluna_id=NULL, atualizado_em=NOW() WHERE funil_coluna_id=$1`, [colId]).catch(() => null);
    }

    await query('UPDATE movatak_funil_colunas SET ativo=false, atualizado_em=NOW() WHERE id=$1', [colId]);
    res.json({ ok: true, leads_realocados: destinoId ? true : false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/clientes/:id/funil/colunas/reordenar', authMovatak, async (req, res) => {
  try {
    await garantirEstruturaFunil();
    const clienteId = parseInt(req.params.id, 10);
    const ordem = Array.isArray(req.body?.ordem) ? req.body.ordem : null;
    if (!ordem || !ordem.length) return res.status(400).json({ error: 'Envie ordem: [ids...] na sequência desejada.' });
    let pos = 1;
    for (const colId of ordem) {
      const id = parseInt(colId, 10);
      if (!Number.isFinite(id)) continue;
      await query(
        `UPDATE movatak_funil_colunas SET ordem=$1, atualizado_em=NOW() WHERE id=$2 AND cliente_id=$3`,
        [pos, id, clienteId]
      ).catch(() => null);
      pos++;
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/funil/colunas/:id/sincronizar-whatsapp', authMovatak, async (req, res) => {
  try {
    const tagId = await sincronizarColunaComWhatsapp(req.params.id);
    res.json({ ok: true, zapi_tag_id: tagId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/admin/leads/:id/vendedor', authMovatak, async (req, res) => {
  try {
    const { vendedor_id } = req.body || {};
    await query(
      `UPDATE movatak_leads SET vendedor_id=$1, atualizado_em=NOW() WHERE id=$2`,
      [vendedor_id || null, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


app.post('/movatak/admin/leads/:id/mensagem-kanban', authMovatak, async (req, res) => {
  try {
    const leadId = parseInt(req.params.id, 10);
    const mensagem = String((req.body && req.body.mensagem) || '').trim();
    if (!leadId) return res.status(400).json({ error: 'Lead inválido.' });
    if (!mensagem) return res.status(400).json({ error: 'Digite a mensagem.' });
    if (mensagem.length > 2000) return res.status(400).json({ error: 'Mensagem muito longa. Limite: 2000 caracteres.' });

    const r = await query(
      `SELECT l.id, l.cliente_id, l.nome, l.telefone, l.vendedor_id,
              c.zapi_instance, c.zapi_token, c.zapi_client_token
         FROM movatak_leads l
         JOIN movatak_clientes c ON c.id = l.cliente_id
        WHERE l.id = $1 AND c.ativo = true`,
      [leadId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    const lead = r.rows[0];
    if (!lead.telefone) return res.status(400).json({ error: 'Lead sem telefone cadastrado.' });
    if (!lead.zapi_instance || !lead.zapi_token || !lead.zapi_client_token) {
      return res.status(400).json({ error: 'Z-API não configurada para este cliente.' });
    }

    await zapiEnviar(lead.zapi_instance, lead.zapi_token, lead.zapi_client_token, lead.telefone, mensagem);
    await registrarEventoLead(
      lead.id,
      lead.cliente_id,
      'mensagem_manual_kanban',
      'Mensagem manual enviada pelo Funil de Atendimento',
      { origem: 'funil_kanban', vendedor_id: lead.vendedor_id || null, tamanho: mensagem.length }
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[funil][mensagem-kanban]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.patch('/movatak/admin/leads/:id/funil', authMovatak, async (req, res) => {
  try {
    const colunaId = parseInt(req.body?.coluna_id, 10);
    if (!colunaId) return res.status(400).json({ error: 'Informe a coluna de destino.' });
    const result = await moverLeadParaColunaFunil(req.params.id, colunaId, true);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/admin/clientes/:id/cobertura', authMovatak, async (req, res) => {
  try {
    await garantirEstruturaQuestionario();
    const r = await query('SELECT cep FROM movatak_cobertura_cep WHERE cliente_id = $1 ORDER BY cep ASC', [req.params.id]);
    res.json({ total: r.rows.length, ceps: r.rows.map(x => x.cep) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/clientes/:id/cobertura', authMovatak, async (req, res) => {
  try {
    await garantirEstruturaQuestionario();
    const modo = (req.body && req.body.modo) || 'substituir';
    const lista = String((req.body && req.body.ceps) || '')
      .split(/[\n,;\s]+/)
      .map(s => s.replace(/\D/g, ''))
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i);
    if (modo === 'substituir') {
      await query('DELETE FROM movatak_cobertura_cep WHERE cliente_id = $1', [req.params.id]);
    }
    let inseridos = 0;
    for (const cep of lista) {
      const r = await query(
        `INSERT INTO movatak_cobertura_cep (cliente_id, cep) VALUES ($1, $2)
         ON CONFLICT (cliente_id, cep) DO NOTHING`,
        [req.params.id, cep]
      );
      inseridos += r.rowCount || 0;
    }
    const tot = await query('SELECT COUNT(*)::int AS total FROM movatak_cobertura_cep WHERE cliente_id = $1', [req.params.id]);
    res.json({ ok: true, inseridos, total: tot.rows[0].total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/movatak/admin/clientes/:id/cobertura', authMovatak, async (req, res) => {
  try {
    await garantirEstruturaQuestionario();
    await query('DELETE FROM movatak_cobertura_cep WHERE cliente_id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Reset de lead para testes: apaga o lead e tudo ligado a ele, por telefone.
app.post('/movatak/admin/reset-lead', authMovatak, async (req, res) => {
  try {
    const tel = String((req.body && req.body.telefone) || '').replace(/\D/g, '');
    if (tel.length < 8) return res.status(400).json({ error: 'Telefone inválido.' });
    const sel = `SELECT id FROM movatak_leads WHERE regexp_replace(telefone, '[^0-9]', '', 'g') = $1`;
    const found = await query(sel, [tel]);
    const removidos = found.rows.length;
    if (removidos) {
      await query(`DELETE FROM movatak_followup WHERE lead_id IN (${sel})`, [tel]).catch(() => null);
      await query(`DELETE FROM movatak_mensagens WHERE lead_id IN (${sel})`, [tel]).catch(() => null);
      await query(`DELETE FROM movatak_lead_eventos WHERE lead_id IN (${sel})`, [tel]).catch(() => null);
      await query(`DELETE FROM movatak_etiqueta_log WHERE lead_id IN (${sel})`, [tel]).catch(() => null);
      await query(`DELETE FROM movatak_questionario_estado WHERE lead_id IN (${sel})`, [tel]).catch(() => null);
      await query(`DELETE FROM movatak_questionario_estado WHERE regexp_replace(telefone, '[^0-9]', '', 'g') = $1`, [tel]).catch(() => null);
      await query(`DELETE FROM movatak_leads WHERE regexp_replace(telefone, '[^0-9]', '', 'g') = $1`, [tel]);
    }
    res.json({ ok: true, removidos });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
  garantirEstruturaQuestionario().catch(e => console.error('[questionario] schema:', e.message));
  garantirEstruturaPlanos().catch(e => console.error('[planos] schema:', e.message));
  garantirEstruturaFunil().catch(e => console.error('[funil] schema:', e.message));
});
