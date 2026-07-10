'use strict';

const config = require('./src/config');
const {
  MOVATAK_VERSION,
  R2_BUCKET, R2_PRONTO, r2Client, r2Upload, r2Download, r2Delete, R2_ListBucketsCommand,
  MOVATAK_DEBUG, logDebug,
  MOVATAK_REENTRADA_FU1_HORAS, MOVATAK_MAX_AUTO_MSG_DIA, MOVATAK_QUEST_LEMBRETE_HORAS, MOVATAK_QUEST_MAX_LEMBRETES,
  normalizarPermissoes, hashSenha, gerarToken, CRON_ATIVO
} = config;

const db = require('./src/db');
const {
  query,
  garantirColunasClientesPortal, garantirColunasVendedoresPortal,
  withPgAdvisoryLock,
  garantirEstruturaCampanhasTemplates, garantirEstruturaQuestionario, garantirEstruturaPlanos,
  garantirEstruturaConversas, garantirEstruturaMensagensRapidas, garantirEstruturaFunil,
  garantirEstruturaAgenda, garantirEstruturaCaptacao
} = db;

const {
  inicializarRealtime,
  emitirMensagemLead, emitirMensagemApagada, emitirStatusMensagem, emitirLeadFlags
} = require('./src/realtime');

const {
  ZAPI_BASE,
  extrairIdMensagemZapi, montarPayloadRespostaZapi, zapiPostComPossivelResposta,
  zapiEnviar, getZapiCreds, zapiStatus, zapiPhoneExiste, zapiRestart, zapiQrImagem,
  zapiEnviarImagem, zapiEnviarVideo, zapiEnviarAudio, zapiApagarMensagem, zapiEtiquetar,
  zapiArquivar, zapiMarcarNaoLido, zapiBuscarFoto, zapiHeaders, zapiUrl, zapiPost, zapiGet,
  zapiEnviarDocumento, zapiEnviarLocalizacao, zapiEnviarLink, zapiEnviarContato,
  zapiReagirMensagem, zapiEncaminharMensagem, zapiLerMensagem, zapiEditarTexto,
  zapiModificarChat, zapiListarChats, ZAPI_ADVANCED_ENDPOINTS, limparPayloadAvancado,
  MOVATAK_ADMIN_WA, zapiCriarEtiqueta, zapiAtribuirEtiqueta, zapiRemoverEtiqueta
} = require('./src/zapi');

const {
  registrarConversa, registrarEventoLead, pararAtendimentoLead, limparPedidoAtendente
} = require('./src/leads');

const questionario = require('./src/questionario');
const {
  reiniciarQuestionarioLead, enviarMsgQuestionario, cepTemCobertura, montarTextoPergunta,
  interpretarResposta, resolverSaltoQuestionario, calcularPontuacao, calcularRecomendacao,
  avancarQuestionario, iniciarQuestionarioPorTemplate, resolverQuestionarioPorTemplateId,
  resolverQuestionarioDoLead, iniciarQuestionario, processarRespostaQuestionario,
  finalizarQuestionario, processarQuestionariosParados
} = questionario;

const ia = require('./src/ia');
const {
  localizarCampanhaPorIA, chamarHaiku, gerarRespostaIALead, enviarComPausasHumanas,
  assuntoExigeHumano, respostaIAViolaTravas, transferirIAParaHumano, iaResponderAutomatico
} = ia;

const util = require('./src/util');
const {
  variantesTelefone, extrairDigitosTelefone, telefonesEquivalentes, ehGrupoOuCanal,
  tipoMidia, normalizarCep, sleep, uploadSupabase, registrarErroZapi, enviarAlerta
} = util;

const followups = require('./src/followups');
const {
  followupDataDaLinha, agendarFollowupV2, enviarFollowupsPendentesDoLead,
  migrarFU1ParaFU2, finalizarFollowupsEsgotados
} = followups;

const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const crypto = require('crypto');
const http = require('http');

const path = require('path');

const app = express();
app.use(express.json({ limit: '30mb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-movatak-secret, x-app-token, x-vendedor-token');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// Socket.io — tela de atendimento em tempo real (ver src/realtime.js).
// Mantém app.listen funcionando igual antes: criamos um servidor HTTP
// explícito só para poder amarrar o socket nele, sem mudar nenhuma rota.
// ============================================================
const httpServer = http.createServer(app);
inicializarRealtime(httpServer);

// Injeta no motor de followups as deps que ainda vivem no index.js
// (ausencia, funil e anti-spam). Function declarations sao hoisted.
followups.init({
  ehGrupoOuCanal, clienteRowEmAusencia, moverLeadParaColunaFunil,
  podeEnviarMensagemAutomatica, registrarErroZapi
});

// Injeta no motor de questionario as deps que ainda vivem no index.js
// (followups/3d, funil/vendedor e helpers compartilhados). Function
// declarations sao hoisted, entao ja estao definidas aqui.
questionario.init({
  agendarFollowupV2, enviarFollowupsPendentesDoLead,
  atribuirVendedorBalanceado, moverLeadParaFunilSlug, enviarMenuAtendimento,
  ehGrupoOuCanal, sleep, normalizarDelayQuestionario, normalizarCep, tipoMidia
});


// ============================================================
// Autenticação do painel Movatak (suas rotas internas)
// ============================================================
// ── PONTE DE AUTENTICAÇÃO: admin OU cliente (portal) ──────────
// Aceita o segredo admin (acesso total) OU o app_token do cliente (acesso
// restrito à própria operação). Quando é cliente, força o cliente_id do token
// e marca req.ehCliente para bloquear ações sensíveis e validar posse de recursos.
async function authMovatakOuApp(req, res, next) {
  const secret = req.headers['x-movatak-secret'];
  // Caminho admin: segredo correto = acesso total (comportamento original).
  if (secret && secret === process.env.MOVATAK_SECRET) {
    req.ehCliente = false;
    return next();
  }
  // Caminho cliente: valida o app_token.
  const token = req.headers['x-app-token'];
  if (!token) return res.status(401).json({ error: 'Não autorizado.' });
  try {
    const r = await query(
      'SELECT id, nome, permissoes_portal FROM movatak_clientes WHERE app_token = $1 AND ativo = true',
      [token]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'Token inválido.' });
    req.ehCliente = true;
    req.clienteId = r.rows[0].id;
    req.clienteNome = r.rows[0].nome;
    req.clientePermissoes = normalizarPermissoes(r.rows[0].permissoes_portal);
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// Verifica que um recurso (lead, coluna, conversa, etc.) pertence ao cliente.
// Para admin (ehCliente=false) sempre libera. Para cliente, consulta a tabela.
async function recursoPertenceAoCliente(req, tabela, recursoId, colunaCliente) {
  if (!req.ehCliente) return true; // admin tem acesso total
  if (!recursoId) return false;
  const col = colunaCliente || 'cliente_id';
  try {
    const r = await query(
      `SELECT 1 FROM ${tabela} WHERE id = $1 AND ${col} = $2 LIMIT 1`,
      [recursoId, req.clienteId]
    );
    return r.rows.length > 0;
  } catch (e) {
    return false;
  }
}

// Middlewares de cadeia: autentica (admin OU cliente) e, se for cliente,
// valida que o recurso da URL (:id) pertence a ele. Bloqueia com 403 se não.
// Uso: app.get('/.../leads/:id/...', ...exigeLead, handler)
const exigeLead = [authMovatakOuApp, async (req, res, next) => {
  if (req.ehCliente && !(await recursoPertenceAoCliente(req, 'movatak_leads', req.params.id))) {
    return res.status(403).json({ error: 'Acesso negado a este lead.' });
  }
  next();
}];
const exigeColuna = [authMovatakOuApp, async (req, res, next) => {
  if (req.ehCliente && !(await recursoPertenceAoCliente(req, 'movatak_funil_colunas', req.params.id))) {
    return res.status(403).json({ error: 'Acesso negado a esta coluna.' });
  }
  next();
}];
const exigeConversa = [authMovatakOuApp, async (req, res, next) => {
  if (req.ehCliente && !(await recursoPertenceAoCliente(req, 'movatak_conversas', req.params.id))) {
    return res.status(403).json({ error: 'Acesso negado a esta conversa.' });
  }
  next();
}];
const exigeSetor = [authMovatakOuApp, async (req, res, next) => {
  if (req.ehCliente && !(await recursoPertenceAoCliente(req, 'movatak_setores', req.params.id))) {
    return res.status(403).json({ error: 'Acesso negado a este setor.' });
  }
  next();
}];
const exigeAgendamento = [authMovatakOuApp, async (req, res, next) => {
  if (req.ehCliente && !(await recursoPertenceAoCliente(req, 'movatak_agendamentos', req.params.id))) {
    return res.status(403).json({ error: 'Acesso negado a este agendamento.' });
  }
  next();
}];
const exigeMsgRapida = [authMovatakOuApp, async (req, res, next) => {
  if (req.ehCliente && !(await recursoPertenceAoCliente(req, 'movatak_mensagens_rapidas', req.params.id))) {
    return res.status(403).json({ error: 'Acesso negado a esta mensagem rápida.' });
  }
  next();
}];
const exigeVendedor = [authMovatakOuApp, async (req, res, next) => {
  if (req.ehCliente && !(await recursoPertenceAoCliente(req, 'movatak_vendedores', req.params.id))) {
    return res.status(403).json({ error: 'Acesso negado a este vendedor.' });
  }
  next();
}];
const exigeCampanha = [authMovatakOuApp, async (req, res, next) => {
  if (req.ehCliente && !(await recursoPertenceAoCliente(req, 'movatak_campanhas', req.params.id))) {
    return res.status(403).json({ error: 'Acesso negado a esta campanha.' });
  }
  next();
}];
const exigePlano = [authMovatakOuApp, async (req, res, next) => {
  if (req.ehCliente && !(await recursoPertenceAoCliente(req, 'movatak_planos', req.params.id))) {
    return res.status(403).json({ error: 'Acesso negado a este plano.' });
  }
  next();
}];
const exigeTemplateFU = [authMovatakOuApp, async (req, res, next) => {
  if (req.ehCliente && !(await recursoPertenceAoCliente(req, 'movatak_followup_templates', req.params.id))) {
    return res.status(403).json({ error: 'Acesso negado a este template.' });
  }
  next();
}];
const exigeQuestTemplate = [authMovatakOuApp, async (req, res, next) => {
  if (req.ehCliente && !(await recursoPertenceAoCliente(req, 'movatak_questionario_templates', req.params.tid))) {
    return res.status(403).json({ error: 'Acesso negado a este template.' });
  }
  next();
}];

// Para rotas /clientes/:id/... — se for cliente, força o :id ser o dele.
// Assim ele nunca lista/acessa dados de outro cliente, mesmo trocando a URL.
const forcaClienteIdNaUrl = [authMovatakOuApp, (req, res, next) => {
  if (req.ehCliente) req.params.id = String(req.clienteId);
  next();
}];

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
    // Carrega os setores que este vendedor pode acessar. Tudo que o vendedor vê/edita
    // é filtrado por esta lista no backend — é aqui que mora o controle de acesso real.
    const setoresR = await query(
      `SELECT s.id, s.nome, s.cor FROM movatak_setor_vendedores sv
         JOIN movatak_setores s ON s.id = sv.setor_id AND COALESCE(s.ativo, true) = true
        WHERE sv.vendedor_id = $1
        ORDER BY s.ordem_bot NULLS LAST, s.nome`,
      [req.vendedor.id]
    ).catch(() => ({ rows: [] }));
    req.vendedor.setores = setoresR.rows;
    req.vendedor.setorIds = setoresR.rows.map(s => Number(s.id));
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// Garante que um setor pertence ao escopo do vendedor logado. Use em todo endpoint
// que recebe setor_id do vendedor, pra recusar acesso a setores de outros.
function vendedorPodeSetor(req, setorId) {
  if (!req.vendedor || !Array.isArray(req.vendedor.setorIds)) return false;
  return req.vendedor.setorIds.includes(Number(setorId));
}

// Valida que um lead pertence a um setor que o vendedor acessa. Retorna o lead
// (com cliente_id/setor_id) se ok, ou null se fora do escopo. SEMPRE usar antes
// de deixar o vendedor ler/operar um lead específico.
async function vendedorPodeLead(req, leadId) {
  if (!req.vendedor) return null;
  const r = await query(
    `SELECT id, cliente_id, setor_id, telefone, nome FROM movatak_leads WHERE id = $1 AND cliente_id = $2`,
    [leadId, req.vendedor.cliente_id]
  ).catch(() => ({ rows: [] }));
  if (!r.rows.length) return null;
  const lead = r.rows[0];
  if (!vendedorPodeSetor(req, lead.setor_id)) return null;
  return lead;
}

// ============================================================
// Z-API — envio de mensagens e helpers (ver src/zapi.js).
// ============================================================

// [refatoracao util] enviarAlerta() -> src/util.js

// ============================================================
// Auditoria operacional — histórico do lead e saúde da integração
// ============================================================
// registrarEventoLead → src/leads.js

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

// [refatoracao util] registrarErroZapi() -> src/util.js

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

// [refatoracao util] ehGrupoOuCanal() -> src/util.js

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

// [refatoracao 3c] localizarCampanhaPorIA() -> src/ia.js

// [refatoracao 3d] followupDataDaLinha() -> src/followups.js

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

// [refatoracao util] sleep() -> src/util.js

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
// [refatoracao 3d] DIAS_FOLLOWUP_V2 -> src/followups.js

// [refatoracao 3d] agendarFollowupV2() -> src/followups.js

// [refatoracao 3d] enviarFollowupsPendentesDoLead() -> src/followups.js

// [refatoracao 3d] migrarFU1ParaFU2() -> src/followups.js

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
            c.ausencia_horarios, c.ausencia_datas, c.ausencia_msg_padrao,
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

        // Pausa de ausência: segura o follow-up fora do horário de atendimento.
        // Mantém 'pendente' para o próprio cron reenviar quando o expediente voltar.
        if (clienteRowEmAusencia(row)) {
          console.log(`[cron] FU${row.sequencia_fu || 1} msg${row.etapa_seq} adiado: cliente em ausência → lead ${row.lead_id}`);
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
        registrarConversa(row.lead_id, row.cliente_id, 'saida', msg || '', null, null, null, null, 'followup').catch(() => null);
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

// ---- Auto-reconexão: reinicia instâncias caídas (quedas transitórias de sessão) ----
// Só roda com CRON_ATIVO e sob trava de liderança (não duplica entre serviços).
// Restart resolve queda de sessão sem QR; se o celular deslogou de vez, precisa do QR
// (aí o cliente reconecta sozinho pela tela de Conexão). Throttle: 1 restart / 10 min / instância.
const _ultimoRestartInstancia = new Map();
if (CRON_ATIVO) {
  cron.schedule('*/5 * * * *', async () => {
    await withPgAdvisoryLock('auto-reconexao', async () => {
      const r = await query(
        `SELECT id, nome, zapi_instance, zapi_token, zapi_client_token
           FROM movatak_clientes
          WHERE ativo = true AND zapi_instance IS NOT NULL AND zapi_token IS NOT NULL`
      );
      for (const c of r.rows) {
        try {
          const st = await zapiStatus(c.zapi_instance, c.zapi_token, c.zapi_client_token || '');
          if (st.connected === true) continue;
          const agora = Date.now();
          const ultimo = _ultimoRestartInstancia.get(c.zapi_instance) || 0;
          if (agora - ultimo < 10 * 60 * 1000) continue;
          _ultimoRestartInstancia.set(c.zapi_instance, agora);
          await zapiRestart(c.zapi_instance, c.zapi_token, c.zapi_client_token || '');
          console.log(JSON.stringify({ tipo: 'auto_reconexao', cliente_id: c.id, instancia: c.zapi_instance, acao: 'restart' }));
        } catch (e) {
          console.warn('[auto-reconexao] falha cliente', c.id, e.response?.data?.error || e.message);
        }
      }
    });
  }, { timezone: 'America/Sao_Paulo' });
}

// [refatoracao 3d] finalizarFollowupsEsgotados() -> src/followups.js
if (CRON_ATIVO) {
  cron.schedule('*/30 * * * *', async () => {
    await withPgAdvisoryLock('pos-followup', finalizarFollowupsEsgotados);
  }, { timezone: 'America/Sao_Paulo' });
}

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
// Cliente troca a própria senha (autenticado pelo app_token).
// Exige a senha atual para confirmar. Registra a data da troca.
app.patch('/movatak/app/trocar-senha', authCliente, async (req, res) => {
  try {
    const senhaAtual = String((req.body && req.body.senha_atual) || '');
    const senhaNova = String((req.body && req.body.senha_nova) || '');
    if (!senhaNova || senhaNova.length < 4) return res.status(400).json({ error: 'A nova senha deve ter pelo menos 4 caracteres.' });

    const r = await query('SELECT portal_senha_hash FROM movatak_clientes WHERE id = $1', [req.clienteId]);
    const atualHash = r.rows.length ? r.rows[0].portal_senha_hash : null;
    // Se já existe senha, exige a atual correta. Se não existe ainda, permite definir.
    if (atualHash && atualHash !== hashSenha(senhaAtual)) {
      return res.status(401).json({ error: 'Senha atual incorreta.' });
    }
    await query(
      'UPDATE movatak_clientes SET portal_senha_hash = $1, portal_senha_trocada_em = NOW() WHERE id = $2',
      [hashSenha(senhaNova), req.clienteId]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PORTAL DO CLIENTE — Login por email e senha ──────────────
// Valida email+senha do cliente e devolve o app_token (usado nas demais chamadas).
app.post('/movatak/app/login', async (req, res) => {
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const senha = String((req.body && req.body.senha) || '');
    if (!email || !senha) return res.status(400).json({ error: 'Informe email e senha.' });

    const r = await query(
      'SELECT id, nome, app_token, portal_senha_hash FROM movatak_clientes WHERE LOWER(portal_email) = $1 AND ativo = true',
      [email]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'Email ou senha inválidos.' });
    const cli = r.rows[0];
    if (!cli.portal_senha_hash || cli.portal_senha_hash !== hashSenha(senha)) {
      return res.status(401).json({ error: 'Email ou senha inválidos.' });
    }
    res.json({ app_token: cli.app_token, nome: cli.nome });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Retorna a identidade do cliente autenticado (para o portal montar o funil).
app.get('/movatak/app/me', authCliente, async (req, res) => {
  res.json({ id: req.clienteId, nome: req.clienteNome, permissoes: req.clientePermissoes });
});

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
app.get('/movatak/admin/clientes', authMovatakOuApp, async (req, res) => {
  try {
    // Modo cliente (portal): retorna SOMENTE a própria operação.
    const filtroCliente = req.ehCliente ? ' WHERE c.id = $1' : '';
    const params = req.ehCliente ? [req.clienteId] : [];
    const r = await query(
      `SELECT c.id, c.nome, c.whatsapp, c.ativo, c.criado_em,
              COUNT(l.id) AS total_leads,
              COUNT(l.id) FILTER (WHERE l.etapa = 'cliente') AS convertidos,
              COUNT(l.id) FILTER (WHERE l.etapa = 'followup') AS em_followup,
              COUNT(l.id) FILTER (WHERE DATE(l.criado_em) = CURRENT_DATE) AS leads_hoje,
              COUNT(l.id) FILTER (WHERE l.etapa = 'cliente' AND DATE(COALESCE(l.convertido_em, l.atualizado_em)) = CURRENT_DATE) AS vendas_hoje
       FROM movatak_clientes c
       LEFT JOIN movatak_leads l ON l.cliente_id = c.id${filtroCliente}
       GROUP BY c.id
       ORDER BY c.criado_em DESC`,
      params
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
      trigger_msg, teto_cpl, planos, permissoes_portal, nicho
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

    const nichoNormalizado = normalizarNichoCliente(nicho);
    if (nichoNormalizado) {
      await query('UPDATE movatak_clientes SET nicho=$1, agenda_ativa=true WHERE id=$2', [nichoNormalizado, r.rows[0].id]).catch(() => null);
      await aplicarTemplateNichoCliente(r.rows[0].id, nichoNormalizado, { sincronizar: false }).catch(e => console.error('[nicho][novo-cliente]', e.message));
    } else {
      await garantirFunilPadraoCliente(r.rows[0].id).catch(() => null);
    }

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

// Config pós-follow-up (ação quando a régua termina sem resposta). Endpoint dedicado
// para não passar pela validação do formulário completo (nome/WhatsApp/Instance).
app.patch('/movatak/admin/clientes/:id/pos-followup', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const acao = ['mover', 'descartar'].includes(req.body && req.body.pos_followup_acao) ? req.body.pos_followup_acao : 'nenhum';
    const colunaId = (acao === 'mover' && req.body.pos_followup_coluna_id) ? parseInt(req.body.pos_followup_coluna_id) : null;
    await query(
      'UPDATE movatak_clientes SET pos_followup_acao = $1, pos_followup_coluna_id = $2 WHERE id = $3',
      [acao, colunaId, req.params.id]
    );
    res.json({ ok: true, pos_followup_acao: acao, pos_followup_coluna_id: colunaId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Buscar dados de um cliente para edição (sem expor token/client-token)
app.get('/movatak/admin/clientes/:id/dados', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    await garantirColunasClientesPortal();
    const r = await query(
      `SELECT id, nome, whatsapp, zapi_instance, trigger_msg, teto_cpl, nicho, agenda_ativa, permissoes_portal, acao_arquivar_ao_final, acao_marcar_nao_lido,
              boas_vindas_lead_msg1, boas_vindas_lead_msg2, boas_vindas_lead_delay,
              ia_oferta, ia_tom, ia_resumo, portal_email, portal_senha_trocada_em,
              pos_followup_acao, pos_followup_coluna_id,
              CASE WHEN portal_senha_hash IS NULL OR portal_senha_hash = '' THEN false ELSE true END AS portal_tem_senha
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
// Salva APENAS as credenciais de acesso ao portal (email/senha) de um cliente.
// Endpoint dedicado — não exige os campos do cadastro completo.
app.patch('/movatak/admin/clientes/:id/credenciais-portal', authMovatak, async (req, res) => {
  try {
    const portal_email = req.body ? req.body.portal_email : undefined;
    const portal_senha = req.body ? req.body.portal_senha : undefined;
    const campos = [], valores = [];
    let idx = 1;
    if (portal_email !== undefined) {
      campos.push('portal_email = $' + idx++);
      valores.push(portal_email ? String(portal_email).trim().toLowerCase() : null);
    }
    if (portal_senha) {
      campos.push('portal_senha_hash = $' + idx++);
      valores.push(hashSenha(portal_senha));
    }
    if (!campos.length) return res.status(400).json({ error: 'Nada para salvar.' });
    valores.push(req.params.id);
    const r = await query(
      `UPDATE movatak_clientes SET ${campos.join(', ')} WHERE id = $${idx} RETURNING id`,
      valores
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/movatak/admin/clientes/:id/dados', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    await garantirColunasClientesPortal();
    let { nome, whatsapp, zapi_instance, zapi_token, zapi_client_token, trigger_msg, teto_cpl, nicho, agenda_ativa, permissoes_portal, acao_arquivar_ao_final, acao_marcar_nao_lido, boas_vindas_lead_msg1, boas_vindas_lead_msg2, boas_vindas_lead_delay, ia_oferta, ia_tom, ia_resumo, portal_email, portal_senha, pos_followup_acao, pos_followup_coluna_id } = req.body;

    // Modo cliente (portal): NUNCA altera dados sensíveis (WhatsApp, Z-API, CPL,
    // permissões, credenciais do portal). Preserva os valores atuais do banco e
    // ignora qualquer tentativa de mudá-los, mesmo que venham forjados no corpo.
    if (req.ehCliente) {
      const atual = await query(
        'SELECT nome, whatsapp, zapi_instance, zapi_token, zapi_client_token, teto_cpl FROM movatak_clientes WHERE id = $1',
        [req.params.id]
      );
      if (!atual.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
      const a = atual.rows[0];
      whatsapp = a.whatsapp;
      zapi_instance = a.zapi_instance;
      zapi_token = undefined;          // não troca
      zapi_client_token = undefined;   // não troca
      teto_cpl = a.teto_cpl;
      if (nome === undefined || nome === null || !String(nome).trim()) nome = a.nome;
      // Bloqueia campos administrativos vindos do cliente.
      permissoes_portal = undefined;
      portal_email = undefined;
      portal_senha = undefined;
    }

    if (!nome || !whatsapp || !zapi_instance) {
      return res.status(400).json({ error: 'Nome, WhatsApp e Instance ID sao obrigatorios.' });
    }

    const triggerPadrao = (trigger_msg && String(trigger_msg).trim()) ? String(trigger_msg).trim() : 'USAR_GATILHOS_DAS_CAMPANHAS';
    const campos = ['nome = $1', 'whatsapp = $2', 'zapi_instance = $3', 'trigger_msg = $4', 'teto_cpl = $5'];
    const valores = [nome, whatsapp, zapi_instance, triggerPadrao, teto_cpl ? parseFloat(teto_cpl) : null];
    let idx = 6;
    if (nicho !== undefined) { campos.push('nicho = $' + idx); valores.push(normalizarNichoCliente(nicho) || null); idx++; }
    if (agenda_ativa !== undefined) { campos.push('agenda_ativa = $' + idx); valores.push(!!agenda_ativa); idx++; }
    if (permissoes_portal) { campos.push('permissoes_portal = $' + idx + '::jsonb'); valores.push(JSON.stringify(normalizarPermissoes(permissoes_portal))); idx++; }
    if (acao_arquivar_ao_final !== undefined) { campos.push('acao_arquivar_ao_final = $' + idx); valores.push(!!acao_arquivar_ao_final); idx++; }
    if (acao_marcar_nao_lido !== undefined) { campos.push('acao_marcar_nao_lido = $' + idx); valores.push(!!acao_marcar_nao_lido); idx++; }
    if (boas_vindas_lead_msg1 !== undefined) { campos.push('boas_vindas_lead_msg1 = $' + idx); valores.push(boas_vindas_lead_msg1 || null); idx++; }
    if (boas_vindas_lead_msg2 !== undefined) { campos.push('boas_vindas_lead_msg2 = $' + idx); valores.push(boas_vindas_lead_msg2 || null); idx++; }
    if (boas_vindas_lead_delay !== undefined) { campos.push('boas_vindas_lead_delay = $' + idx); valores.push(parseInt(boas_vindas_lead_delay) || 5); idx++; }
    if (ia_oferta !== undefined) { campos.push('ia_oferta = $' + idx); valores.push(ia_oferta || null); idx++; }
    if (ia_tom !== undefined) { campos.push('ia_tom = $' + idx); valores.push(ia_tom || null); idx++; }
    if (ia_resumo !== undefined) { campos.push('ia_resumo = $' + idx); valores.push(ia_resumo || null); idx++; }
    if (pos_followup_acao !== undefined) { campos.push('pos_followup_acao = $' + idx); valores.push(['mover', 'descartar'].includes(pos_followup_acao) ? pos_followup_acao : 'nenhum'); idx++; }
    if (pos_followup_coluna_id !== undefined) { campos.push('pos_followup_coluna_id = $' + idx); valores.push(pos_followup_coluna_id ? parseInt(pos_followup_coluna_id) : null); idx++; }
    if (portal_email !== undefined) { campos.push('portal_email = $' + idx); valores.push(portal_email ? String(portal_email).trim().toLowerCase() : null); idx++; }
    if (portal_senha) { campos.push('portal_senha_hash = $' + idx); valores.push(hashSenha(portal_senha)); idx++; }

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
    const nichoAplicar = normalizarNichoCliente(nicho);
    if (nicho !== undefined && nichoAplicar) {
      await aplicarTemplateNichoCliente(req.params.id, nichoAplicar, { sincronizar: false }).catch(e => console.error('[nicho][editar-cliente]', e.message));
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Leads de um cliente específico
app.get('/movatak/admin/clientes/:id/leads', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const r = await query(
      `SELECT l.*, p.nome AS plano_nome, s.nome AS setor_nome, s.cor AS setor_cor
       FROM movatak_leads l
       LEFT JOIN movatak_planos p ON p.id = l.plano_id
       LEFT JOIN movatak_setores s ON s.id = l.setor_id
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
app.get('/movatak/admin/clientes/:id/ausencia', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const r = await query(
      `SELECT ausencia_msg_padrao, ausencia_horarios, ausencia_datas FROM movatak_clientes WHERE id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const row = r.rows[0];
    res.json({
      ausencia_msg_padrao: row.ausencia_msg_padrao || '',
      ausencia_horarios: Array.isArray(row.ausencia_horarios) ? row.ausencia_horarios : [],
      ausencia_datas: Array.isArray(row.ausencia_datas) ? row.ausencia_datas : []
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/admin/clientes/:id/ausencia', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const { ausencia_msg_padrao, ausencia_horarios, ausencia_datas } = req.body || {};
    const horarios = Array.isArray(ausencia_horarios) ? ausencia_horarios : [];
    const datas = Array.isArray(ausencia_datas) ? ausencia_datas : [];
    await query(
      `UPDATE movatak_clientes
         SET ausencia_msg_padrao = $1, ausencia_horarios = $2::jsonb, ausencia_datas = $3::jsonb
       WHERE id = $4`,
      [ausencia_msg_padrao || null, JSON.stringify(horarios), JSON.stringify(datas), req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/admin/clientes/:id/followup', ...forcaClienteIdNaUrl, async (req, res) => {
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
app.patch('/movatak/admin/clientes/:id/followup', ...forcaClienteIdNaUrl, async (req, res) => {
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
app.patch('/movatak/admin/leads/:id/plano', ...exigeLead, async (req, res) => {
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
app.get('/movatak/admin/clientes/:id/vendedores', ...forcaClienteIdNaUrl, async (req, res) => {
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
    // Setores de cada vendedor (pra marcar os checkboxes no cadastro).
    const sv = await query(
      `SELECT sv.vendedor_id, sv.setor_id FROM movatak_setor_vendedores sv
         JOIN movatak_vendedores v ON v.id = sv.vendedor_id
        WHERE v.cliente_id = $1`,
      [req.params.id]
    ).catch(() => ({ rows: [] }));
    const setoresPorVend = {};
    sv.rows.forEach(row => {
      (setoresPorVend[row.vendedor_id] = setoresPorVend[row.vendedor_id] || []).push(Number(row.setor_id));
    });
    const rows = r.rows.map(v => ({ ...v, setor_ids: setoresPorVend[v.id] || [] }));
    res.json(rows);
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
app.post('/movatak/admin/clientes/:id/vendedores', ...forcaClienteIdNaUrl, async (req, res) => {
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
app.delete('/movatak/admin/clientes/:clienteId/vendedores/:id', ...exigeVendedor, async (req, res) => {
  try {
    await query('UPDATE movatak_vendedores SET ativo = false WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// Setores (filas) — atendimento dividido por departamento dentro do mesmo WhatsApp
// ============================================================

// Listar setores de um cliente, com a lista de vendedores vinculados a cada um
app.get('/movatak/admin/clientes/:id/setores', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const r = await query(
      `SELECT s.id, s.cliente_id, s.nome, s.cor, s.mensagem_saudacao, s.ordem_bot, s.ativo, s.criado_em,
              COALESCE(
                json_agg(
                  json_build_object('id', v.id, 'nome', v.nome)
                ) FILTER (WHERE v.id IS NOT NULL), '[]'
              ) AS vendedores
         FROM movatak_setores s
         LEFT JOIN movatak_setor_vendedores sv ON sv.setor_id = s.id
         LEFT JOIN movatak_vendedores v ON v.id = sv.vendedor_id AND COALESCE(v.ativo, true) = true
        WHERE s.cliente_id = $1 AND COALESCE(s.ativo, true) = true
        GROUP BY s.id
        ORDER BY s.ordem_bot, s.nome`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch(e) {
    console.error('[admin/setores:list]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Criar setor novo
app.post('/movatak/admin/clientes/:id/setores', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const { nome, cor, mensagem_saudacao, ordem_bot, vendedor_ids } = req.body;
    if (!nome) return res.status(400).json({ error: 'Nome do setor é obrigatório.' });

    const rc = await query('SELECT id FROM movatak_clientes WHERE id = $1', [req.params.id]);
    if (!rc.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });

    const r = await query(
      `INSERT INTO movatak_setores (cliente_id, nome, cor, mensagem_saudacao, ordem_bot)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, cliente_id, nome, cor, mensagem_saudacao, ordem_bot, ativo, criado_em`,
      [req.params.id, nome, cor || '#3B82F6', mensagem_saudacao || null, parseInt(ordem_bot) || 0]
    );
    const setor = r.rows[0];

    // Vincula vendedores já na criação, se a lista foi enviada
    if (Array.isArray(vendedor_ids) && vendedor_ids.length) {
      for (const vid of vendedor_ids) {
        await query(
          `INSERT INTO movatak_setor_vendedores (setor_id, vendedor_id)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [setor.id, parseInt(vid)]
        );
      }
    }

    res.json(setor);
  } catch(e) {
    console.error('[admin/setores:create]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Editar setor (nome, cor, mensagem, ordem)
app.patch('/movatak/admin/setores/:id', ...exigeSetor, async (req, res) => {
  try {
    const { nome, cor, mensagem_saudacao, ordem_bot } = req.body;
    const r = await query(
      `UPDATE movatak_setores
          SET nome = COALESCE($1, nome),
              cor = COALESCE($2, cor),
              mensagem_saudacao = COALESCE($3, mensagem_saudacao),
              ordem_bot = COALESCE($4, ordem_bot)
        WHERE id = $5
        RETURNING id, cliente_id, nome, cor, mensagem_saudacao, ordem_bot, ativo, criado_em`,
      [nome || null, cor || null, mensagem_saudacao || null, ordem_bot != null ? parseInt(ordem_bot) : null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Setor não encontrado.' });
    res.json(r.rows[0]);
  } catch(e) {
    console.error('[admin/setores:edit]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Remover setor (soft delete)
app.delete('/movatak/admin/setores/:id', ...exigeSetor, async (req, res) => {
  try {
    await query('UPDATE movatak_setores SET ativo = false WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) {
    console.error('[admin/setores:delete]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Vincular ou desvincular um vendedor de um setor
app.post('/movatak/admin/setores/:id/vendedores', ...exigeSetor, async (req, res) => {
  try {
    const { vendedor_id } = req.body;
    if (!vendedor_id) return res.status(400).json({ error: 'vendedor_id é obrigatório.' });
    await query(
      `INSERT INTO movatak_setor_vendedores (setor_id, vendedor_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.params.id, parseInt(vendedor_id)]
    );
    res.json({ ok: true });
  } catch(e) {
    console.error('[admin/setores:vincular-vendedor]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/movatak/admin/setores/:id/vendedores/:vendedorId', ...exigeSetor, async (req, res) => {
  try {
    await query(
      'DELETE FROM movatak_setor_vendedores WHERE setor_id = $1 AND vendedor_id = $2',
      [req.params.id, req.params.vendedorId]
    );
    res.json({ ok: true });
  } catch(e) {
    console.error('[admin/setores:desvincular-vendedor]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Transferir um lead para outro setor (e opcionalmente outro vendedor) — segue o
// mesmo padrão de auditoria já usado em /movatak/admin/leads/:id/vendedor
app.patch('/movatak/admin/leads/:id/setor', ...exigeLead, async (req, res) => {
  try {
    const setorDestinoId = req.body && req.body.setor_id ? parseInt(req.body.setor_id) : null;
    const vendedorDestinoId = req.body && req.body.vendedor_id ? parseInt(req.body.vendedor_id) : null;
    if (!setorDestinoId) return res.status(400).json({ error: 'setor_id é obrigatório.' });

    const lead = await query(
      'SELECT id, cliente_id, setor_id, vendedor_id FROM movatak_leads WHERE id = $1',
      [req.params.id]
    );
    if (!lead.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    const leadAtual = lead.rows[0];

    const setorDestino = await query(
      'SELECT id, nome, cliente_id FROM movatak_setores WHERE id = $1',
      [setorDestinoId]
    );
    if (!setorDestino.rows.length) return res.status(404).json({ error: 'Setor de destino não encontrado.' });
    if (setorDestino.rows[0].cliente_id !== leadAtual.cliente_id) {
      return res.status(400).json({ error: 'Setor de destino não pertence ao mesmo cliente do lead.' });
    }

    if (vendedorDestinoId) {
      await query(
        `UPDATE movatak_leads SET setor_id = $1, vendedor_id = $2, atualizado_em = NOW() WHERE id = $3`,
        [setorDestinoId, vendedorDestinoId, req.params.id]
      );
    } else {
      await query(
        `UPDATE movatak_leads SET setor_id = $1, atualizado_em = NOW() WHERE id = $2`,
        [setorDestinoId, req.params.id]
      );
    }

    // Move o lead para a PRIMEIRA coluna do kanban desse setor (menor ordem).
    // Regra do Ronaldo: a 1ª coluna de cada setor é a "lista de leads" daquele setor.
    let colunaDestino = null;
    const primeiraColuna = await query(
      `SELECT id, nome FROM movatak_funil_colunas
        WHERE cliente_id = $1 AND ativo = true AND setor_id = $2
        ORDER BY ordem ASC, id ASC LIMIT 1`,
      [leadAtual.cliente_id, setorDestinoId]
    );
    if (primeiraColuna.rows.length) {
      colunaDestino = primeiraColuna.rows[0];
      await query(
        `UPDATE movatak_leads SET funil_coluna_id = $1, atualizado_em = NOW() WHERE id = $2`,
        [colunaDestino.id, req.params.id]
      );
    }

    await registrarEventoLead(
      req.params.id,
      leadAtual.cliente_id,
      'transferencia_setor',
      `Lead transferido para o setor ${setorDestino.rows[0].nome}`,
      {
        setor_origem_id: leadAtual.setor_id,
        setor_destino_id: setorDestinoId,
        vendedor_origem_id: leadAtual.vendedor_id,
        vendedor_destino_id: vendedorDestinoId || leadAtual.vendedor_id
      }
    );

    res.json({
      ok: true,
      setor_nome: setorDestino.rows[0].nome,
      coluna_destino: colunaDestino ? colunaDestino.nome : null
    });
  } catch(e) {
    console.error('[admin/leads:transferir-setor]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Reflete no WhatsApp (Z-API) a leitura feita no CRM: marca o chat do lead como
// lido no WhatsApp Web/app. Best-effort e em background (fire-and-forget): não
// atrasa a resposta do painel e engole qualquer erro (Z-API fora, lead sem
// telefone, grupo/canal). Chamado quando uma conversa é marcada como LIDA no CRM.
async function marcarChatLidoNoZap(leadId) {
  try {
    const r = await query(
      `SELECT l.telefone, c.zapi_instance, c.zapi_token, c.zapi_client_token
         FROM movatak_leads l JOIN movatak_clientes c ON c.id = l.cliente_id
        WHERE l.id = $1`,
      [leadId]
    );
    const row = r.rows[0];
    if (!row || !row.telefone || !row.zapi_instance) return;
    if (ehGrupoOuCanal(row.telefone)) return;
    await zapiModificarChat(row.zapi_instance, row.zapi_token, row.zapi_client_token, row.telefone, 'read');
  } catch (e) {
    console.error('[marcar-lida][zapi] falha ao marcar chat como lido no WhatsApp:', e.message);
  }
}

// Marca o lead como lido (padrão) ou não lido (body: { nao_lida: true }) —
// chamado ao abrir o painel de conversa, ou manualmente via "Marcar como não lida".
app.patch('/movatak/admin/leads/:id/marcar-lida', ...exigeLead, async (req, res) => {
  try {
    const naoLida = !!(req.body && req.body.nao_lida);
    const upd = await query(`UPDATE movatak_leads SET nao_lida = $1 WHERE id = $2 AND nao_lida IS DISTINCT FROM $1 RETURNING id`, [naoLida, req.params.id]);
    // Reflete no WhatsApp só quando REALMENTE mudou de não-lido -> lido, para não
    // chamar a Z-API à toa ao reabrir conversas que já estavam lidas.
    if (!naoLida && upd.rows.length) marcarChatLidoNoZap(req.params.id);
    res.json({ ok: true, nao_lida: naoLida });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Retorna a foto de perfil do lead. Usa cache de 24h (foto_atualizada_em). Se estiver
// vazia ou velha, busca no Z-API uma vez e salva. A URL do WhatsApp expira ~48h, por
// isso renovamos sob demanda em vez de guardar para sempre.
// Chamado pelo frontend quando a foto (URL do WhatsApp) falha ao carregar —
// limpa foto_url para não tentar de novo e poluir o console com 404 externos.
app.post('/movatak/admin/leads/:id/foto/expirada', ...exigeLead, async (req, res) => {
  try {
    await query(`UPDATE movatak_leads SET foto_url=NULL WHERE id=$1`, [req.params.id]).catch(() => null);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/admin/leads/:id/foto', ...exigeLead, async (req, res) => {
  try {
    const r = await query(
      `SELECT l.id, l.telefone, l.foto_url, l.foto_atualizada_em,
              c.zapi_instance, c.zapi_token, c.zapi_client_token
         FROM movatak_leads l JOIN movatak_clientes c ON c.id = l.cliente_id
        WHERE l.id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    const lead = r.rows[0];
    const agora = Date.now();
    const idade = lead.foto_atualizada_em ? (agora - new Date(lead.foto_atualizada_em).getTime()) : Infinity;
    const cacheValido = lead.foto_url && idade < 24 * 3600 * 1000;
    if (cacheValido) return res.json({ foto_url: lead.foto_url });

    if (!lead.zapi_instance || !lead.zapi_token || !lead.zapi_client_token || !lead.telefone) {
      return res.json({ foto_url: lead.foto_url || null });
    }
    const foto = await zapiBuscarFoto(lead.zapi_instance, lead.zapi_token, lead.zapi_client_token, lead.telefone);
    if (foto) {
      await query(`UPDATE movatak_leads SET foto_url=$1, foto_atualizada_em=NOW() WHERE id=$2`, [foto, lead.id]).catch(() => null);
    }
    res.json({ foto_url: foto || lead.foto_url || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Arquiva/desarquiva um lead na caixa de entrada (não afeta o WhatsApp real,
// é só organização dentro do CRM — diferente de acao_arquivar_ao_final).
app.patch('/movatak/admin/leads/:id/arquivar', ...exigeLead, async (req, res) => {
  try {
    const arquivado = req.body && typeof req.body.arquivado === 'boolean' ? req.body.arquivado : true;
    await query(`UPDATE movatak_leads SET arquivado = $1, atualizado_em = NOW() WHERE id = $2`, [arquivado, req.params.id]);
    res.json({ ok: true, arquivado });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Ranking de vendedores
app.get('/movatak/admin/clientes/:id/ranking', ...forcaClienteIdNaUrl, async (req, res) => {
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
app.patch('/movatak/admin/clientes/:id/dono', ...forcaClienteIdNaUrl, async (req, res) => {
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
  if (!t) return false;
  return comandos.some(cmd => {
    const c = normalizarComandoComparacao(cmd);
    if (!c) return false;
    if (t === c) return true;
    // Comandos com # são delimitados e intencionais: podem aparecer em qualquer
    // posição da mensagem (ex.: "Fechado! #ana").
    if (c.startsWith('#')) return t.includes(c);
    // Comandos sem # (ex.: slug de nome "ana") exigem correspondência como
    // PALAVRA ISOLADA, para não casar com substrings ("banana", "semana").
    const re = new RegExp('(^|[^a-z0-9])' + c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9]|$)');
    return re.test(t);
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

// pararAtendimentoLead, limparPedidoAtendente → src/leads.js

const MSG_PARAR_PADRAO = 'Perfeito{nome}! Já registrei seu pedido. 😊 Em breve um dos nossos atendentes vai falar com você por aqui.';// Dedup em memória: evita mandar várias confirmações se o lead repetir o
// comando em sequência (ex: digitou 3x seguidas achando que não foi).
const _ultimaConfirmacaoAtendente = new Map();
async function enviarConfirmacaoAtendente(cliente, lead) {
  if (!lead || !lead.telefone) return;
  const agora = Date.now();
  const ultima = _ultimaConfirmacaoAtendente.get(lead.id) || 0;
  if (agora - ultima < 2 * 60 * 1000) {
    console.log(`[zapi][msg-atendente] dedup — confirmação já enviada há menos de 2min pro lead ${lead.id}`);
    return;
  }
  _ultimaConfirmacaoAtendente.set(lead.id, agora);
  const primeiroNome = lead.nome ? (' ' + String(lead.nome).trim().split(' ')[0]) : '';
  const base = String(cliente.questionario_msg_parar || '').trim() || MSG_PARAR_PADRAO;
  const texto = base.replace(/\{nome\}/gi, primeiroNome);
  // enviarMsgQuestionario já trava envio pra grupos/canais e registra a conversa.
  await enviarMsgQuestionario(cliente, lead.telefone, texto, null);
  console.log(`[zapi][msg-atendente] confirmação enviada pro lead ${lead.id}`);
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

// [refatoracao 3b] reiniciarQuestionarioLead() -> src/questionario.js

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


// [refatoracao util] extrairDigitosTelefone() -> src/util.js

// [refatoracao util] telefonesEquivalentes() -> src/util.js

function telefoneEhDaEmpresa(telefone, cliente) {
  if (!telefone || !cliente) return false;
  const candidatosEmpresa = [
    cliente.whatsapp,
    cliente.telefone,
    cliente.zapi_phone,
    cliente.numero_whatsapp,
    cliente.connectedPhone
  ].filter(Boolean);
  return candidatosEmpresa.some(n => telefonesEquivalentes(telefone, n));
}

function primeiroTelefoneValido(candidatos, cliente) {
  const vistos = new Set();
  for (const valor of candidatos) {
    const digitos = extrairDigitosTelefone(valor);
    if (!digitos || vistos.has(digitos)) continue;
    vistos.add(digitos);
    if (telefoneEhDaEmpresa(digitos, cliente)) continue;
    return digitos;
  }
  return null;
}

function extrairTelefonePayload(body, cliente = null) {
  const candidatos = body && body.fromMe
    ? [
        body.to,
        body.recipient,
        body.recipientPhone,
        body.chatId,
        body.remoteJid,
        body.key && body.key.remoteJid,
        body.message && body.message.key && body.message.key.remoteJid,
        body.phone,
        body.senderPhone,
        body.from,
        body.participantPhone
      ]
    : [
        body.phone,
        body.senderPhone,
        body.from,
        body.chatId,
        body.remoteJid,
        body.key && body.key.remoteJid,
        body.message && body.message.key && body.message.key.remoteJid,
        body.participantPhone,
        body.to,
        body.recipient,
        body.recipientPhone
      ];

  return primeiroTelefoneValido(candidatos, cliente);
}

function extrairNomeContatoPayloadZapi(body, cliente, telefone) {
  const nomes = body && body.fromMe
    ? [body.contactName, body.chatName, body.pushName, body.notifyName]
    : [body.senderName, body.contactName, body.chatName, body.pushName, body.notifyName];

  for (const nome of nomes) {
    const s = String(nome || '').trim();
    if (!s) continue;
    // Evita salvar o nome da própria empresa como nome do lead em payload fromMe.
    if (cliente && cliente.nome && s.toLowerCase() === String(cliente.nome).trim().toLowerCase()) continue;
    if (telefone && telefoneEhDaEmpresa(telefone, cliente)) continue;
    return s;
  }
  return null;
}

// Extrai a URL da foto de perfil que o Z-API às vezes já manda no payload do webhook.
// Quando presente, é grátis (não precisa chamar a API). Vale ~48h.
function extrairFotoPayloadZapi(body) {
  if (!body) return null;
  return body.senderPhoto || body.photo || body.chatPhoto || body.profileThumbnail || body.profilePicThumb || null;
}

// [refatoracao util] variantesTelefone() -> src/util.js

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
  if (body.image && (body.image.imageUrl || body.image.url)) return { url: body.image.imageUrl || body.image.url, tipo: 'imagem' };
  if (body.video && (body.video.videoUrl || body.video.url)) return { url: body.video.videoUrl || body.video.url, tipo: 'video' };
  if (body.audio && (body.audio.audioUrl || body.audio.url)) return { url: body.audio.audioUrl || body.audio.url, tipo: 'audio' };
  if (body.document && (body.document.documentUrl || body.document.url)) return { url: body.document.documentUrl || body.document.url, tipo: 'documento' };
  const fallback = body.fileUrl || body.mediaUrl || null;
  return fallback ? { url: fallback, tipo: null } : { url: null, tipo: null };
}


function primeiroValor(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return null;
}

function textoDePossivelMensagem(obj) {
  if (!obj || typeof obj !== 'object') return '';
  return primeiroValor(
    obj.text && obj.text.message,
    typeof obj.text === 'string' ? obj.text : null,
    obj.message,
    obj.caption,
    obj.body,
    obj.conversation,
    obj.extendedTextMessage && obj.extendedTextMessage.text,
    obj.image && obj.image.caption,
    obj.video && obj.video.caption,
    obj.document && (obj.document.caption || obj.document.title || obj.document.fileName),
    obj.audio && 'Áudio',
    obj.image && 'Imagem',
    obj.video && 'Vídeo',
    obj.document && 'Documento'
  ) || '';
}

function tipoMidiaDePossivelMensagem(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.image) return 'imagem';
  if (obj.video) return 'video';
  if (obj.audio) return 'audio';
  if (obj.document) return 'documento';
  if (obj.midia_tipo) return obj.midia_tipo;
  if (obj.type && ['image','imagem'].includes(String(obj.type).toLowerCase())) return 'imagem';
  if (obj.type && ['audio','ptt'].includes(String(obj.type).toLowerCase())) return 'audio';
  if (obj.type && ['video'].includes(String(obj.type).toLowerCase())) return 'video';
  if (obj.type && ['document','documento','file'].includes(String(obj.type).toLowerCase())) return 'documento';
  return null;
}

function urlMidiaDePossivelMensagem(obj) {
  if (!obj || typeof obj !== 'object') return null;
  return primeiroValor(
    obj.midia_url,
    obj.image && (obj.image.imageUrl || obj.image.url),
    obj.video && (obj.video.videoUrl || obj.video.url),
    obj.audio && (obj.audio.audioUrl || obj.audio.url),
    obj.document && (obj.document.documentUrl || obj.document.url),
    obj.fileUrl,
    obj.mediaUrl
  );
}

function extrairReplyPayloadZapi(body) {
  const candidatos = [
    body.quotedMessage,
    body.quotedMsg,
    body.quoted,
    body.replyTo,
    body.reply,
    body.referenceMessage,
    body.referencedMessage,
    body.contextInfo,
    body.message && body.message.contextInfo,
    body.text && body.text.contextInfo,
    body.image && body.image.contextInfo,
    body.video && body.video.contextInfo,
    body.audio && body.audio.contextInfo,
    body.document && body.document.contextInfo,
    body.extendedTextMessage && body.extendedTextMessage.contextInfo
  ].filter(Boolean);

  let ref = candidatos.find(c => typeof c === 'object') || {};
  const quotedMessage = ref.quotedMessage || ref.message || ref.quoted || ref;
  const msgId = primeiroValor(
    body.quotedMessageId,
    body.quotedMsgId,
    body.replyMessageId,
    body.referenceMessageId,
    ref.quotedMessageId,
    ref.quotedMsgId,
    ref.messageId,
    ref.id,
    ref.stanzaId,
    ref.key && ref.key.id,
    quotedMessage && quotedMessage.messageId,
    quotedMessage && quotedMessage.id
  );

  if (!msgId && !textoDePossivelMensagem(quotedMessage) && !urlMidiaDePossivelMensagem(quotedMessage)) return null;
  return {
    reply_to_msg_id: msgId ? String(msgId) : null,
    reply_to_conteudo: textoDePossivelMensagem(quotedMessage) || null,
    reply_to_midia_url: urlMidiaDePossivelMensagem(quotedMessage) || null,
    reply_to_midia_tipo: tipoMidiaDePossivelMensagem(quotedMessage) || null,
    reply_payload: { raw_keys: Object.keys(ref || {}).slice(0, 25), quoted: quotedMessage || null }
  };
}

async function resolverReplyInfoLead(leadId, replyToConversaId, replyToMsgId, payloadInfo = null) {
  await garantirEstruturaConversas();
  let r = { rows: [] };
  if (replyToConversaId) {
    r = await query(
      `SELECT id, direcao, conteudo, midia_url, midia_tipo, msg_id
         FROM movatak_conversas WHERE id = $1 AND lead_id = $2 LIMIT 1`,
      [replyToConversaId, leadId]
    ).catch(() => ({ rows: [] }));
  }
  if (!r.rows.length && replyToMsgId) {
    r = await query(
      `SELECT id, direcao, conteudo, midia_url, midia_tipo, msg_id
         FROM movatak_conversas WHERE lead_id = $1 AND msg_id = $2 LIMIT 1`,
      [leadId, replyToMsgId]
    ).catch(() => ({ rows: [] }));
  }
  if (r.rows.length) {
    const m = r.rows[0];
    return {
      msgId: m.msg_id || replyToMsgId || null,
      info: {
        reply_to_conversa_id: m.id,
        reply_to_msg_id: m.msg_id || replyToMsgId || null,
        reply_to_direcao: m.direcao || null,
        reply_to_conteudo: m.conteudo || null,
        reply_to_midia_url: m.midia_url || null,
        reply_to_midia_tipo: m.midia_tipo || null,
        reply_payload: payloadInfo && payloadInfo.reply_payload ? payloadInfo.reply_payload : null
      }
    };
  }
  if (payloadInfo) {
    return {
      msgId: payloadInfo.reply_to_msg_id || replyToMsgId || null,
      info: {
        reply_to_conversa_id: null,
        reply_to_msg_id: payloadInfo.reply_to_msg_id || replyToMsgId || null,
        reply_to_direcao: null,
        reply_to_conteudo: payloadInfo.reply_to_conteudo || null,
        reply_to_midia_url: payloadInfo.reply_to_midia_url || null,
        reply_to_midia_tipo: payloadInfo.reply_to_midia_tipo || null,
        reply_payload: payloadInfo.reply_payload || null
      }
    };
  }
  return { msgId: replyToMsgId || null, info: null };
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

  // ---- Idempotência + registro do evento bruto (protege autoatendimento/conversa) ----
  // A Z-API reenvia o mesmo webhook em timeout/429 (aconteceu no incidente). Sem dedupe,
  // o mesmo messageId vira conversa duplicada e pode reiniciar autoatendimento. Aqui
  // gravamos o evento cru e, se o messageId já foi recebido, encerramos sem reprocessar.
  // Regra de ouro: falha ao gravar NUNCA derruba o fluxo — segue processando normal.
  let _eventoWebhookId = null;
  try {
    const _instEv = body.instanceId || body.instance || null;
    const _msgEv = body.messageId || body.id || null;
    const _phoneEv = String(body.phone || '') || null;
    const _dirEv = body.fromMe ? 'saida' : 'entrada';
    if (_msgEv) {
      const _insEv = await query(
        `INSERT INTO movatak_webhook_eventos (origem, instance_id, message_id, phone, direction, payload, status)
         VALUES ('zapi', $1, $2, $3, $4, $5::jsonb, 'recebido')
         ON CONFLICT (instance_id, message_id) WHERE message_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [_instEv, _msgEv, _phoneEv, _dirEv, JSON.stringify(body)]
      );
      if (!_insEv.rows.length) {
        logDebug('[zapi][ignorado] evento duplicado (messageId ' + _msgEv + ' já recebido)');
        return;
      }
      _eventoWebhookId = _insEv.rows[0].id;
    } else {
      const _insEv = await query(
        `INSERT INTO movatak_webhook_eventos (origem, instance_id, message_id, phone, direction, payload, status)
         VALUES ('zapi', $1, NULL, $2, $3, $4::jsonb, 'recebido') RETURNING id`,
        [_instEv, _phoneEv, _dirEv, JSON.stringify(body)]
      );
      _eventoWebhookId = _insEv.rows[0].id;
    }
  } catch (e) {
    console.error('[zapi][evento] falha ao registrar evento bruto (seguindo mesmo assim):', e.message);
  }

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
    let telefone     = extrairTelefonePayload(body);
    const texto      = (body.text && body.text.message) ? body.text.message
                       : (typeof body.text === 'string' ? body.text : '');
    const replyPayload = extrairReplyPayloadZapi(body);


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

    if (body.isNewsletter) {
      logDebug('[zapi][ignorado] newsletter');
      return;
    }

    // ===== GRUPOS (entram na inbox como um contato, espelhando o WhatsApp) =====
    // Em vez de descartar, registramos a conversa do grupo usando o id do grupo
    // (@g.us) como "telefone"/chave. Fluxo isolado e curto: NÃO dispara gatilho,
    // follow-up, questionário nem comando — só garante que a conversa apareça na
    // inbox. Não cria coluna nova nem altera a query do funil (que quebrou antes).
    // Detecção de grupo robusta: confia no flag isGroup da Z-API, mas também
    // checa a chave (@g.us / id longo) caso o flag não venha em algum payload.
    const _chaveGrupo = String(body.phone || body.chatId || body.remoteJid || '').trim();
    if (body.isGroup || ehGrupoOuCanal(_chaveGrupo)) {
      try {
        if (!instanceId) return;
        const rcg = await query('SELECT * FROM movatak_clientes WHERE zapi_instance = $1 AND ativo = true', [instanceId]);
        if (!rcg.rows.length) return;
        const clienteG = rcg.rows[0];
        const grupoChave = _chaveGrupo;
        if (!grupoChave) return;
        const nomeGrupo = body.chatName || body.notifyName || ('Grupo ' + grupoChave.slice(0, 10));
        const ehSaidaG = !!body.fromMe;
        // Localiza pela "chave" do grupo, guardada no campo telefone do lead.
        let lg = await query('SELECT id FROM movatak_leads WHERE cliente_id=$1 AND telefone=$2 LIMIT 1', [clienteG.id, grupoChave]);
        let lgId;
        if (lg.rows.length) {
          lgId = lg.rows[0].id;
          await query('UPDATE movatak_leads SET atualizado_em=NOW(), nao_lida=$2 WHERE id=$1', [lgId, ehSaidaG ? false : true]).catch(() => null);
        } else {
          const nv = await query(
            `INSERT INTO movatak_leads (cliente_id, telefone, nome, etapa, chat_lid, nao_lida, atualizado_em)
             VALUES ($1, $2, $3, 'lead', $4, $5, NOW()) RETURNING id`,
            [clienteG.id, grupoChave, nomeGrupo, chatLid, ehSaidaG ? false : true]
          );
          lgId = nv.rows[0].id;
        }
        const midiaG = extrairMidiaPayloadZapi(body);
        const remetenteG = ehSaidaG ? '' : (body.senderName ? body.senderName + ': ' : '');
        await registrarConversa(lgId, clienteG.id, ehSaidaG ? 'saida' : 'entrada', remetenteG + (texto || ''), midiaG.url, midiaG.tipo, body.messageId || body.id || null, null).catch(() => null);
      } catch (e) {
        console.error('[zapi][grupo] erro:', e.message);
      }
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

    // Depois de identificar o cliente/instância, recalcula o telefone ignorando
    // qualquer número que seja da própria empresa. Isso evita criar lead
    // "falando consigo mesmo" quando o webhook fromMe traz connectedPhone/phone
    // como número da conta conectada.
    const telefoneAntesFiltroEmpresa = telefone;
    telefone = extrairTelefonePayload(body, cliente);
    if (telefoneAntesFiltroEmpresa && !telefone) {
      logDebug('[zapi][telefone] telefone descartado por ser da própria empresa ou inválido', JSON.stringify({ telefoneAntesFiltroEmpresa, fromMe: !!body.fromMe }));
    }

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

    if (!telefone) {
      logDebug('[zapi][ignorado] telefone real do contato não identificado após filtro anti-próprio-número', JSON.stringify({
        fromMe: !!body.fromMe,
        phone: body.phone || null,
        senderPhone: body.senderPhone || null,
        connectedPhone: body.connectedPhone || null,
        to: body.to || null,
        from: body.from || null,
        chatId: body.chatId || null,
        remoteJid: body.remoteJid || null
      }));
      return;
    }

    // Se o payload trouxe a foto de perfil do contato (entrada), salva no lead.
    // É grátis (não chama a API) e mantém o avatar atualizado conforme as mensagens chegam.
    if (!body.fromMe) {
      const fotoPayload = extrairFotoPayloadZapi(body);
      if (fotoPayload) {
        await query(
          `UPDATE movatak_leads SET foto_url=$1, foto_atualizada_em=NOW()
            WHERE cliente_id=$2 AND telefone=$3`,
          [fotoPayload, cliente.id, telefone]
        ).catch(() => null);
      }
    }

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

      const midiaFromMe = extrairMidiaPayloadZapi(body);

      if (!leadFromMe) {
        console.log('[zapi][fromMe] lead nao encontrado para registrar mensagem/comando', JSON.stringify({ chatLid, telefone, ehComandoInterno }));

        // Mensagem enviada diretamente pelo WhatsApp Web para um contato que ainda não
        // existe no CRM. Antes era ignorada; agora cria um contato simples, sem acionar
        // automação nem marcar como não lido.
        if (!ehComandoInterno && telefone && ((texto && String(texto).trim()) || midiaFromMe.url)) {
          const novoLeadFromMe = await query(
            `INSERT INTO movatak_leads (cliente_id, telefone, nome, etapa, chat_lid, nao_lida, atualizado_em)
             VALUES ($1, $2, $3, 'lead', $4, false, NOW())
             RETURNING id`,
            [cliente.id, telefone, extrairNomeContatoPayloadZapi(body, cliente, telefone), chatLid]
          );
          await registrarConversa(novoLeadFromMe.rows[0].id, cliente.id, 'saida', texto || '', midiaFromMe.url, midiaFromMe.tipo, body.messageId || body.id || null, replyPayload, 'whatsapp_web').catch(() => null);
          await registrarEventoLead(novoLeadFromMe.rows[0].id, cliente.id, 'contato_criado_whatsapp_web', 'Contato criado a partir de mensagem enviada no WhatsApp Web', { telefone, chatLid }).catch(() => null);
        }
        return;
      }

      // jaRegistrada fica visível ao bloco de comandos mais abaixo: um eco fromMe de
      // uma mensagem que o PRÓPRIO CRM enviou não deve ser interpretado como comando.
      let jaRegistrada = false;
      if ((texto && String(texto).trim()) || midiaFromMe.url) {
        // Evita duplicar: se a mensagem foi enviada pelo PRÓPRIO painel, ela já foi
        // gravada no banco (com o mesmo messageId do Z-API) no momento do envio. O
        // webhook fromMe chega logo depois confirmando o mesmo envio — se já existe
        // uma conversa com esse messageId, não registra de novo.
        const msgIdFromMe = body.messageId || body.id || null;
        if (msgIdFromMe) {
          const dup = await query(
            'SELECT 1 FROM movatak_conversas WHERE lead_id=$1 AND msg_id=$2 LIMIT 1',
            [leadFromMe.id, msgIdFromMe]
          ).catch(() => ({ rows: [] }));
          jaRegistrada = dup.rows.length > 0;
        }
        // Fallback por conteúdo + janela curta — roda sempre que o match por msg_id não
        // achou. Cobre mensagens que o CRM enviou e gravou SEM messageId (follow-up,
        // boas-vindas, ausência): o eco fromMe chega com messageId próprio, então o match
        // acima falha e, sem isto, a mensagem apareceria DUPLICADA no painel.
        if (!jaRegistrada && texto && String(texto).trim()) {
          const dupC = await query(
            `SELECT 1 FROM movatak_conversas
              WHERE lead_id=$1 AND direcao='saida'
                AND COALESCE(conteudo,'')=COALESCE($2,'')
                AND criado_em > NOW() - INTERVAL '45 seconds' LIMIT 1`,
            [leadFromMe.id, texto || '']
          ).catch(() => ({ rows: [] }));
          jaRegistrada = dupC.rows.length > 0;
        }
        if (!jaRegistrada) {
          const replyFromMe = await resolverReplyInfoLead(leadFromMe.id, null, replyPayload ? replyPayload.reply_to_msg_id : null, replyPayload);
          await registrarConversa(leadFromMe.id, cliente.id, 'saida', texto || '', midiaFromMe.url, midiaFromMe.tipo, msgIdFromMe, replyFromMe.info, 'whatsapp_web').catch(() => null);
          // Mensagem humana (não é comando interno) → o atendente assumiu; limpa o sinal.
          if (!ehComandoInterno) await limparPedidoAtendente(leadFromMe.id);
        } else {
          logDebug('[zapi][fromMe] mensagem já registrada pelo painel, ignorando duplicata');
        }
      }

      if (!ehComandoInterno) {
        logDebug('[zapi][fromMe] mensagem normal registrada no histórico do Kanban');
        return;
      }

      // Eco fromMe de um envio automático do PRÓPRIO CRM (questionário, IA, follow-up,
      // boas-vindas, ausência): jaRegistrada=true significa que já gravamos esse envio.
      // Mesmo que o texto contenha um token de comando — ex.: a intro do questionário
      // que instrui o lead a digitar #ATENDENTE —, NÃO é um comando digitado por um
      // humano. Ignora, senão o bot se auto-pausa. Comando real vem digitado no
      // WhatsApp pelo atendente e não está pré-registrado (jaRegistrada=false).
      if (jaRegistrada) {
        logDebug('[zapi][fromMe] eco de envio automático contém texto de comando — ignorando (não é comando humano)');
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
    const temTexto = !!String(texto || '').trim();
    const midiaRecebida = extrairMidiaPayloadZapi(body);

    if (!temTexto && !midiaRecebida.url) {
      logDebug('[zapi][lead] ignorado: evento sem texto util e sem mídia');
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

    // Gravar mensagem recebida na conversa (agora que o lead está disponível) —
    // cobre texto puro, mídia pura (ex: áudio sem legenda) e mídia com legenda.
    if (lead && (texto || midiaRecebida.url)) {
      const msgIdEntrada = body.messageId || body.id || null;
      const replyEntrada = await resolverReplyInfoLead(lead.id, null, replyPayload ? replyPayload.reply_to_msg_id : null, replyPayload);
      registrarConversa(lead.id, cliente.id, 'entrada', texto || '', midiaRecebida.url, midiaRecebida.tipo, msgIdEntrada, replyEntrada.info).catch(() => null);
    }

    // Sem texto (ex: áudio ou foto sem legenda): já foi registrada acima.
    // Não há comando pra interpretar, então a automação abaixo não se aplica.
    if (!temTexto) {
      return;
    }

    // ===== MENSAGEM DE AUSÊNCIA (lead já existente) =====
    // Toggle da coluna ligado → dispara sempre; senão, por horário. Dedup por período.
    if (lead) {
      await dispararAusenciaSeAplicavel(cliente, lead, telefone);
    }

    // ===== COMANDO: PARAR ATENDIMENTO (cliente pede atendente humano) =====
    // Funciona em qualquer ponto, inclusive durante o questionário.
    // IMPORTANTE: roda ANTES da checagem de automação pausada — mesmo com o lead
    // já pausado (ex: usou o comando antes), repetir o comando deve responder a
    // confirmação de novo, em vez de cair no return silencioso da pausa.
    if (lead && textoBateComandoParar(texto, cliente.questionario_comando_parar)) {
      console.log(`[zapi][comando-parar] lead ${lead.id} usou o comando (ja_pausado=${!!lead.automacao_pausada})`);
      // Roda SEMPRE, mesmo com o lead já pausado: é aqui que o pediu_atendente
      // é ligado, a conversa vira não lida e o socket avisa os painéis (chip 🙋).
      // A função é idempotente — pausar de novo não tem efeito colateral, e o
      // evento repetido no histórico é útil ("lead cobrou atendente de novo").
      await pararAtendimentoLead(cliente.id, lead.id, 'cliente', texto);
      // Confirmação automática pro lead: avisa que um atendente vai falar com ele.
      // Texto configurável no painel (questionario_msg_parar); se vazio, usa o padrão.
      // Enviada com a automação já pausada — o webhook fromMe desta mensagem não
      // dispara nada. Tem dedup interno de 2 min pra comando repetido não spammar.
      await enviarConfirmacaoAtendente(cliente, lead).catch(e => console.error('[zapi][msg-atendente]', e.message));
      return;
    }

    // Se automação pausada manualmente: apenas grava a mensagem, ignora toda lógica de automação.
    // Retomar: vendedor usa o comando de followup ou convertido para reativar.
    if (lead && lead.automacao_pausada) {
      console.log(`[zapi][lead ${lead.id}] automação PAUSADA (pediu_atendente=${!!lead.pediu_atendente}) — mensagem gravada, IA/automação NÃO responde. Reative com o comando de ativar ou followup.`);
      return;
    }

    // ===== MENU DE ATENDIMENTO EM ANDAMENTO (lead escolhendo setor) =====
    // Só age se o cliente tem o menu ativo E existe um estado aguardando para o lead.
    if (lead && cliente.menu_atend_ativo) {
      const estMenu = await query(
        `SELECT * FROM movatak_menu_estado
          WHERE cliente_id = $1 AND lead_id = $2 AND status = 'aguardando'
          ORDER BY id DESC LIMIT 1`,
        [cliente.id, lead.id]
      ).catch(() => ({ rows: [] }));
      if (estMenu.rows.length) {
        await processarRespostaMenu(cliente, lead, estMenu.rows[0], texto);
        return;
      }
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
    let campanhaDetectada = await localizarCampanhaPorGatilho(cliente.id, texto);
    // Fallback por IA: se o gatilho literal não casou, e existe alguma coluna com
    // IA ativa neste cliente, deixa a IA tentar encaixar a mensagem numa campanha.
    if (!campanhaDetectada) {
      const temIA = await query(
        `SELECT 1 FROM movatak_funil_colunas WHERE cliente_id=$1 AND ia_ativa=true AND ativo=true LIMIT 1`,
        [cliente.id]
      ).catch(() => ({ rows: [] }));
      if (temIA.rows.length) {
        campanhaDetectada = await localizarCampanhaPorIA(cliente.id, texto);
      }
    }
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
             SET etapa = 'followup', nome = COALESCE($1, nome), automacao_pausada = false, pediu_atendente = false, atualizado_em = NOW()
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

      // IA automática: se a coluna do lead tem IA ativa, a IA responde sozinha.
      // O texto do lead é passado para as travas transacionais (pré-filtro).
      await iaResponderAutomatico(cliente, lead, texto);
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
        [cliente.id, telefone, extrairNomeContatoPayloadZapi(body, cliente, telefone), chatLid, campanhaDetectada ? campanhaDetectada.id : null, campanhaDetectada ? (campanhaDetectada.template_id || null) : null, campanhaDetectada ? (campanhaDetectada.gatilho || null) : null]
      );
      await registrarEventoLead(novoLead.rows[0].id, cliente.id, 'lead_criado', 'Lead criado pela rota unificada da Z-API', { telefone, chatLid, texto, campanha_id: campanhaDetectada ? campanhaDetectada.id : null });
      // Registra também a primeira mensagem do lead que criou o atendimento.
      // Antes ela ficava fora do histórico porque o lead ainda não existia no momento inicial da busca.
      const midiaNovoLead = extrairMidiaPayloadZapi(body);
      const msgIdNovoLead = body.messageId || body.id || null;
      await registrarConversa(novoLead.rows[0].id, cliente.id, 'entrada', texto || '', midiaNovoLead.url, midiaNovoLead.tipo, msgIdNovoLead, replyPayload).catch(() => null);

      // Decide se inicia o questionário:
      // - Campanha com template de questionário vinculado → usa o questionário do template.
      // - Senão, usa o questionário do cliente (se ativo).
      // A flag questionario_ativo da campanha permite desligar (vai direto ao follow-up).
      const campanhaPermiteQuest = !campanhaDetectada || campanhaDetectada.questionario_ativo !== false;
      const temTemplateQuest = campanhaDetectada && campanhaDetectada.questionario_template_id;
      const deveIniciarQuest = campanhaPermiteQuest && (temTemplateQuest || cliente.questionario_ativo);
      const leadObj = { id: novoLead.rows[0].id, telefone, nome: extrairNomeContatoPayloadZapi(body, cliente, telefone), chat_lid: chatLid, campanha_id: campanhaDetectada ? campanhaDetectada.id : null };

      // PASSO ZERO: Boas-Vindas ao Lead (saudação independente, invisível ao sistema).
      // Enviada antes de qualquer fluxo, se preenchida. Não afeta o follow-up.
      await enviarBoasVindasLead(cliente, telefone);

      // Ausência para lead NOVO (vindo do tráfego): se a coluna de entrada tem o
      // toggle ligado, dispara o aviso de ausência. O delay para chegar após as
      // boas-vindas já está dentro da função dispararAusenciaSeAplicavel.
      await dispararAusenciaSeAplicavel(cliente, { id: novoLead.rows[0].id, funil_coluna_id: null }, telefone);

      // Menu de Atendimento "na entrada": manda as boas-vindas (FU1) e o menu,
      // e PARA aqui — o questionário/follow-up segue só após o lead escolher o setor.
      if (cliente.menu_atend_ativo && cliente.menu_atend_posicao === 'apos_boas_vindas') {
        await agendarFollowupV2(novoLead.rows[0].id, cliente.id, 1, true);
        await enviarFollowupsPendentesDoLead(novoLead.rows[0].id, 1);
        await enviarMenuAtendimento(cliente, leadObj);
        console.log(`[zapi] Novo lead + menu de atendimento (entrada) -> ${telefone} (${cliente.nome})`);
      } else if (deveIniciarQuest) {
        await iniciarQuestionario(cliente, leadObj);
        console.log(`[zapi] Novo lead + questionario iniciado -> ${telefone} (${cliente.nome})`);
      } else {
        await agendarFollowupV2(novoLead.rows[0].id, cliente.id, 1, true);
        await enviarFollowupsPendentesDoLead(novoLead.rows[0].id, 1);
        console.log(`[zapi] Novo lead criado em FU1 -> ${telefone} (${cliente.nome})`);
      }
    } else {
      // Novo contato comum do WhatsApp: não bateu com gatilho de campanha, mas ainda
      // precisa aparecer na caixa de entrada para o CRM espelhar o WhatsApp.
      // Não dispara boas-vindas, questionário nem follow-up.
      const novoContato = await query(
        `INSERT INTO movatak_leads (cliente_id, telefone, nome, etapa, chat_lid, nao_lida, atualizado_em)
         VALUES ($1, $2, $3, 'lead', $4, true, NOW())
         RETURNING id`,
        [cliente.id, telefone, extrairNomeContatoPayloadZapi(body, cliente, telefone), chatLid]
      );
      const midiaNovoContato = extrairMidiaPayloadZapi(body);
      const msgIdNovoContato = body.messageId || body.id || null;
      await registrarConversa(novoContato.rows[0].id, cliente.id, 'entrada', texto || '', midiaNovoContato.url, midiaNovoContato.tipo, msgIdNovoContato, replyPayload).catch(() => null);
      await registrarEventoLead(novoContato.rows[0].id, cliente.id, 'contato_criado_whatsapp', 'Contato comum criado a partir de mensagem recebida no WhatsApp', { telefone, chatLid }).catch(() => null);
      console.log(`[zapi] Novo contato WhatsApp criado sem automação -> ${telefone} (${cliente.nome})`);
    }
  } catch (e) {
    console.error('[zapi] erro processamento:', e.message);
    // Marca o evento bruto como erro (para diagnóstico via /webhook/status). Guardado.
    if (_eventoWebhookId) {
      await query(
        `UPDATE movatak_webhook_eventos SET status='erro', erro=$1, processado_em=NOW() WHERE id=$2`,
        [String(e.message || e).slice(0, 500), _eventoWebhookId]
      ).catch(() => null);
    }
  }
});

// Diagnóstico do webhook Z-API: saúde em segundos, sem expor payload nem dados de lead.
// Sem auth (como /health e /version) — retorna só contadores agregados.
app.get('/movatak/webhook/status', async (req, res) => {
  try {
    const r = await query(`
      SELECT
        COUNT(*) FILTER (WHERE recebido_em > NOW() - INTERVAL '1 hour') AS recebidos_1h,
        COUNT(*) FILTER (WHERE status = 'erro' AND recebido_em > NOW() - INTERVAL '1 hour') AS erros_1h,
        MAX(recebido_em) AS ultimo_recebido,
        MAX(recebido_em) FILTER (WHERE status = 'erro') AS ultimo_erro
      FROM movatak_webhook_eventos
    `);
    res.json({ ok: true, webhook: r.rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
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
app.get('/movatak/admin/clientes/:id/comandos', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const r = await query(
      'SELECT comandos FROM movatak_clientes WHERE id = $1', [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Cliente nao encontrado.' });
    res.json(r.rows[0].comandos || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Atualizar comandos de um cliente
app.patch('/movatak/admin/clientes/:id/comandos', ...forcaClienteIdNaUrl, async (req, res) => {
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

// ============================================================
// Menu de Atendimento — lead escolhe o setor digitando uma opção
// ============================================================

// Ler a configuração do menu de um cliente
app.get('/movatak/admin/clientes/:id/menu-atendimento', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const r = await query(
      `SELECT menu_atend_ativo, menu_atend_texto, menu_atend_posicao, menu_atend_mapa, menu_atend_marcar_nao_lido
         FROM movatak_clientes WHERE id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const row = r.rows[0];
    res.json({
      ativo: !!row.menu_atend_ativo,
      texto: row.menu_atend_texto || '',
      posicao: row.menu_atend_posicao || 'apos_boas_vindas',
      mapa: Array.isArray(row.menu_atend_mapa) ? row.menu_atend_mapa : [],
      marcar_nao_lido: !!row.menu_atend_marcar_nao_lido
    });
  } catch (e) {
    console.error('[menu-atendimento:get]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Salvar a configuração do menu
app.patch('/movatak/admin/clientes/:id/menu-atendimento', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const { ativo, texto, posicao, mapa, marcar_nao_lido } = req.body || {};
    const posicaoValida = ['apos_boas_vindas', 'apos_questionario'].includes(posicao) ? posicao : 'apos_boas_vindas';
    // mapa = lista de { resposta, setor_id, coluna_id }
    const mapaLimpo = Array.isArray(mapa)
      ? mapa
          .filter(m => m && m.resposta != null && String(m.resposta).trim() !== '' && m.setor_id)
          .map(m => ({
            resposta: String(m.resposta).trim().toLowerCase(),
            setor_id: parseInt(m.setor_id),
            coluna_id: m.coluna_id ? parseInt(m.coluna_id) : null,
            template_id: m.template_id ? parseInt(m.template_id) : null
          }))
      : [];

    await query(
      `UPDATE movatak_clientes
          SET menu_atend_ativo = $1,
              menu_atend_texto = $2,
              menu_atend_posicao = $3,
              menu_atend_mapa = $4::jsonb,
              menu_atend_marcar_nao_lido = $5
        WHERE id = $6`,
      [!!ativo, texto || null, posicaoValida, JSON.stringify(mapaLimpo), !!marcar_nao_lido, req.params.id]
    );
    res.json({ ok: true, ativo: !!ativo, texto: texto || '', posicao: posicaoValida, mapa: mapaLimpo, marcar_nao_lido: !!marcar_nao_lido });
  } catch (e) {
    console.error('[menu-atendimento:patch]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Atualizar comando de um vendedor
app.patch('/movatak/admin/vendedores/:id/comando', ...exigeVendedor, async (req, res) => {
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
app.patch('/movatak/admin/vendedores/:id/acesso', ...exigeVendedor, async (req, res) => {
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

// Define os setores que um vendedor acessa (substitui o conjunto atual).
app.patch('/movatak/admin/vendedores/:id/setores', ...exigeVendedor, async (req, res) => {
  try {
    const vendedorId = parseInt(req.params.id, 10);
    const setorIds = Array.isArray(req.body && req.body.setor_ids) ? req.body.setor_ids.map(n => parseInt(n, 10)).filter(Boolean) : [];
    // Confirma que o vendedor existe e pega o cliente, pra só aceitar setores do mesmo cliente.
    const v = await query('SELECT cliente_id FROM movatak_vendedores WHERE id = $1', [vendedorId]);
    if (!v.rows.length) return res.status(404).json({ error: 'Vendedor não encontrado.' });
    const clienteId = v.rows[0].cliente_id;
    // Remove todos os vínculos atuais e recria com os enviados (que sejam do cliente).
    await query('DELETE FROM movatak_setor_vendedores WHERE vendedor_id = $1', [vendedorId]);
    for (const sid of setorIds) {
      const ok = await query('SELECT 1 FROM movatak_setores WHERE id = $1 AND cliente_id = $2 AND COALESCE(ativo,true)=true', [sid, clienteId]);
      if (ok.rows.length) {
        await query('INSERT INTO movatak_setor_vendedores (setor_id, vendedor_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [sid, vendedorId]).catch(() => null);
      }
    }
    res.json({ ok: true, setor_ids: setorIds });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/vendedor/login', async (req, res) => {
  try {
    await garantirColunasVendedoresPortal();
    const { email, senha } = req.body || {};
    if (!email || !senha) return res.status(400).json({ error: 'Informe email e senha.' });
    const r = await query(
      `SELECT v.id, v.cliente_id, v.nome, v.email_acesso, v.acesso_token, c.nome AS cliente_nome
         FROM movatak_vendedores v
         JOIN movatak_clientes c ON c.id = v.cliente_id
        WHERE LOWER(v.email_acesso) = LOWER($1) AND v.senha_hash = $2 AND v.ativo = true AND c.ativo = true
        LIMIT 1`,
      [String(email).trim().toLowerCase(), hashSenha(senha)]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'Acesso inválido.' });
    const vend = r.rows[0];
    // Setores que este vendedor acessa — definem o que ele vê no kanban.
    const setoresR = await query(
      `SELECT s.id, s.nome, s.cor FROM movatak_setor_vendedores sv
         JOIN movatak_setores s ON s.id = sv.setor_id AND COALESCE(s.ativo, true) = true
        WHERE sv.vendedor_id = $1 ORDER BY s.ordem_bot NULLS LAST, s.nome`,
      [vend.id]
    ).catch(() => ({ rows: [] }));
    res.json({
      token: vend.acesso_token,
      vendedor: { id: vend.id, cliente_id: vend.cliente_id, nome: vend.nome, cliente_nome: vend.cliente_nome, setores: setoresR.rows }
    });
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
// FUNIL DO VENDEDOR — escopo restrito aos setores do vendedor logado.
// O controle de acesso é feito AQUI no backend: o vendedor só recebe colunas e
// leads dos setores aos quais ele pertence. Mesmo que o front peça outro setor,
// o servidor recusa.
// ============================================================
app.get('/movatak/vendedor/funil', authVendedor, async (req, res) => {
  try {
    const clienteId = req.vendedor.cliente_id;
    const setorIds = req.vendedor.setorIds || [];
    if (!setorIds.length) {
      return res.json({
        colunas: [],
        colunasVendedores: [],
        leads: [],
        setores: [],
        totalGeral: 0,
        totalNaoLidas: 0,
        semSetor: true
      });
    }

    // Correção definitiva de carregamento do CRM do vendedor:
    // esta rota NÃO executa DDL/template em GET e NÃO busca a última mensagem
    // com LATERAL por lead. Assim a tela não fica presa em "Carregando funil..."
    // quando a tabela de conversas está grande ou o banco está com lock de migração.

    let setoresAlvo = setorIds;
    let setorFiltro = null;
    if (req.query.setor) {
      const pedido = parseInt(req.query.setor, 10);
      if (!setorIds.includes(pedido)) return res.status(403).json({ error: 'Sem acesso a este setor.' });
      setoresAlvo = [pedido];
      setorFiltro = pedido;
    }

    const ph = setoresAlvo.map((_, i) => '$' + (i + 2)).join(',');
    const params = [clienteId, ...setoresAlvo];

    const colunasRes = await query(
      `SELECT id, nome, slug, ordem, cor, etapa_sistema, sincronizar_whatsapp,
              zapi_tag_id, zapi_sync_erro, comando, setor_id, ausencia_ativa, ia_ativa,
              nicho_template, agenda_tipo, agenda_status
         FROM movatak_funil_colunas
        WHERE cliente_id=$1 AND ativo=true AND setor_id IN (${ph})
        ORDER BY ordem ASC, id ASC`,
      params
    );

    const colunas = colunasRes.rows.map(c => ({ ...c, leads: [] }));
    const colById = new Map(colunas.map(c => [Number(c.id), c]));
    const colBySlug = new Map(colunas.map(c => [c.slug, c]));

    const leadsRes = await query(
      `SELECT lb.*, ult.direcao AS ultima_msg_direcao, ult.criado_em AS ultima_msg_em, ult.midia_tipo AS ultima_msg_midia
         FROM (
           SELECT l.id, l.nome, l.telefone, l.etapa, l.funil_coluna_id, l.vendedor_id, l.setor_id,
              COALESCE(l.nao_lida,false) AS nao_lida,
              COALESCE(l.arquivado,false) AS arquivado,
              COALESCE(l.pediu_atendente,false) AS pediu_atendente, l.pediu_atendente_em,
              s.nome AS setor_nome, s.cor AS setor_cor,
              l.criado_em, l.atualizado_em, l.convertido_em, l.prioridade_dispensada_em,
              v.nome AS vendedor_nome,
              p.nome AS plano_nome, p.valor AS plano_valor,
              NULL::text AS ultima_msg,
              0::int AS followups_pendentes,
              NULL::int AS fu_sequencia_ativa
         FROM movatak_leads l
         LEFT JOIN movatak_vendedores v ON v.id = l.vendedor_id
         LEFT JOIN movatak_planos p ON p.id = l.plano_id
         LEFT JOIN movatak_setores s ON s.id = l.setor_id
        WHERE l.cliente_id=$1 AND l.setor_id IN (${ph})
        ORDER BY l.atualizado_em DESC NULLS LAST, l.criado_em DESC
        LIMIT 500
         ) lb
         LEFT JOIN LATERAL (
           SELECT direcao, criado_em, midia_tipo FROM movatak_conversas c
            WHERE c.lead_id = lb.id ORDER BY c.criado_em DESC LIMIT 1
         ) ult ON true`,
      params
    );

    const leadsAtivos = leadsRes.rows.filter(l => !l.arquivado);
    for (const lead of leadsAtivos) {
      let coluna = lead.funil_coluna_id ? colById.get(Number(lead.funil_coluna_id)) : null;
      if (!coluna) coluna = colBySlug.get(slugFunilPorEtapa(lead.etapa));
      if (!coluna) coluna = colunas.find(c => Number(c.setor_id) === Number(lead.setor_id));
      if (!coluna) coluna = colunas[0];
      if (coluna) coluna.leads.push(lead);
    }

    const phTodos = setorIds.map((_, i) => '$' + (i + 2)).join(',');
    const paramsTodos = [clienteId, ...setorIds];

    const clienteInfoRes = await query(
      'SELECT nicho, agenda_ativa FROM movatak_clientes WHERE id=$1',
      [clienteId]
    ).catch(() => ({ rows: [] }));
    const clienteInfo = clienteInfoRes.rows[0] || {};

    const setoresRes = await query(
      `SELECT id, nome, cor FROM movatak_setores
        WHERE cliente_id=$1 AND COALESCE(ativo,true)=true AND id IN (${phTodos})
        ORDER BY ordem_bot ASC, nome ASC`,
      paramsTodos
    );

    const contagemSetoresRes = await query(
      `SELECT setor_id,
              COUNT(*)::int AS cnt,
              COUNT(*) FILTER (WHERE COALESCE(nao_lida,false) = true)::int AS nao_lidas
         FROM movatak_leads
        WHERE cliente_id=$1 AND COALESCE(arquivado,false)=false AND setor_id IN (${phTodos})
        GROUP BY setor_id`,
      paramsTodos
    );

    const contagemPorSetor = new Map(contagemSetoresRes.rows.map(r => [Number(r.setor_id), Number(r.cnt || 0)]));
    const naoLidasPorSetor = new Map(contagemSetoresRes.rows.map(r => [Number(r.setor_id), Number(r.nao_lidas || 0)]));
    const setores = setoresRes.rows.map(s => ({
      ...s,
      leads_count: contagemPorSetor.get(Number(s.id)) || 0,
      nao_lidas: naoLidasPorSetor.get(Number(s.id)) || 0
    }));

    const totalGeral = contagemSetoresRes.rows.reduce((acc, r) => acc + Number(r.cnt || 0), 0);
    const totalNaoLidas = contagemSetoresRes.rows.reduce((acc, r) => acc + Number(r.nao_lidas || 0), 0);

    res.json({
      colunas,
      colunasVendedores: [],
      setores,
      setorAtivo: setorFiltro,
      totalGeral,
      totalNaoLidas,
      nicho: clienteInfo.nicho || null,
      agenda_ativa: !!clienteInfo.agenda_ativa,
      leads: leadsRes.rows
    });
  } catch (e) {
    console.error('[vendedor/funil]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/movatak/vendedor/funil/metricas', authVendedor, async (req, res) => {
  try {
    const clienteId = req.vendedor.cliente_id;
    const setorIds = req.vendedor.setorIds || [];
    if (!setorIds.length) return res.json({ totalLeads: 0, novasMensagens: 0, emNegociacao: 0, conversaoMes: 0 });
    let setoresAlvo = setorIds;
    if (req.query.setor) {
      const pedido = parseInt(req.query.setor, 10);
      if (!setorIds.includes(pedido)) return res.status(403).json({ error: 'Sem acesso a este setor.' });
      setoresAlvo = [pedido];
    }
    const ph = setoresAlvo.map((_, i) => '$' + (i + 2)).join(',');
    const params = [clienteId, ...setoresAlvo];
    const totaisR = await query(
      `SELECT COUNT(*)::int AS total_leads,
              COUNT(*) FILTER (WHERE l.nao_lida = true)::int AS novas_mensagens,
              COUNT(*) FILTER (WHERE l.criado_em >= date_trunc('month', now()))::int AS criados_mes,
              COUNT(*) FILTER (WHERE l.convertido_em >= date_trunc('month', now()))::int AS convertidos_mes
         FROM movatak_leads l
        WHERE l.cliente_id=$1 AND COALESCE(l.arquivado,false)=false AND l.setor_id IN (${ph})`,
      params
    );
    const negociacaoR = await query(
      `SELECT COUNT(*)::int AS n
         FROM movatak_leads l
         LEFT JOIN movatak_funil_colunas c ON c.id = l.funil_coluna_id
        WHERE l.cliente_id=$1 AND COALESCE(l.arquivado,false)=false AND l.setor_id IN (${ph})
          AND COALESCE(c.etapa_sistema, l.etapa) = 'negociacao'`,
      params
    );
    const t = totaisR.rows[0] || {};
    const conversaoMes = t.criados_mes > 0 ? Math.round((t.convertidos_mes / t.criados_mes) * 100) : 0;
    res.json({ totalLeads: t.total_leads || 0, novasMensagens: t.novas_mensagens || 0, emNegociacao: (negociacaoR.rows[0] || {}).n || 0, conversaoMes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Conversa de um lead — só se o lead estiver num setor do vendedor.
app.get('/movatak/vendedor/leads/:id/conversas', authVendedor, async (req, res) => {
  try {
    const lead = await vendedorPodeLead(req, req.params.id);
    if (!lead) return res.status(403).json({ error: 'Sem acesso a este lead.' });
    const r = await query(
      `SELECT * FROM (
         SELECT id, direcao, conteudo, midia_url, midia_tipo, msg_id,
                reply_to_conversa_id, reply_to_msg_id, reply_to_direcao, reply_to_conteudo,
                reply_to_midia_url, reply_to_midia_tipo, msg_status, msg_status_em, criado_em, 'banco' AS fonte
           FROM movatak_conversas WHERE lead_id = $1
           ORDER BY criado_em DESC LIMIT 500
       ) sub ORDER BY criado_em ASC`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Enviar mensagem pelo vendedor — só se o lead for de um setor dele.
app.post('/movatak/vendedor/leads/:id/mensagem', authVendedor, async (req, res) => {
  try {
    const lead = await vendedorPodeLead(req, req.params.id);
    if (!lead) return res.status(403).json({ error: 'Sem acesso a este lead.' });
    const { texto, mensagem, midia_url, midia_tipo, reply_to_conversa_id, reply_to_msg_id } = req.body || {};
    const conteudo = String(texto ?? mensagem ?? '').trim();
    if (!conteudo && !midia_url) return res.status(400).json({ error: 'Texto ou mídia obrigatório.' });
    const cli = await query('SELECT zapi_instance, zapi_token, zapi_client_token FROM movatak_clientes WHERE id=$1', [lead.cliente_id]);
    const c = cli.rows[0] || {};
    if (!c.zapi_instance || !c.zapi_token || !c.zapi_client_token) return res.status(400).json({ error: 'Z-API não configurada para este cliente.' });
    const replyResolvido = await resolverReplyInfoLead(lead.id, reply_to_conversa_id, reply_to_msg_id, null);
    const replyMsgIdZap = replyResolvido.msgId || null;
    let tipoFinal = null, msgId = null;
    if (midia_url) {
      tipoFinal = tipoMidia(midia_url, midia_tipo);
      if (tipoFinal === 'video') msgId = await zapiEnviarVideo(c.zapi_instance, c.zapi_token, c.zapi_client_token, lead.telefone, midia_url, conteudo || '', replyMsgIdZap);
      else if (tipoFinal === 'audio') msgId = await zapiEnviarAudio(c.zapi_instance, c.zapi_token, c.zapi_client_token, lead.telefone, midia_url, replyMsgIdZap);
      else msgId = await zapiEnviarImagem(c.zapi_instance, c.zapi_token, c.zapi_client_token, lead.telefone, midia_url, conteudo || '', replyMsgIdZap);
    } else {
      msgId = await zapiEnviar(c.zapi_instance, c.zapi_token, c.zapi_client_token, lead.telefone, conteudo, replyMsgIdZap);
    }
    const conversaId = await registrarConversa(lead.id, lead.cliente_id, 'saida', conteudo || '', midia_url || null, tipoFinal, msgId, replyResolvido.info).catch(() => null);
    await registrarEventoLead(lead.id, lead.cliente_id, 'mensagem_vendedor', 'Mensagem enviada pelo vendedor ' + req.vendedor.nome, { texto: (conteudo || '').slice(0,100), midia: !!midia_url });
    emitirMensagemLead(lead.cliente_id, lead.id, { id: conversaId, lead_id: lead.id, cliente_id: lead.cliente_id, direcao: 'saida', conteudo: conteudo || '', midia_url: midia_url || null, midia_tipo: tipoFinal, msg_id: msgId, criado_em: new Date().toISOString() });
    res.json({ ok: true, conversaId, criado_em: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
});

app.post('/movatak/vendedor/leads/:id/mensagem-kanban', authVendedor, async (req, res, next) => {
  req.body = { ...(req.body || {}), texto: (req.body && (req.body.texto ?? req.body.mensagem)) || '' };
  next();
}, async (req, res) => {
  try {
    const lead = await vendedorPodeLead(req, req.params.id);
    if (!lead) return res.status(403).json({ error: 'Sem acesso a este lead.' });
    const { texto, midia_url } = req.body || {};
    if (!texto && !midia_url) return res.status(400).json({ error: 'Texto ou mídia obrigatório.' });
    const cli = await query('SELECT zapi_instance, zapi_token, zapi_client_token FROM movatak_clientes WHERE id=$1', [lead.cliente_id]);
    const c = cli.rows[0] || {};
    let tipoFinal = null, msgId = null;
    if (midia_url) {
      tipoFinal = tipoMidia(midia_url);
      if (tipoFinal === 'video') msgId = await zapiEnviarVideo(c.zapi_instance, c.zapi_token, c.zapi_client_token, lead.telefone, midia_url, texto || '');
      else if (tipoFinal === 'audio') msgId = await zapiEnviarAudio(c.zapi_instance, c.zapi_token, c.zapi_client_token, lead.telefone, midia_url);
      else msgId = await zapiEnviarImagem(c.zapi_instance, c.zapi_token, c.zapi_client_token, lead.telefone, midia_url, texto || '');
    } else {
      msgId = await zapiEnviar(c.zapi_instance, c.zapi_token, c.zapi_client_token, lead.telefone, texto);
    }
    const conversaId = await registrarConversa(lead.id, lead.cliente_id, 'saida', texto || '', midia_url || null, tipoFinal, msgId).catch(() => null);
    await registrarEventoLead(lead.id, lead.cliente_id, 'mensagem_manual_kanban', 'Mensagem enviada pelo vendedor no kanban', { vendedor_id: req.vendedor.id, texto: (texto||'').slice(0,100), midia: !!midia_url });
    await limparPedidoAtendente(lead.id);
    res.json({ ok: true, conversaId });
  } catch (e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
});

app.post('/movatak/vendedor/leads/:id/mensagem-rapida', authVendedor, async (req, res) => {
  try {
    const lead = await vendedorPodeLead(req, req.params.id);
    if (!lead) return res.status(403).json({ error: 'Sem acesso a este lead.' });
    const { texto, midia_url, midia_tipo, reply_to_conversa_id, reply_to_msg_id } = req.body || {};
    if (!texto && !midia_url) return res.status(400).json({ error: 'Texto ou mídia obrigatório.' });
    const cli = await query('SELECT zapi_instance, zapi_token, zapi_client_token FROM movatak_clientes WHERE id=$1', [lead.cliente_id]);
    const c = cli.rows[0] || {};
    const replyResolvido = await resolverReplyInfoLead(lead.id, reply_to_conversa_id, reply_to_msg_id, null);
    const replyMsgIdZap = replyResolvido.msgId || null;
    let tipoFinal = null, msgId = null;
    if (midia_url) {
      tipoFinal = tipoMidia(midia_url, midia_tipo);
      if (tipoFinal === 'video') msgId = await zapiEnviarVideo(c.zapi_instance, c.zapi_token, c.zapi_client_token, lead.telefone, midia_url, texto || '', replyMsgIdZap);
      else if (tipoFinal === 'audio') msgId = await zapiEnviarAudio(c.zapi_instance, c.zapi_token, c.zapi_client_token, lead.telefone, midia_url, replyMsgIdZap);
      else msgId = await zapiEnviarImagem(c.zapi_instance, c.zapi_token, c.zapi_client_token, lead.telefone, midia_url, texto || '', replyMsgIdZap);
    } else {
      msgId = await zapiEnviar(c.zapi_instance, c.zapi_token, c.zapi_client_token, lead.telefone, texto, replyMsgIdZap);
    }
    const conversaId = await registrarConversa(lead.id, lead.cliente_id, 'saida', texto || '', midia_url || null, tipoFinal, msgId, replyResolvido.info).catch(() => null);
    if (texto) query('UPDATE movatak_mensagens_rapidas SET vezes_usado = COALESCE(vezes_usado,0)+1 WHERE cliente_id=$1 AND texto=$2', [lead.cliente_id, texto]).catch(() => null);
    await registrarEventoLead(lead.id, lead.cliente_id, 'mensagem_rapida_vendedor', 'Mensagem rápida enviada pelo vendedor', { vendedor_id: req.vendedor.id, midia: !!midia_url });
    res.json({ ok: true, conversaId, criado_em: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
});

// Mover lead entre colunas (dentro do escopo do vendedor) e marcar lido/não lido.
app.patch('/movatak/vendedor/leads/:id/coluna', authVendedor, async (req, res) => {
  try {
    const lead = await vendedorPodeLead(req, req.params.id);
    if (!lead) return res.status(403).json({ error: 'Sem acesso a este lead.' });
    const colunaId = parseInt(req.body && req.body.coluna_id, 10);
    if (!colunaId) return res.status(400).json({ error: 'coluna_id obrigatório.' });
    // A coluna destino precisa ser de um setor do vendedor.
    const col = await query('SELECT setor_id FROM movatak_funil_colunas WHERE id=$1 AND cliente_id=$2 AND ativo=true', [colunaId, lead.cliente_id]);
    if (!col.rows.length || !vendedorPodeSetor(req, col.rows[0].setor_id)) return res.status(403).json({ error: 'Coluna fora do seu acesso.' });
    await moverLeadParaColunaFunil(lead.id, colunaId).catch(() => null);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


async function vendedorPodeConversa(req, conversaId) {
  const r = await query(
    `SELECT cv.*, l.setor_id, l.telefone, c.zapi_instance, c.zapi_token, c.zapi_client_token
       FROM movatak_conversas cv
       JOIN movatak_leads l ON l.id = cv.lead_id
       JOIN movatak_clientes c ON c.id = cv.cliente_id
      WHERE cv.id = $1 AND cv.cliente_id = $2`,
    [conversaId, req.vendedor.cliente_id]
  ).catch(() => ({ rows: [] }));
  const msg = r.rows[0] || null;
  if (!msg || !vendedorPodeSetor(req, msg.setor_id)) return null;
  return msg;
}

async function vendedorPodeColuna(req, colunaId) {
  const r = await query(
    'SELECT id, cliente_id, setor_id, nome FROM movatak_funil_colunas WHERE id=$1 AND cliente_id=$2 AND ativo=true',
    [colunaId, req.vendedor.cliente_id]
  ).catch(() => ({ rows: [] }));
  const col = r.rows[0] || null;
  if (!col || !vendedorPodeSetor(req, col.setor_id)) return null;
  return col;
}

app.patch('/movatak/vendedor/leads/:id/marcar-lida', authVendedor, async (req, res) => {
  try {
    const lead = await vendedorPodeLead(req, req.params.id);
    if (!lead) return res.status(403).json({ error: 'Sem acesso a este lead.' });
    const naoLida = !!(req.body && req.body.nao_lida);
    const upd = await query(`UPDATE movatak_leads SET nao_lida = $1 WHERE id = $2 AND nao_lida IS DISTINCT FROM $1 RETURNING id`, [naoLida, lead.id]);
    // Reflete no WhatsApp só quando REALMENTE mudou de não-lido -> lido.
    if (!naoLida && upd.rows.length) marcarChatLidoNoZap(lead.id);
    res.json({ ok: true, nao_lida: naoLida });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/vendedor/leads/:id/arquivar', authVendedor, async (req, res) => {
  try {
    const lead = await vendedorPodeLead(req, req.params.id);
    if (!lead) return res.status(403).json({ error: 'Sem acesso a este lead.' });
    const arquivado = req.body && typeof req.body.arquivado === 'boolean' ? req.body.arquivado : true;
    await query(`UPDATE movatak_leads SET arquivado=$1, atualizado_em=NOW() WHERE id=$2`, [arquivado, lead.id]);
    res.json({ ok: true, arquivado });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/vendedor/leads/:id/setor', authVendedor, async (req, res) => {
  try {
    const lead = await vendedorPodeLead(req, req.params.id);
    if (!lead) return res.status(403).json({ error: 'Sem acesso a este lead.' });
    const setorDestinoId = parseInt(req.body && req.body.setor_id, 10);
    if (!setorDestinoId || !vendedorPodeSetor(req, setorDestinoId)) return res.status(403).json({ error: 'Setor fora do seu acesso.' });
    const colunaR = await query(
      `SELECT id, nome FROM movatak_funil_colunas
        WHERE cliente_id=$1 AND setor_id=$2 AND ativo=true
        ORDER BY ordem ASC, id ASC LIMIT 1`,
      [lead.cliente_id, setorDestinoId]
    );
    const colunaDestino = colunaR.rows[0] || null;
    await query(`UPDATE movatak_leads SET setor_id=$1, funil_coluna_id=COALESCE($2, funil_coluna_id), atualizado_em=NOW() WHERE id=$3`, [setorDestinoId, colunaDestino ? colunaDestino.id : null, lead.id]);
    await registrarEventoLead(lead.id, lead.cliente_id, 'transferencia_setor_vendedor', 'Atendimento transferido pelo vendedor', { setor_destino_id: setorDestinoId, coluna_destino_id: colunaDestino ? colunaDestino.id : null, vendedor_id: req.vendedor.id }).catch(() => null);
    res.json({ ok: true, setor_id: setorDestinoId, coluna_destino: colunaDestino ? colunaDestino.nome : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/vendedor/leads/:id/historico', authVendedor, async (req, res) => {
  try {
    const acesso = await vendedorPodeLead(req, req.params.id);
    if (!acesso) return res.status(403).json({ error: 'Sem acesso a este lead.' });
    const lead = await query(
      `SELECT l.*, c.nome AS cliente_nome, v.nome AS vendedor_nome
         FROM movatak_leads l
         JOIN movatak_clientes c ON c.id = l.cliente_id
         LEFT JOIN movatak_vendedores v ON v.id = l.vendedor_id
        WHERE l.id = $1`,
      [acesso.id]
    );
    const eventos = await query(`SELECT id, tipo, descricao, dados, criado_em FROM movatak_lead_eventos WHERE lead_id=$1 ORDER BY criado_em DESC LIMIT 100`, [acesso.id]).catch(() => ({ rows: [] }));
    const fila = await query(
      `SELECT id, etapa_seq, COALESCE(sequencia_fu, 1) AS sequencia_fu, proximo_envio,
              status, data_entrada, enviado_em, tentativas_envio, erro_envio
         FROM movatak_followup
        WHERE lead_id = $1
        ORDER BY proximo_envio DESC
        LIMIT 100`,
      [acesso.id]
    ).catch(() => ({ rows: [] }));
    res.json({ lead: lead.rows[0], eventos: eventos.rows, fila: fila.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/movatak/vendedor/conversas/:id', authVendedor, async (req, res) => {
  try {
    const msg = await vendedorPodeConversa(req, req.params.id);
    if (!msg) return res.status(403).json({ error: 'Sem acesso a esta mensagem.' });
    let apagadaNoZap = false;
    let avisoZap = null;
    if (msg.direcao === 'saida' && msg.msg_id) {
      try { await zapiApagarMensagem(msg.zapi_instance, msg.zapi_token, msg.zapi_client_token, msg.telefone, msg.msg_id); apagadaNoZap = true; }
      catch (e) { avisoZap = e.response?.data?.error || e.response?.data?.message || e.message; }
    } else if (msg.direcao === 'entrada') {
      avisoZap = 'Mensagem recebida do lead — não é possível apagar do lado dele, só do seu painel.';
    }
    await query('DELETE FROM movatak_conversas WHERE id=$1', [msg.id]);
    emitirMensagemApagada(msg.cliente_id, msg.lead_id, Number(msg.id));
    res.json({ ok: true, apagadaNoZap, avisoZap });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/vendedor/conversas/:id/reagir', authVendedor, async (req, res) => {
  try {
    const { reaction } = req.body || {};
    if (!reaction) return res.status(400).json({ error: 'Informe o emoji da reação.' });
    const msg = await vendedorPodeConversa(req, req.params.id);
    if (!msg) return res.status(403).json({ error: 'Sem acesso a esta mensagem.' });
    if (!msg.msg_id) return res.status(400).json({ error: 'Mensagem sem messageId do WhatsApp.' });
    const data = await zapiReagirMensagem(msg.zapi_instance, msg.zapi_token, msg.zapi_client_token, msg.telefone, msg.msg_id, reaction);
    await registrarEventoLead(msg.lead_id, msg.cliente_id, 'whatsapp_reacao', 'Reação enviada pelo vendedor no CRM', { conversa_id: msg.id, reaction, vendedor_id: req.vendedor.id });
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
});

app.post('/movatak/vendedor/conversas/:id/encaminhar', authVendedor, async (req, res) => {
  try {
    const { destino } = req.body || {};
    if (!destino) return res.status(400).json({ error: 'Informe o destino.' });
    const msg = await vendedorPodeConversa(req, req.params.id);
    if (!msg) return res.status(403).json({ error: 'Sem acesso a esta mensagem.' });
    if (!msg.msg_id) return res.status(400).json({ error: 'Mensagem sem messageId do WhatsApp.' });
    const data = await zapiEncaminharMensagem(msg.zapi_instance, msg.zapi_token, msg.zapi_client_token, String(destino).replace(/\D/g, ''), msg.msg_id, msg.telefone);
    await registrarEventoLead(msg.lead_id, msg.cliente_id, 'whatsapp_encaminhamento', 'Mensagem encaminhada pelo vendedor no CRM', { conversa_id: msg.id, destino, vendedor_id: req.vendedor.id });
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
});

app.post('/movatak/vendedor/conversas/:id/marcar-lida-zap', authVendedor, async (req, res) => {
  try {
    const msg = await vendedorPodeConversa(req, req.params.id);
    if (!msg) return res.status(403).json({ error: 'Sem acesso a esta mensagem.' });
    if (!msg.msg_id) return res.status(400).json({ error: 'Mensagem sem messageId do WhatsApp.' });
    const data = await zapiLerMensagem(msg.zapi_instance, msg.zapi_token, msg.zapi_client_token, msg.telefone, msg.msg_id);
    await query(`UPDATE movatak_conversas SET msg_status='read', msg_status_em=NOW() WHERE id=$1`, [msg.id]).catch(() => null);
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
});

app.post('/movatak/vendedor/conversas/:id/editar', authVendedor, async (req, res) => {
  try {
    const { texto } = req.body || {};
    if (!String(texto || '').trim()) return res.status(400).json({ error: 'Informe o novo texto.' });
    const msg = await vendedorPodeConversa(req, req.params.id);
    if (!msg) return res.status(403).json({ error: 'Sem acesso a esta mensagem.' });
    if (msg.direcao !== 'saida') return res.status(400).json({ error: 'Só é possível editar mensagens enviadas.' });
    if (!msg.msg_id) return res.status(400).json({ error: 'Mensagem sem messageId do WhatsApp.' });
    const data = await zapiEditarTexto(msg.zapi_instance, msg.zapi_token, msg.zapi_client_token, msg.telefone, msg.msg_id, texto);
    await query(`UPDATE movatak_conversas SET conteudo=$1 WHERE id=$2`, [texto, msg.id]);
    await registrarEventoLead(msg.lead_id, msg.cliente_id, 'whatsapp_edicao', 'Mensagem editada pelo vendedor no CRM', { conversa_id: msg.id, vendedor_id: req.vendedor.id });
    emitirMensagemLead(msg.cliente_id, msg.lead_id, { ...msg, conteudo: texto, editada: true });
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
});

app.post('/movatak/vendedor/leads/:id/zapi/chat-action', authVendedor, async (req, res) => {
  try {
    const { action } = req.body || {};
    const allowed = ['read','unread','pin','unpin','mute','unmute','archive','unarchive'];
    if (!allowed.includes(action)) return res.status(400).json({ error: 'Ação inválida.' });
    const lead = await vendedorPodeLead(req, req.params.id);
    if (!lead) return res.status(403).json({ error: 'Sem acesso a este lead.' });
    const z = await query('SELECT zapi_instance, zapi_token, zapi_client_token FROM movatak_clientes WHERE id=$1', [lead.cliente_id]);
    const c = z.rows[0] || {};
    let data;
    if (action === 'archive' || action === 'unarchive') {
      const url = `${ZAPI_BASE}/${c.zapi_instance}/token/${c.zapi_token}/archive-chat`;
      const resp = await axios.post(url, { phone: lead.telefone, archive: action === 'archive' }, { headers: zapiHeaders(c.zapi_client_token) });
      data = resp.data || {};
      await query(`UPDATE movatak_leads SET arquivado=$1 WHERE id=$2`, [action === 'archive', lead.id]).catch(() => null);
    } else {
      data = await zapiModificarChat(c.zapi_instance, c.zapi_token, c.zapi_client_token, lead.telefone, action);
      if (action === 'read') await query(`UPDATE movatak_leads SET nao_lida=false WHERE id=$1`, [lead.id]).catch(() => null);
      if (action === 'unread') await query(`UPDATE movatak_leads SET nao_lida=true WHERE id=$1`, [lead.id]).catch(() => null);
    }
    await registrarEventoLead(lead.id, lead.cliente_id, 'whatsapp_chat_action', 'Ação de chat executada pelo vendedor', { action, vendedor_id: req.vendedor.id });
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
});

app.post('/movatak/vendedor/leads/:id/zapi/send-advanced', authVendedor, async (req, res) => {
  try {
    const lead = await vendedorPodeLead(req, req.params.id);
    if (!lead) return res.status(403).json({ error: 'Sem acesso a este lead.' });
    const { recurso, payload, reply_to_conversa_id, reply_to_msg_id } = req.body || {};
    if (!recurso || !ZAPI_ADVANCED_ENDPOINTS[recurso]) return res.status(400).json({ error: 'Recurso inválido.' });
    const z = await query('SELECT zapi_instance, zapi_token, zapi_client_token FROM movatak_clientes WHERE id=$1', [lead.cliente_id]);
    const c = z.rows[0] || {};
    const p = limparPayloadAvancado(payload || {});
    const replyResolvido = await resolverReplyInfoLead(lead.id, reply_to_conversa_id, reply_to_msg_id, null);
    const replyMsgIdZap = replyResolvido.msgId || null;
    let msgId = null, conteudo = '', midiaUrl = null, midiaTipo = recurso;
    if (recurso === 'document') {
      msgId = await zapiEnviarDocumento(c.zapi_instance, c.zapi_token, c.zapi_client_token, lead.telefone, p.document || p.documentUrl || p.url, p.fileName || p.filename || 'arquivo.pdf', p.caption || p.message || '', p.extension || p.ext || 'pdf', replyMsgIdZap);
      conteudo = p.caption || p.message || 'Documento enviado';
      midiaUrl = p.document || p.documentUrl || p.url || null;
      midiaTipo = 'documento';
    } else if (recurso === 'link') {
      msgId = await zapiEnviarLink(c.zapi_instance, c.zapi_token, c.zapi_client_token, lead.telefone, p.linkUrl || p.url, p.message || '', p.title || '', p.image || '', replyMsgIdZap);
      conteudo = p.message || p.title || p.linkUrl || p.url || 'Link enviado';
    } else if (recurso === 'location') {
      msgId = await zapiEnviarLocalizacao(c.zapi_instance, c.zapi_token, c.zapi_client_token, lead.telefone, p.title || 'Localização', p.address || '', p.latitude, p.longitude, replyMsgIdZap);
      conteudo = p.title || p.address || 'Localização enviada';
    } else if (recurso === 'contact') {
      msgId = await zapiEnviarContato(c.zapi_instance, c.zapi_token, c.zapi_client_token, lead.telefone, p.contactName || p.name || 'Contato', p.contactPhone || p.phone, !!p.contactBusiness, replyMsgIdZap);
      conteudo = p.contactName || p.name || 'Contato enviado';
    } else {
      const payloadFinal = montarPayloadRespostaZapi({ phone: lead.telefone, ...p }, replyMsgIdZap);
      const data = await zapiPost(c.zapi_instance, c.zapi_token, c.zapi_client_token, ZAPI_ADVANCED_ENDPOINTS[recurso], payloadFinal);
      msgId = data.messageId || data.id || data.zaapId || null;
      conteudo = p.message || p.text || p.caption || p.title || ('Recurso enviado: ' + recurso);
      midiaUrl = p.image || p.video || p.gif || p.sticker || null;
    }
    const conversaId = await registrarConversa(lead.id, lead.cliente_id, 'saida', conteudo || '', midiaUrl || null, midiaTipo, msgId, replyResolvido.info).catch(() => null);
    await registrarEventoLead(lead.id, lead.cliente_id, 'whatsapp_recurso_avancado', 'Recurso avançado enviado pelo vendedor', { recurso, conversaId, vendedor_id: req.vendedor.id });
    res.json({ ok: true, conversaId, messageId: msgId, criado_em: new Date().toISOString() });
  } catch(e) { res.status(500).json({ error: e.response?.data?.message || JSON.stringify(e.response?.data || {}) || e.message }); }
});

app.get('/movatak/vendedor/mensagens-rapidas', authVendedor, async (req, res) => {
  try {
    await garantirEstruturaMensagensRapidas();
    const r = await query('SELECT id, titulo, texto, midia_url, vezes_usado, ordem, itens, template_id FROM movatak_mensagens_rapidas WHERE cliente_id=$1 ORDER BY vezes_usado DESC, ordem ASC, id ASC', [req.vendedor.cliente_id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/vendedor/mensagens-rapidas', authVendedor, async (req, res) => {
  try {
    await garantirEstruturaMensagensRapidas();
    const { titulo, texto, midia_url, itens, template_id } = req.body || {};
    const sequencia = Array.isArray(itens) ? itens.filter(it => it && (it.texto || it.midia_url)) : [];
    if (!titulo) return res.status(400).json({ error: 'Título obrigatório.' });
    if (!sequencia.length && !texto) return res.status(400).json({ error: 'Texto obrigatório.' });
    const textoFinal = sequencia.length ? (texto || sequencia.map(it => it.texto || '').filter(Boolean).join(' ')).trim().slice(0,500) || titulo.trim() : texto.trim();
    const r = await query('INSERT INTO movatak_mensagens_rapidas (cliente_id, titulo, texto, midia_url, itens, template_id) VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING id, titulo, texto, midia_url, ordem, itens, template_id', [req.vendedor.cliente_id, titulo.trim(), textoFinal, sequencia.length ? null : (midia_url || null), JSON.stringify(sequencia), template_id ? parseInt(template_id,10) : null]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/vendedor/mensagens-rapidas/:id', authVendedor, async (req, res) => {
  try {
    const { titulo, texto, midia_url, itens } = req.body || {};
    await query(`UPDATE movatak_mensagens_rapidas SET titulo=COALESCE($1,titulo), texto=COALESCE($2,texto), midia_url=CASE WHEN $3::text IS NULL THEN midia_url ELSE $3 END, itens=CASE WHEN $4::jsonb IS NULL THEN itens ELSE $4::jsonb END WHERE id=$5 AND cliente_id=$6`, [titulo || null, texto || null, midia_url !== undefined ? (midia_url || null) : null, Array.isArray(itens) ? JSON.stringify(itens) : null, req.params.id, req.vendedor.cliente_id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/movatak/vendedor/mensagens-rapidas/:id', authVendedor, async (req, res) => {
  try { await query('DELETE FROM movatak_mensagens_rapidas WHERE id=$1 AND cliente_id=$2', [req.params.id, req.vendedor.cliente_id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/vendedor/mensagens-rapidas/:id/usar', authVendedor, async (req, res) => {
  try { await query('UPDATE movatak_mensagens_rapidas SET vezes_usado=COALESCE(vezes_usado,0)+1 WHERE id=$1 AND cliente_id=$2', [req.params.id, req.vendedor.cliente_id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/vendedor/upload-imagem', authVendedor, async (req, res) => {
  try {
    const dataUrl = (req.body && req.body.dataUrl) || '';
    const m = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)(?:;[^;,]+)*;base64,(.+)$/i.exec(dataUrl);
    const TIPOS_PERMITIDOS = ['image/png','image/jpeg','image/jpg','image/webp','video/mp4','video/webm','video/quicktime','audio/webm','audio/ogg','audio/mpeg','audio/mp4','audio/wav','audio/x-m4a','audio/aac'];
    const contentType = m ? m[1].toLowerCase() : '';
    if (!m || !TIPOS_PERMITIDOS.includes(contentType)) return res.status(400).json({ error: 'Arquivo inválido. Envie imagem, vídeo ou áudio.' });
    const ehVideo = contentType.startsWith('video/');
    const ehAudio = contentType.startsWith('audio/');
    const tipo = ehVideo ? 'video' : (ehAudio ? 'audio' : 'imagem');
    const extMap = { 'image/png':'png','image/jpeg':'jpg','image/jpg':'jpg','image/webp':'webp','video/mp4':'mp4','video/webm':'webm','video/quicktime':'mov','audio/webm':'webm','audio/ogg':'ogg','audio/mpeg':'mp3','audio/mp4':'m4a','audio/wav':'wav','audio/x-m4a':'m4a','audio/aac':'aac' };
    const ext = extMap[contentType] || (ehVideo ? 'mp4' : (ehAudio ? 'webm' : 'jpg'));
    const buffer = Buffer.from(m[2], 'base64');
    const limite = ehVideo ? 20 * 1024 * 1024 : 8 * 1024 * 1024;
    if (buffer.length > limite) return res.status(413).json({ error: ehVideo ? 'Vídeo muito grande (máx 20MB).' : 'Arquivo muito grande (máx 8MB).' });
    const url = await uploadSupabase(buffer, contentType, ext);
    res.json({ ok: true, url, tipo });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/vendedor/agendamentos', authVendedor, async (req, res) => {
  try {
    await garantirEstruturaAgenda();
    const setorIds = req.vendedor.setorIds || [];
    if (!setorIds.length) return res.json([]);
    const dias = Math.max(1, Math.min(parseInt(req.query.dias || '30', 10), 120));
    const ph = setorIds.map((_, i) => '$' + (i + 3)).join(',');
    const r = await query(
      `SELECT a.*, l.nome AS lead_nome, l.telefone AS lead_telefone, c.nome AS coluna_nome
         FROM movatak_agendamentos a
         LEFT JOIN movatak_leads l ON l.id = a.lead_id
         LEFT JOIN movatak_funil_colunas c ON c.id = a.funil_coluna_id
        WHERE a.cliente_id=$1
          AND (a.lead_id IS NULL OR l.setor_id IN (${ph}))
          AND a.inicio >= NOW() - INTERVAL '1 day'
          AND a.inicio <= NOW() + ($2 || ' days')::INTERVAL
        ORDER BY a.inicio ASC LIMIT 200`,
      [req.vendedor.cliente_id, dias, ...setorIds]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/vendedor/agendamentos', authVendedor, async (req, res) => {
  try {
    await garantirEstruturaAgenda();
    const clienteId = req.vendedor.cliente_id;
    const { lead_id, titulo, tipo, inicio, fim, status, observacao, coluna_id, mover_kanban } = req.body || {};
    if (!titulo || !inicio) return res.status(400).json({ error: 'Título e data/horário são obrigatórios.' });
    if (lead_id) {
      const lead = await vendedorPodeLead(req, lead_id);
      if (!lead) return res.status(403).json({ error: 'Sem acesso a este lead.' });
    }
    let colunaDestino = null;
    if (coluna_id) {
      const col = await vendedorPodeColuna(req, coluna_id);
      if (!col) return res.status(403).json({ error: 'Coluna fora do seu acesso.' });
      colunaDestino = col.id;
    } else {
      const tipoNormTmp = String(tipo || 'atendimento').trim().toLowerCase();
      colunaDestino = await buscarColunaAgenda(clienteId, tipoNormTmp, null).catch(() => null);
      if (colunaDestino) {
        const col = await vendedorPodeColuna(req, colunaDestino);
        if (!col) colunaDestino = null;
      }
    }
    const tipoNorm = String(tipo || 'atendimento').trim().toLowerCase();
    if (await conflitoAgenda(clienteId, inicio, colunaDestino, null)) {
      return res.status(409).json({ error: 'Já existe um agendamento neste horário nesta coluna. Escolha outro horário ou outra coluna.' });
    }
    const ins = await query(`INSERT INTO movatak_agendamentos (cliente_id, lead_id, titulo, tipo, status, inicio, fim, observacao, funil_coluna_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [clienteId, lead_id || null, titulo, tipoNorm, status || 'agendado', inicio, fim || null, observacao || null, colunaDestino]);
    if (lead_id && colunaDestino && mover_kanban !== false) {
      await moverLeadParaColunaFunil(lead_id, colunaDestino, true).catch(() => null);
      await registrarEventoLead(lead_id, clienteId, 'agendamento_criado', 'Agendamento criado pelo vendedor e lead movido no kanban', { agendamento_id: ins.rows[0].id, tipo: tipoNorm, inicio, coluna_id: colunaDestino, vendedor_id: req.vendedor.id }).catch(() => null);
    }
    res.json({ ok: true, agendamento: ins.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function vendedorPodeAgendamento(req, agendamentoId) {
  const r = await query(`SELECT a.*, l.setor_id FROM movatak_agendamentos a LEFT JOIN movatak_leads l ON l.id=a.lead_id WHERE a.id=$1 AND a.cliente_id=$2`, [agendamentoId, req.vendedor.cliente_id]).catch(() => ({ rows: [] }));
  const ag = r.rows[0] || null;
  if (!ag) return null;
  if (ag.lead_id && !vendedorPodeSetor(req, ag.setor_id)) return null;
  return ag;
}

app.patch('/movatak/vendedor/agendamentos/:id/status', authVendedor, async (req, res) => {
  try {
    await garantirEstruturaAgenda();
    const { status, mover_para_coluna_id } = req.body || {};
    if (!status) return res.status(400).json({ error: 'Informe o status.' });
    const agPerm = await vendedorPodeAgendamento(req, req.params.id);
    if (!agPerm) return res.status(403).json({ error: 'Sem acesso a este agendamento.' });
    const r = await query(`UPDATE movatak_agendamentos SET status=$1, atualizado_em=NOW() WHERE id=$2 RETURNING *`, [status, req.params.id]);
    const ag = r.rows[0];
    let leadMovido = false;
    if (mover_para_coluna_id && ag.lead_id) {
      const col = await vendedorPodeColuna(req, mover_para_coluna_id);
      if (col) {
        await moverLeadParaColunaFunil(ag.lead_id, mover_para_coluna_id).catch(() => null);
        await registrarEventoLead(ag.lead_id, ag.cliente_id, 'agenda_status', `Agendamento "${ag.titulo || ''}" → ${status}`, { agendamento_id: ag.id, status, vendedor_id: req.vendedor.id }).catch(() => null);
        leadMovido = true;
      }
    }
    res.json({ ok: true, agendamento: ag, lead_movido: leadMovido });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/vendedor/agendamentos/:id', authVendedor, async (req, res) => {
  try {
    await garantirEstruturaAgenda();
    const agPerm = await vendedorPodeAgendamento(req, req.params.id);
    if (!agPerm) return res.status(403).json({ error: 'Sem acesso a este agendamento.' });
    const { status, observacao, inicio, fim, funil_coluna_id } = req.body || {};
    let colId = funil_coluna_id || null;
    if (colId) {
      const col = await vendedorPodeColuna(req, colId);
      if (!col) return res.status(403).json({ error: 'Coluna fora do seu acesso.' });
    }
    const r = await query(`UPDATE movatak_agendamentos SET status=COALESCE($1,status), observacao=CASE WHEN $2::text IS NULL THEN observacao ELSE $2 END, inicio=COALESCE($3::timestamptz,inicio), fim=COALESCE($4::timestamptz,fim), funil_coluna_id=COALESCE($5,funil_coluna_id), atualizado_em=NOW() WHERE id=$6 RETURNING *`, [status || null, observacao !== undefined ? observacao : null, inicio || null, fim || null, colId, req.params.id]);
    res.json({ ok: true, agendamento: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/movatak/vendedor/agendamentos/:id', authVendedor, async (req, res) => {
  try {
    await garantirEstruturaAgenda();
    const ag = await vendedorPodeAgendamento(req, req.params.id);
    if (!ag) return res.status(403).json({ error: 'Sem acesso a este agendamento.' });
    await query(`DELETE FROM movatak_agendamentos WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/vendedor/funil/colunas', authVendedor, async (req, res) => {
  try {
    // Não inicializa template em ação do vendedor; evita lock/DDL durante atendimento.
    const nome = String((req.body && req.body.nome) || '').trim();
    if (!nome) return res.status(400).json({ error: 'Informe o nome da etapa.' });
    const setorId = req.body && req.body.setor_id ? parseInt(req.body.setor_id, 10) : (req.vendedor.setorIds || [])[0];
    if (!setorId || !vendedorPodeSetor(req, setorId)) return res.status(403).json({ error: 'Setor fora do seu acesso.' });
    const slugBase = slugifyFunil(nome);
    const ordemR = await query('SELECT COALESCE(MAX(ordem),0)+1 AS ordem FROM movatak_funil_colunas WHERE cliente_id=$1', [req.vendedor.cliente_id]);
    const etapa = etapaSistemaPorSlug(slugBase);
    const ins = await query(`INSERT INTO movatak_funil_colunas (cliente_id, nome, slug, ordem, etapa_sistema, sincronizar_whatsapp, setor_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [req.vendedor.cliente_id, nome, slugBase, ordemR.rows[0].ordem, etapa, req.body?.sincronizar_whatsapp !== false, setorId]);
    res.json({ ok: true, coluna: ins.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/vendedor/funil/colunas/:id', authVendedor, async (req, res) => {
  try {
    await garantirEstruturaFunil();
    const col = await vendedorPodeColuna(req, req.params.id);
    if (!col) return res.status(403).json({ error: 'Coluna fora do seu acesso.' });
    const { nome, ordem, ativo, cor, comando } = req.body || {};
    const r = await query(`UPDATE movatak_funil_colunas SET nome=COALESCE($1,nome), ordem=COALESCE($2,ordem), ativo=COALESCE($3,ativo), cor=CASE WHEN $5::text IS NULL THEN cor ELSE $5 END, comando=CASE WHEN $6::text IS NULL THEN comando ELSE NULLIF($6,'') END, atualizado_em=NOW() WHERE id=$4 RETURNING *`, [nome || null, Number.isFinite(Number(ordem)) ? Number(ordem) : null, typeof ativo === 'boolean' ? ativo : null, col.id, cor !== undefined ? (cor || null) : null, comando !== undefined ? String(comando).trim() : null]);
    res.json({ ok: true, coluna: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/vendedor/funil/colunas/:id/setor', authVendedor, async (req, res) => {
  try {
    const col = await vendedorPodeColuna(req, req.params.id);
    if (!col) return res.status(403).json({ error: 'Coluna fora do seu acesso.' });
    const setorId = req.body && req.body.setor_id ? parseInt(req.body.setor_id, 10) : null;
    if (!setorId || !vendedorPodeSetor(req, setorId)) return res.status(403).json({ error: 'Setor fora do seu acesso.' });
    const r = await query('UPDATE movatak_funil_colunas SET setor_id=$1, atualizado_em=NOW() WHERE id=$2 RETURNING *', [setorId, col.id]);
    res.json({ ok: true, coluna: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/vendedor/funil/colunas/:id/ausencia', authVendedor, async (req, res) => {
  try {
    const col = await vendedorPodeColuna(req, req.params.id);
    if (!col) return res.status(403).json({ error: 'Coluna fora do seu acesso.' });
    const ativa = !!(req.body && req.body.ausencia_ativa);
    const r = await query('UPDATE movatak_funil_colunas SET ausencia_ativa=$1, atualizado_em=NOW() WHERE id=$2 RETURNING *', [ativa, col.id]);
    res.json({ ok: true, coluna: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/movatak/vendedor/funil/colunas/:id', authVendedor, async (req, res) => {
  try {
    const col = await vendedorPodeColuna(req, req.params.id);
    if (!col) return res.status(403).json({ error: 'Coluna fora do seu acesso.' });
    const { confirmar, destino_coluna_id } = req.body || {};
    if (!confirmar) return res.status(400).json({ error: 'Confirmação obrigatória para excluir a coluna.' });
    const dest = await vendedorPodeColuna(req, destino_coluna_id);
    if (!dest || Number(dest.id) === Number(col.id)) return res.status(400).json({ error: 'Coluna de destino inválida.' });
    const leadsR = await query('SELECT id FROM movatak_leads WHERE funil_coluna_id=$1 AND cliente_id=$2', [col.id, req.vendedor.cliente_id]);
    if (leadsR.rows.length) await query('UPDATE movatak_leads SET funil_coluna_id=$1, atualizado_em=NOW() WHERE funil_coluna_id=$2 AND cliente_id=$3', [dest.id, col.id, req.vendedor.cliente_id]);
    await query('UPDATE movatak_funil_colunas SET ativo=false, atualizado_em=NOW() WHERE id=$1', [col.id]);
    res.json({ ok: true, leads_realocados: leadsR.rows.length, destino_coluna_id: dest.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/vendedor/funil/colunas/reordenar', authVendedor, async (req, res) => {
  try {
    const ordem = Array.isArray(req.body?.ordem) ? req.body.ordem : null;
    if (!ordem || !ordem.length) return res.status(400).json({ error: 'Envie ordem: [ids...] na sequência desejada.' });
    let pos = 1;
    for (const colId of ordem) {
      const col = await vendedorPodeColuna(req, colId);
      if (!col) continue;
      await query('UPDATE movatak_funil_colunas SET ordem=$1, atualizado_em=NOW() WHERE id=$2', [pos, col.id]).catch(() => null);
      pos++;
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/vendedor/funil/colunas/:id/sincronizar-whatsapp', authVendedor, async (req, res) => {
  try {
    const col = await vendedorPodeColuna(req, req.params.id);
    if (!col) return res.status(403).json({ error: 'Coluna fora do seu acesso.' });
    const tagId = await sincronizarColunaComWhatsapp(col.id);
    res.json({ ok: true, zapi_tag_id: tagId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/vendedor/leads/:id/reativar-followup', authVendedor, async (req, res) => {
  try {
    const lead = await vendedorPodeLead(req, req.params.id);
    if (!lead) return res.status(403).json({ error: 'Sem acesso a este lead.' });
    await query(`UPDATE movatak_leads SET etapa='followup', atualizado_em=NOW() WHERE id=$1`, [lead.id]);
    await agendarFollowupV2(lead.id, lead.cliente_id, 1, true);
    await enviarFollowupsPendentesDoLead(lead.id, 1);
    await registrarEventoLead(lead.id, lead.cliente_id, 'followup_reativado', 'Follow-up reativado manualmente pelo vendedor', { vendedor_id: req.vendedor.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// Operações extras do CRM do vendedor — mesmas ações da tela do admin,
// sempre limitadas aos setores liberados para o vendedor logado.
app.get('/movatak/vendedor/questionario-templates', authVendedor, async (req, res) => {
  try {
    await garantirEstruturaQuestionario();
    const r = await query(
      `SELECT id, nome, criado_em, atualizado_em,
              COALESCE(jsonb_array_length(passos), 0) AS qtd_passos
         FROM movatak_questionario_templates
        WHERE cliente_id = $1 AND ativo = true
        ORDER BY criado_em DESC`,
      [req.vendedor.cliente_id]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/vendedor/questionario-templates/:tid', authVendedor, async (req, res) => {
  try {
    await garantirEstruturaQuestionario();
    const r = await query(
      `SELECT * FROM movatak_questionario_templates WHERE id = $1 AND cliente_id = $2 AND ativo = true`,
      [req.params.tid, req.vendedor.cliente_id]
    );
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

app.patch('/movatak/vendedor/leads/:id/cliente', authVendedor, async (req, res) => {
  try {
    const lead = await vendedorPodeLead(req, req.params.id);
    if (!lead) return res.status(403).json({ error: 'Sem acesso a este lead.' });
    await query(`UPDATE movatak_leads SET etapa='cliente', convertido_em=NOW(), atualizado_em=NOW() WHERE id=$1`, [lead.id]);
    await query(`UPDATE movatak_followup SET status='pausado' WHERE lead_id=$1 AND status='pendente'`, [lead.id]);
    await registrarEventoLead(lead.id, lead.cliente_id, 'cliente_manual', 'Lead marcado como cliente pelo vendedor', { vendedor_id: req.vendedor.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/vendedor/leads/:id/descartar', authVendedor, async (req, res) => {
  try {
    const lead = await vendedorPodeLead(req, req.params.id);
    if (!lead) return res.status(403).json({ error: 'Sem acesso a este lead.' });
    await query(`UPDATE movatak_leads SET etapa='descartado', atualizado_em=NOW() WHERE id=$1`, [lead.id]);
    await query(`UPDATE movatak_followup SET status='pausado' WHERE lead_id=$1 AND status='pendente'`, [lead.id]);
    await registrarEventoLead(lead.id, lead.cliente_id, 'descartado_manual', 'Lead descartado pelo vendedor', { vendedor_id: req.vendedor.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/vendedor/leads/:id/followup/pausar', authVendedor, async (req, res) => {
  try {
    const lead = await vendedorPodeLead(req, req.params.id);
    if (!lead) return res.status(403).json({ error: 'Sem acesso a este lead.' });
    await query(`UPDATE movatak_leads SET etapa='lead', atualizado_em=NOW() WHERE id=$1`, [lead.id]);
    await query(`UPDATE movatak_followup SET status='pausado' WHERE lead_id=$1 AND status='pendente'`, [lead.id]);
    await registrarEventoLead(lead.id, lead.cliente_id, 'followup_pausado_manual', 'Follow-up pausado pelo vendedor', { vendedor_id: req.vendedor.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/vendedor/leads/:id/followup/reativar', authVendedor, async (req, res) => {
  try {
    const lead = await vendedorPodeLead(req, req.params.id);
    if (!lead) return res.status(403).json({ error: 'Sem acesso a este lead.' });
    const sequencia = parseInt(req.body && req.body.sequencia_fu ? req.body.sequencia_fu : 2, 10);
    const enviarImediato = !!(req.body && req.body.enviar_imediato);
    if (![1, 2].includes(sequencia)) return res.status(400).json({ error: 'sequencia_fu deve ser 1 ou 2.' });
    await query(`UPDATE movatak_leads SET etapa='followup', atualizado_em=NOW() WHERE id=$1`, [lead.id]);
    await agendarFollowupV2(lead.id, lead.cliente_id, sequencia, true);
    await registrarEventoLead(lead.id, lead.cliente_id, 'followup_reativado_manual', `Follow-up FU${sequencia} reativado pelo vendedor`, { vendedor_id: req.vendedor.id, enviar_imediato: enviarImediato });
    if (enviarImediato) await enviarFollowupsPendentesDoLead(lead.id, sequencia);
    res.json({ ok: true, sequencia_fu: sequencia });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/vendedor/leads/:id/iniciar-autoatendimento', authVendedor, async (req, res) => {
  try {
    const leadPerm = await vendedorPodeLead(req, req.params.id);
    if (!leadPerm) return res.status(403).json({ error: 'Sem acesso a este lead.' });
    const templateId = req.body && req.body.template_id ? parseInt(req.body.template_id, 10) : null;
    if (!templateId) return res.status(400).json({ error: 'template_id é obrigatório.' });
    const tpl = await query('SELECT id FROM movatak_questionario_templates WHERE id=$1 AND cliente_id=$2 AND ativo=true', [templateId, req.vendedor.cliente_id]);
    if (!tpl.rows.length) return res.status(404).json({ error: 'Template não encontrado para este cliente.' });
    await query('UPDATE movatak_leads SET automacao_pausada=false, pediu_atendente=false WHERE id=$1', [leadPerm.id]).catch(() => null);
    const leadRow = await query('SELECT * FROM movatak_leads WHERE id=$1 AND cliente_id=$2', [leadPerm.id, req.vendedor.cliente_id]);
    const cliRow = await query('SELECT * FROM movatak_clientes WHERE id=$1', [req.vendedor.cliente_id]);
    const lead = leadRow.rows[0];
    const cliente = cliRow.rows[0];
    if (!lead || !cliente) return res.status(404).json({ error: 'Lead ou cliente não encontrado.' });
    await query(
      `UPDATE movatak_questionario_estado SET status='cancelado', atualizado_em=NOW()
        WHERE cliente_id=$1 AND telefone=$2 AND status IN ('em_andamento','aguardando')`,
      [cliente.id, lead.telefone]
    ).catch(() => null);
    await iniciarQuestionarioPorTemplate(cliente, lead, templateId);
    await registrarEventoLead(lead.id, cliente.id, 'autoatendimento_manual', 'Autoatendimento iniciado pelo vendedor', { template_id: templateId, vendedor_id: req.vendedor.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/movatak/vendedor/leads/:id', authVendedor, async (req, res) => {
  try {
    const lead = await vendedorPodeLead(req, req.params.id);
    if (!lead) return res.status(403).json({ error: 'Sem acesso a este lead.' });
    const leadId = lead.id;
    await query('DELETE FROM movatak_conversas WHERE lead_id=$1', [leadId]).catch(() => null);
    await query('DELETE FROM movatak_followup WHERE lead_id=$1', [leadId]).catch(() => null);
    await query('DELETE FROM movatak_lead_eventos WHERE lead_id=$1', [leadId]).catch(() => null);
    await query('DELETE FROM movatak_mensagens WHERE lead_id=$1', [leadId]).catch(() => null);
    await query('DELETE FROM movatak_menu_estado WHERE lead_id=$1', [leadId]).catch(() => null);
    await query('DELETE FROM movatak_questionario_estado WHERE lead_id=$1', [leadId]).catch(() => null);
    await query('DELETE FROM movatak_leads WHERE id=$1 AND cliente_id=$2', [leadId, req.vendedor.cliente_id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ============================================================
// API — Resumo de um cliente (cards do topo do dashboard)
// ============================================================
app.get('/movatak/admin/clientes/:id/resumo', ...forcaClienteIdNaUrl, async (req, res) => {
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
app.get('/movatak/admin/clientes/:id/operacao', ...forcaClienteIdNaUrl, async (req, res) => {
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

app.get('/movatak/admin/clientes/:id/fila-followup', ...forcaClienteIdNaUrl, async (req, res) => {
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

app.patch('/movatak/admin/leads/:id/followup/pausar', ...exigeLead, async (req, res) => {
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

app.patch('/movatak/admin/leads/:id/followup/reativar', ...exigeLead, async (req, res) => {
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
app.get('/movatak/admin/leads/:id/conversas', ...exigeLead, async (req, res) => {
  try {
    await garantirEstruturaConversas();
    // Fonte única da verdade: o banco. Pegamos as 500 mensagens MAIS RECENTES
    // (ORDER BY ... DESC) e depois reordenamos em ordem cronológica para exibir.
    // ⚠️ Antes era ORDER BY criado_em ASC LIMIT 500 — isso pegava as 500 mais ANTIGAS,
    // e em leads com +500 mensagens as recém-enviadas caíam fora do limite e sumiam da tela.
    const r = await query(
      `SELECT * FROM (
         SELECT id, direcao, conteudo, midia_url, midia_tipo, msg_id,
                reply_to_conversa_id, reply_to_msg_id, reply_to_direcao, reply_to_conteudo,
                reply_to_midia_url, reply_to_midia_tipo, msg_status, msg_status_em, criado_em, 'banco' AS fonte
           FROM movatak_conversas WHERE lead_id = $1
           ORDER BY criado_em DESC LIMIT 500
       ) sub ORDER BY criado_em ASC`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// [refatoracao 3c] chamarHaiku() -> src/ia.js

// Gera uma sugestão de resposta para o lead, imitando o estilo das respostas
// anteriores do próprio atendente (puxadas do histórico de conversas).
// Transcreve um áudio (URL pública) para texto usando a API Whisper da OpenAI.
// Requer OPENAI_API_KEY no ambiente.
app.post('/movatak/admin/transcrever-audio', authMovatakOuApp, async (req, res) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(400).json({ error: 'Transcrição não configurada (falta OPENAI_API_KEY).' });
    const url = (req.body && req.body.url) ? String(req.body.url) : '';
    if (!url || !/^https?:\/\//.test(url)) return res.status(400).json({ error: 'URL de áudio inválida.' });

    // Baixa o áudio da URL pública (Supabase/Z-API).
    const audioResp = await fetch(url);
    if (!audioResp.ok) return res.status(502).json({ error: 'Não foi possível baixar o áudio.' });
    const audioBuffer = Buffer.from(await audioResp.arrayBuffer());
    if (audioBuffer.length > 24 * 1024 * 1024) return res.status(413).json({ error: 'Áudio muito grande para transcrever.' });

    // Monta multipart/form-data para o Whisper.
    const nomeArq = (url.split('/').pop() || 'audio.ogg').split('?')[0] || 'audio.ogg';
    const form = new FormData();
    form.append('file', new Blob([audioBuffer]), nomeArq);
    form.append('model', 'whisper-1');
    form.append('language', 'pt');

    const wResp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey },
      body: form
    });
    if (!wResp.ok) {
      // Loga o detalhe técnico para você, mas mostra mensagem amigável ao usuário.
      const detalhe = await wResp.text().catch(() => '');
      console.error('[transcricao] OpenAI ' + wResp.status + ': ' + detalhe.slice(0, 200));
      let amigavel = 'Transcrição temporariamente indisponível. Tente novamente em instantes.';
      if (wResp.status === 429) amigavel = 'Transcrição temporariamente indisponível.';
      else if (wResp.status === 401) amigavel = 'Transcrição indisponível (configuração).';
      else if (wResp.status === 413) amigavel = 'Áudio muito longo para transcrever.';
      return res.status(502).json({ error: amigavel });
    }
    const data = await wResp.json();
    const texto = (data.text || '').trim();
    if (!texto) return res.status(502).json({ error: 'Não foi possível transcrever este áudio.' });
    res.json({ texto });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Dispensa o lead das prioridades. Ele só reaparece se mandar nova mensagem
// (mensagem com data posterior à dispensa).
app.post('/movatak/admin/leads/:id/dispensar-prioridade', ...exigeLead, async (req, res) => {
  try {
    const r = await query(
      'UPDATE movatak_leads SET prioridade_dispensada_em = NOW() WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Resumo da conversa do lead por IA — para o vendedor entender o contexto rápido.
app.get('/movatak/admin/leads/:id/resumo-ia', ...exigeLead, async (req, res) => {
  try {
    await garantirEstruturaConversas();
    const leadId = req.params.id;
    const convR = await query(
      `SELECT * FROM (
         SELECT direcao, conteudo, criado_em FROM movatak_conversas
          WHERE lead_id = $1 AND conteudo IS NOT NULL AND conteudo <> ''
          ORDER BY criado_em DESC LIMIT 40
       ) sub ORDER BY criado_em ASC`,
      [leadId]
    );
    if (!convR.rows.length) return res.json({ ok: true, resumo: 'Ainda não há mensagens nesta conversa para resumir.' });
    const conversaTxt = convR.rows.map(m =>
      (m.direcao === 'entrada' ? 'CLIENTE: ' : 'ATENDENTE: ') + (m.conteudo || '')
    ).join('\n');
    const systemPrompt =
      'Você resume conversas de atendimento no WhatsApp para um vendedor que vai assumir o atendimento. ' +
      'Faça um resumo curto e objetivo em português brasileiro, em no máximo 5 tópicos curtos, cobrindo: o que o cliente quer, ' +
      'dúvidas ou objeções levantadas, o que já foi respondido e qual o próximo passo pendente. ' +
      'Não invente informação que não esteja na conversa; se algo não apareceu, não cite. Sem saudação nem despedida.';
    const userPrompt = 'CONVERSA:\n' + conversaTxt + '\n\nResumo:';
    const resumo = await chamarHaiku(systemPrompt, userPrompt);
    if (!resumo) return res.status(502).json({ error: 'A IA não retornou resumo. Tente novamente.' });
    res.json({ ok: true, resumo });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// [refatoracao 3c] gerarRespostaIALead() -> src/ia.js

app.get('/movatak/admin/leads/:id/sugerir-resposta', ...exigeLead, async (req, res) => {
  try {
    const r = await gerarRespostaIALead(req.params.id);
    if (r.erro) return res.status(r.erro.includes('não retornou') ? 502 : 400).json({ error: r.erro });
    res.json({ sugestao: r.sugestao });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// [refatoracao 3c] enviarComPausasHumanas() -> src/ia.js

// [refatoracao 3c] _normalizarTextoTrava() -> src/ia.js

// [refatoracao 3c] assuntoExigeHumano() -> src/ia.js

// [refatoracao 3c] respostaIAViolaTravas() -> src/ia.js

// [refatoracao 3c] transferirIAParaHumano() -> src/ia.js

// [refatoracao 3c] iaResponderAutomatico() -> src/ia.js

// (delete for everyone, só funciona pra mensagens que a gente mandou e dentro
// da janela de tempo que o WhatsApp permite) e remove do nosso histórico de
// qualquer forma, pra não ficar uma mensagem "travada" caso o lado do WhatsApp falhe.
app.delete('/movatak/admin/conversas/:id', ...exigeConversa, async (req, res) => {
  try {
    const r = await query(
      `SELECT cv.*, l.telefone, c.zapi_instance, c.zapi_token, c.zapi_client_token
         FROM movatak_conversas cv
         JOIN movatak_leads l ON l.id = cv.lead_id
         JOIN movatak_clientes c ON c.id = cv.cliente_id
        WHERE cv.id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Mensagem não encontrada.' });
    const msg = r.rows[0];

    let apagadaNoZap = false;
    let avisoZap = null;
    if (msg.direcao === 'saida' && msg.msg_id) {
      try {
        await zapiApagarMensagem(msg.zapi_instance, msg.zapi_token, msg.zapi_client_token, msg.telefone, msg.msg_id);
        apagadaNoZap = true;
      } catch (e) {
        avisoZap = e.response?.data?.error || e.response?.data?.message || e.message;
        console.warn('[conversas][apagar] falha ao apagar no WhatsApp. status:', e.response?.status, 'body:', JSON.stringify(e.response?.data || {}), 'msgId usado:', msg.msg_id);
      }
    } else if (msg.direcao === 'entrada') {
      avisoZap = 'Mensagem recebida do lead — não é possível apagar do lado dele, só do seu painel.';
    } else {
      avisoZap = 'Esta mensagem foi enviada antes desse recurso existir, sem referência pra apagar no WhatsApp.';
    }

    await query('DELETE FROM movatak_conversas WHERE id = $1', [req.params.id]);
    emitirMensagemApagada(msg.cliente_id, msg.lead_id, Number(req.params.id));
    res.json({ ok: true, apagadaNoZap, avisoZap });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ============================================================
// Z-API — recursos avançados de WhatsApp no CRM
// ============================================================
async function obterLeadComZapi(leadId) {
  const r = await query(
    `SELECT l.id, l.nome, l.telefone, l.cliente_id,
            c.zapi_instance, c.zapi_token, c.zapi_client_token
       FROM movatak_leads l
       JOIN movatak_clientes c ON c.id = l.cliente_id
      WHERE l.id = $1`,
    [leadId]
  );
  return r.rows[0] || null;
}

async function obterMensagemComZapi(conversaId) {
  const r = await query(
    `SELECT cv.*, l.telefone, c.zapi_instance, c.zapi_token, c.zapi_client_token
       FROM movatak_conversas cv
       JOIN movatak_leads l ON l.id = cv.lead_id
       JOIN movatak_clientes c ON c.id = cv.cliente_id
      WHERE cv.id = $1`,
    [conversaId]
  );
  return r.rows[0] || null;
}

app.post('/movatak/admin/conversas/:id/reagir', ...exigeConversa, async (req, res) => {
  try {
    const { reaction } = req.body || {};
    if (!reaction) return res.status(400).json({ error: 'Informe o emoji da reação.' });
    const msg = await obterMensagemComZapi(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Mensagem não encontrada.' });
    if (!msg.msg_id) return res.status(400).json({ error: 'Mensagem sem messageId do WhatsApp.' });
    const data = await zapiReagirMensagem(msg.zapi_instance, msg.zapi_token, msg.zapi_client_token, msg.telefone, msg.msg_id, reaction);
    await registrarEventoLead(msg.lead_id, msg.cliente_id, 'whatsapp_reacao', 'Reação enviada pelo CRM', { conversa_id: msg.id, reaction });
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
});

app.post('/movatak/admin/conversas/:id/encaminhar', ...exigeConversa, async (req, res) => {
  try {
    const { destino } = req.body || {};
    if (!destino) return res.status(400).json({ error: 'Informe o destino.' });
    const msg = await obterMensagemComZapi(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Mensagem não encontrada.' });
    if (!msg.msg_id) return res.status(400).json({ error: 'Mensagem sem messageId do WhatsApp.' });
    const data = await zapiEncaminharMensagem(msg.zapi_instance, msg.zapi_token, msg.zapi_client_token, String(destino).replace(/\D/g, ''), msg.msg_id, msg.telefone);
    await registrarEventoLead(msg.lead_id, msg.cliente_id, 'whatsapp_encaminhamento', 'Mensagem encaminhada pelo CRM', { conversa_id: msg.id, destino });
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
});

app.post('/movatak/admin/conversas/:id/marcar-lida-zap', ...exigeConversa, async (req, res) => {
  try {
    const msg = await obterMensagemComZapi(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Mensagem não encontrada.' });
    if (!msg.msg_id) return res.status(400).json({ error: 'Mensagem sem messageId do WhatsApp.' });
    const data = await zapiLerMensagem(msg.zapi_instance, msg.zapi_token, msg.zapi_client_token, msg.telefone, msg.msg_id);
    await query(`UPDATE movatak_conversas SET msg_status='read', msg_status_em=NOW() WHERE id=$1`, [msg.id]).catch(() => null);
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
});

app.post('/movatak/admin/conversas/:id/editar', ...exigeConversa, async (req, res) => {
  try {
    const { texto } = req.body || {};
    if (!String(texto || '').trim()) return res.status(400).json({ error: 'Informe o novo texto.' });
    const msg = await obterMensagemComZapi(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Mensagem não encontrada.' });
    if (msg.direcao !== 'saida') return res.status(400).json({ error: 'Só é possível editar mensagens enviadas pelo CRM/WhatsApp.' });
    if (!msg.msg_id) return res.status(400).json({ error: 'Mensagem sem messageId do WhatsApp.' });
    const data = await zapiEditarTexto(msg.zapi_instance, msg.zapi_token, msg.zapi_client_token, msg.telefone, msg.msg_id, texto);
    await query(`UPDATE movatak_conversas SET conteudo=$1 WHERE id=$2`, [texto, msg.id]);
    await registrarEventoLead(msg.lead_id, msg.cliente_id, 'whatsapp_edicao', 'Mensagem editada pelo CRM', { conversa_id: msg.id });
    emitirMensagemLead(msg.cliente_id, msg.lead_id, { ...msg, conteudo: texto, editada: true });
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
});

app.post('/movatak/admin/leads/:id/zapi/chat-action', ...exigeLead, async (req, res) => {
  try {
    const { action } = req.body || {};
    const allowed = ['read','unread','pin','unpin','mute','unmute','archive','unarchive'];
    if (!allowed.includes(action)) return res.status(400).json({ error: 'Ação inválida.' });
    const lead = await obterLeadComZapi(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado.' });
    let data;
    if (action === 'archive' || action === 'unarchive') {
      const url = `${ZAPI_BASE}/${lead.zapi_instance}/token/${lead.zapi_token}/archive-chat`;
      const resp = await axios.post(url, { phone: lead.telefone, archive: action === 'archive' }, { headers: zapiHeaders(lead.zapi_client_token) });
      data = resp.data || {};
      await query(`UPDATE movatak_leads SET arquivado=$1 WHERE id=$2`, [action === 'archive', lead.id]).catch(() => null);
    } else {
      data = await zapiModificarChat(lead.zapi_instance, lead.zapi_token, lead.zapi_client_token, lead.telefone, action);
      if (action === 'read') await query(`UPDATE movatak_leads SET nao_lida=false WHERE id=$1`, [lead.id]).catch(() => null);
      if (action === 'unread') await query(`UPDATE movatak_leads SET nao_lida=true WHERE id=$1`, [lead.id]).catch(() => null);
    }
    await registrarEventoLead(lead.id, lead.cliente_id, 'whatsapp_chat_action', 'Ação aplicada no chat do WhatsApp', { action });
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
});

app.post('/movatak/admin/leads/:id/zapi/send-advanced', ...exigeLead, async (req, res) => {
  try {
    const { recurso, payload, reply_to_conversa_id, reply_to_msg_id } = req.body || {};
    const lead = await obterLeadComZapi(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado.' });
    const replyResolvido = await resolverReplyInfoLead(lead.id, reply_to_conversa_id, reply_to_msg_id, null);
    const replyMsgIdZap = replyResolvido.msgId || null;
    const p = payload || {};
    let msgId = null;
    let conteudo = '';
    let midiaUrl = null;
    let midiaTipo = null;

    if (recurso === 'document') {
      msgId = await zapiEnviarDocumento(lead.zapi_instance, lead.zapi_token, lead.zapi_client_token, lead.telefone, p.document || p.url, p.fileName || p.nome, p.caption || '', p.extension || p.ext, replyMsgIdZap);
      conteudo = p.caption || p.fileName || 'Documento enviado'; midiaUrl = p.document || p.url; midiaTipo = 'documento';
    } else if (recurso === 'location') {
      msgId = await zapiEnviarLocalizacao(lead.zapi_instance, lead.zapi_token, lead.zapi_client_token, lead.telefone, p.title, p.address, p.latitude, p.longitude, replyMsgIdZap);
      conteudo = `Localização: ${p.title || ''}`.trim(); midiaTipo = 'localizacao';
    } else if (recurso === 'link') {
      msgId = await zapiEnviarLink(lead.zapi_instance, lead.zapi_token, lead.zapi_client_token, lead.telefone, p.linkUrl || p.url, p.message || p.texto || '', p.title || '', p.image || '', replyMsgIdZap);
      conteudo = p.message || p.texto || p.linkUrl || p.url || 'Link enviado'; midiaUrl = p.linkUrl || p.url || null; midiaTipo = 'link';
    } else if (recurso === 'contact') {
      msgId = await zapiEnviarContato(lead.zapi_instance, lead.zapi_token, lead.zapi_client_token, lead.telefone, p.contactName || p.nome, p.contactPhone || p.telefone, !!p.contactBusiness, replyMsgIdZap);
      conteudo = `Contato: ${p.contactName || p.nome || ''}`.trim(); midiaTipo = 'contato';
    } else {
      const endpoint = ZAPI_ADVANCED_ENDPOINTS[recurso];
      if (!endpoint) return res.status(400).json({ error: 'Recurso não liberado ou não reconhecido.' });
      const clean = limparPayloadAvancado(p);
      clean.phone = lead.telefone;
      if (replyMsgIdZap) clean.messageId = replyMsgIdZap;
      const data = await zapiPost(lead.zapi_instance, lead.zapi_token, lead.zapi_client_token, endpoint, clean);
      msgId = data.messageId || data.id || data.zaapId || null;
      conteudo = p.message || p.text || p.caption || p.title || ('Recurso enviado: ' + recurso);
      midiaUrl = p.image || p.video || p.gif || p.sticker || null;
      midiaTipo = recurso;
    }
    const conversaId = await registrarConversa(lead.id, lead.cliente_id, 'saida', conteudo || '', midiaUrl || null, midiaTipo || recurso, msgId, replyResolvido.info).catch(() => null);
    await registrarEventoLead(lead.id, lead.cliente_id, 'whatsapp_recurso_avancado', 'Recurso avançado enviado pelo CRM', { recurso, conversaId });
    res.json({ ok: true, conversaId, messageId: msgId, criado_em: new Date().toISOString() });
  } catch(e) { res.status(500).json({ error: e.response?.data?.message || JSON.stringify(e.response?.data || {}) || e.message }); }
});

app.get('/movatak/admin/clientes/:id/zapi/chats', authMovatak, async (req, res) => {
  try {
    const c = await query('SELECT id, zapi_instance, zapi_token, zapi_client_token FROM movatak_clientes WHERE id=$1', [req.params.id]);
    if (!c.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const cli = c.rows[0];
    const data = await zapiListarChats(cli.zapi_instance, cli.zapi_token, cli.zapi_client_token);
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
});

app.post('/movatak/admin/clientes/:id/zapi/sincronizar-chats', authMovatak, async (req, res) => {
  try {
    await garantirEstruturaQuestionario();
    const c = await query('SELECT id, zapi_instance, zapi_token, zapi_client_token FROM movatak_clientes WHERE id=$1', [req.params.id]);
    if (!c.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const cli = c.rows[0];
    const data = await zapiListarChats(cli.zapi_instance, cli.zapi_token, cli.zapi_client_token);
    const chats = Array.isArray(data) ? data : (Array.isArray(data.chats) ? data.chats : []);
    let criados = 0, atualizados = 0, ignorados = 0;
    for (const ch of chats) {
      const phone = String(ch.phone || ch.id || '').replace(/\D/g, '');
      if (!phone || ch.isGroup) { ignorados++; continue; }
      const existe = await query('SELECT id FROM movatak_leads WHERE cliente_id=$1 AND telefone=$2 LIMIT 1', [cli.id, phone]).catch(() => ({ rows: [] }));
      if (existe.rows.length) {
        await query(`UPDATE movatak_leads SET nome=COALESCE(NULLIF($1,''),nome), nao_lida=COALESCE($2,nao_lida), atualizado_em=NOW() WHERE id=$3`, [ch.name || null, !!ch.unread, existe.rows[0].id]).catch(() => null);
        atualizados++;
      } else {
        await query(`INSERT INTO movatak_leads (cliente_id, nome, telefone, etapa, origem, nao_lida, criado_em, atualizado_em)
                    VALUES ($1,$2,$3,'lead','whatsapp_sync',$4,NOW(),NOW())`, [cli.id, ch.name || phone, phone, !!ch.unread]).catch(() => null);
        criados++;
      }
    }
    res.json({ ok: true, total: chats.length, criados, atualizados, ignorados });
  } catch(e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
});

// Webhook opcional da Z-API para status de mensagem: enviado/entregue/lido/falha.
// Configure no painel Z-API apontando para /movatak/webhook/zapi-status.
app.post('/movatak/webhook/zapi-status', async (req, res) => {
  try {
    await garantirEstruturaConversas();
    const body = req.body || {};
    const messageId = body.messageId || body.id || body.messageID || body.msgId || body.message_id;
    const status = body.status || body.messageStatus || body.type || body.ack || body.event || null;
    if (!messageId) return res.json({ ok: true, ignored: true });
    const r = await query(`UPDATE movatak_conversas
                             SET msg_status=$1, msg_status_em=NOW(), zapi_status_payload=$2::jsonb
                           WHERE msg_id=$3
                           RETURNING id, lead_id, cliente_id`, [String(status || ''), JSON.stringify(body), messageId]);
    if (r.rows.length) emitirStatusMensagem(r.rows[0].cliente_id, r.rows[0].lead_id, r.rows[0].id, status);
    res.json({ ok: true, atualizadas: r.rows.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/admin/leads/:id/historico', ...exigeLead, async (req, res) => {
  const _t0 = Date.now();
  try {
    const leadId = req.params.id;
    const lead = await query(
      `SELECT l.*, c.nome AS cliente_nome, v.nome AS vendedor_nome,
              fc.nome AS funil_coluna_nome, fc.cor AS funil_coluna_cor
         FROM movatak_leads l
         JOIN movatak_clientes c ON c.id = l.cliente_id
         LEFT JOIN movatak_vendedores v ON v.id = l.vendedor_id
         LEFT JOIN movatak_funil_colunas fc ON fc.id = l.funil_coluna_id
        WHERE l.id = $1`,
      [leadId]
    );
    if (!lead.rows.length) return res.status(404).json({ error: 'Lead nao encontrado.' });
    const _tLead = Date.now();

    const eventos = await query(
      `SELECT id, tipo, descricao, dados, criado_em
         FROM movatak_lead_eventos
        WHERE lead_id = $1
        ORDER BY criado_em DESC
        LIMIT 100`,
      [leadId]
    );
    const _tEventos = Date.now();

    const fila = await query(
      `SELECT id, etapa_seq, COALESCE(sequencia_fu, 1) AS sequencia_fu, proximo_envio,
              status, data_entrada, enviado_em, tentativas_envio, erro_envio
         FROM movatak_followup
        WHERE lead_id = $1
        ORDER BY proximo_envio DESC
        LIMIT 100`,
      [leadId]
    );
    const _tFila = Date.now();

    const totalMs = _tFila - _t0;
    if (totalMs > 3000) {
      console.log(`[DIAG-HIST] lead ${leadId} LENTO total=${totalMs}ms | lead=${_tLead - _t0}ms eventos=${_tEventos - _tLead}ms fila=${_tFila - _tEventos}ms`);
    }

    res.json({ lead: lead.rows[0], eventos: eventos.rows, fila: fila.rows });
  } catch (e) {
    console.error(`[DIAG-HIST] lead ${req.params.id} ERRO após ${Date.now() - _t0}ms:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// Rota de teste do R2 (temporária). Faz upload de um texto, baixa de volta e
// confirma que a integração funciona ponta a ponta. Remover após validar.
app.get('/movatak/admin/teste-r2', authMovatak, async (req, res) => {
  // Diagnóstico: mostra exatamente o que o processo carregou do ambiente.
  const diag = {
    bucket_variavel: R2_BUCKET || '(vazio)',
    bucket_real_descoberto: config.R2_BUCKET_REAL || '(vazio)',
    endpoint_carregado: (process.env.R2_ENDPOINT || '(vazio)').trim(),
    tem_access_key: !!process.env.R2_ACCESS_KEY_ID,
    tem_secret: !!process.env.R2_SECRET_ACCESS_KEY,
    r2_pronto: R2_PRONTO,
    cliente_inicializado: !!r2Client
  };
  try {
    if (!r2Client) {
      return res.json({ ok: false, motivo: 'R2 não configurado', diag });
    }
    // Lista os buckets reais (confirma o que o token enxerga).
    try {
      const lista = await r2Client.send(new R2_ListBucketsCommand({}));
      diag.buckets_visiveis = (lista.Buckets || []).map(b => b.Name);
    } catch (eList) {
      diag.buckets_visiveis = 'erro ao listar: ' + eList.message;
    }
    // Usa as funções r2* que já operam no bucket REAL auto-descoberto.
    const chave = 'teste/movatak-' + Date.now() + '.txt';
    const conteudo = Buffer.from('teste movatak r2 ' + new Date().toISOString(), 'utf8');
    await r2Upload(chave, conteudo, 'text/plain');
    const baixado = await r2Download(chave);
    const textoBaixado = baixado.buffer.toString('utf8');
    await r2Delete(chave);
    res.json({ ok: true, mensagem: 'R2 funcionando: upload, download e delete OK', diag, conteudo_baixado: textoBaixado });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message, diag });
  }
});


// ===== ANEXOS DO LEAD (documentos no R2) =====
const ANEXO_MAX_BYTES = 10 * 1024 * 1024; // 10MB
const ANEXO_TIPOS_OK = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain', 'text/csv'];

// Lista os anexos de um lead.
app.get('/movatak/admin/leads/:id/anexos', ...exigeLead, async (req, res) => {
  try {
    const r = await query(
      `SELECT id, nome_arquivo, tipo, tamanho, autor, criado_em, comentario
         FROM movatak_lead_anexos WHERE lead_id = $1 ORDER BY criado_em DESC`,
      [req.params.id]
    );
    res.json({ anexos: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Upload de anexo (recebe base64 no corpo JSON). O backend manda pro R2 e salva o registro.
app.post('/movatak/admin/leads/:id/anexos', ...exigeLead, async (req, res) => {
  try {
    if (!r2Client) return res.status(503).json({ error: 'Armazenamento de anexos indisponível.' });
    const leadId = req.params.id;
    const { nome_arquivo, tipo, base64 } = req.body || {};
    if (!nome_arquivo || !base64) return res.status(400).json({ error: 'Arquivo inválido.' });
    if (tipo && !ANEXO_TIPOS_OK.includes(tipo)) {
      return res.status(400).json({ error: 'Tipo de arquivo não permitido.' });
    }
    // Decodifica o base64 (aceita com ou sem prefixo data:).
    const limpo = String(base64).replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(limpo, 'base64');
    if (!buffer.length) return res.status(400).json({ error: 'Arquivo vazio.' });
    if (buffer.length > ANEXO_MAX_BYTES) {
      return res.status(400).json({ error: 'Arquivo muito grande (máx. 10MB).' });
    }
    const lead = await query('SELECT cliente_id FROM movatak_leads WHERE id = $1', [leadId]);
    if (!lead.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    const clienteId = lead.rows[0].cliente_id;
    // Chave no R2: organiza por cliente/lead e evita colisão com timestamp.
    // Nome ORIGINAL preservado para exibição/download (só remove separadores de caminho e controle).
    // Não usa \w (que descarta acentos) — assim "Comprovação.pdf" continua "Comprovação.pdf".
    const nomeOriginal = (String(nome_arquivo).replace(/[\/\\\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 200)) || 'arquivo';
    // Versão ASCII-segura usada SOMENTE na chave do R2 (evita problemas de encoding na chave).
    const nomeChaveSafe = nomeOriginal.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w.\- ]/g, '_').slice(0, 120);
    const chave = `anexos/cliente_${clienteId}/lead_${leadId}/${Date.now()}_${nomeChaveSafe}`;
    await r2Upload(chave, buffer, tipo || 'application/octet-stream');
    const autor = (req.vendedor && req.vendedor.nome) ? req.vendedor.nome : 'Gestor';
    const ins = await query(
      `INSERT INTO movatak_lead_anexos (lead_id, cliente_id, nome_arquivo, tipo, tamanho, r2_chave, autor)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, nome_arquivo, tipo, tamanho, autor, criado_em`,
      [leadId, clienteId, nomeOriginal, tipo || null, buffer.length, chave, autor]
    );
    res.json({ ok: true, anexo: ins.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Download de um anexo (busca do R2 e envia o arquivo).
app.get('/movatak/admin/leads/:id/anexos/:anexoId/download', ...exigeLead, async (req, res) => {
  try {
    if (!r2Client) return res.status(503).json({ error: 'Armazenamento indisponível.' });
    const r = await query(
      'SELECT nome_arquivo, tipo, r2_chave FROM movatak_lead_anexos WHERE id = $1 AND lead_id = $2',
      [req.params.anexoId, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Anexo não encontrado.' });
    const anexo = r.rows[0];
    const baixado = await r2Download(anexo.r2_chave);
    res.setHeader('Content-Type', anexo.tipo || baixado.contentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(anexo.nome_arquivo) + '"');
    res.send(baixado.buffer);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Remove um anexo (apaga do R2 e do banco).
app.delete('/movatak/admin/leads/:id/anexos/:anexoId', ...exigeLead, async (req, res) => {
  try {
    const r = await query(
      'SELECT r2_chave FROM movatak_lead_anexos WHERE id = $1 AND lead_id = $2',
      [req.params.anexoId, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Anexo não encontrado.' });
    if (r2Client) { await r2Delete(r.rows[0].r2_chave).catch(() => null); }
    await query('DELETE FROM movatak_lead_anexos WHERE id = $1', [req.params.anexoId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Define/atualiza o comentário de um anexo (texto livre, esvaziar remove).
app.put('/movatak/admin/leads/:id/anexos/:anexoId/comentario', ...exigeLead, async (req, res) => {
  try {
    const texto = String((req.body && req.body.comentario) || '').trim().slice(0, 2000);
    const r = await query(
      'UPDATE movatak_lead_anexos SET comentario = $1 WHERE id = $2 AND lead_id = $3 RETURNING id',
      [texto || null, req.params.anexoId, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Anexo não encontrado.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/leads/:id/anotacao', ...exigeLead, async (req, res) => {
  try {
    const leadId = req.params.id;
    const texto = String((req.body && req.body.texto) || '').trim();
    if (!texto) return res.status(400).json({ error: 'Texto da anotação vazio.' });
    if (texto.length > 4000) return res.status(400).json({ error: 'Anotação muito longa (máx. 4000 caracteres).' });
    const lead = await query('SELECT cliente_id FROM movatak_leads WHERE id = $1', [leadId]);
    if (!lead.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    const autor = (req.vendedor && req.vendedor.nome) ? req.vendedor.nome : 'Gestor';
    await registrarEventoLead(leadId, lead.rows[0].cliente_id, 'anotacao', texto, { autor });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Remove uma anotação manual (só eventos do tipo 'anotacao' podem ser apagados).
app.delete('/movatak/admin/leads/:id/anotacao/:eventoId', ...exigeLead, async (req, res) => {
  try {
    const { id: leadId, eventoId } = req.params;
    const r = await query(
      `DELETE FROM movatak_lead_eventos WHERE id = $1 AND lead_id = $2 AND tipo = 'anotacao'`,
      [eventoId, leadId]
    );
    res.json({ ok: true, removidos: r.rowCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lista operacional de leads do cliente
app.get('/movatak/admin/clientes/:id/leads-operacao', ...forcaClienteIdNaUrl, async (req, res) => {
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
app.get('/movatak/admin/clientes/:id/leads.csv', ...forcaClienteIdNaUrl, async (req, res) => {
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

// ============================================================
// Backup completo do cliente (somente leitura) — config + leads + conversas + tudo
// que tem cliente_id. Descobre as tabelas por introspecção: nunca referencia coluna
// inexistente e se adapta a mudanças futuras de schema. Baixa como JSON no PC do admin.
// ============================================================
app.get('/movatak/admin/clientes/:id/backup', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const clienteId = req.params.id;
    // Log/dedupe/transientes ficam de fora (sem valor de restore e podem inchar demais).
    const IGNORAR = new Set(['movatak_webhook_eventos', 'movatak_etiqueta_log', 'movatak_ausencia_enviada']);

    const tabsRes = await query(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema='public' AND column_name='cliente_id' AND table_name LIKE 'movatak_%'
        GROUP BY table_name ORDER BY table_name`
    );

    const tabelas = {};
    const contagens = {};

    // Config do próprio cliente (movatak_clientes tem PK id, não cliente_id).
    const cliRes = await query('SELECT * FROM movatak_clientes WHERE id = $1', [clienteId]);
    if (!cliRes.rows.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
    tabelas['movatak_clientes'] = cliRes.rows;
    contagens['movatak_clientes'] = cliRes.rows.length;
    const clienteNome = cliRes.rows[0].nome || ('cliente_' + clienteId);

    for (const row of tabsRes.rows) {
      const t = row.table_name;
      if (IGNORAR.has(t)) continue;
      if (!/^movatak_[a-z_]+$/.test(t)) continue; // defesa extra contra nome inesperado
      const r = await query(`SELECT * FROM ${t} WHERE cliente_id = $1`, [clienteId]);
      tabelas[t] = r.rows;
      contagens[t] = r.rows.length;
    }

    const backup = {
      movatak_backup: true,
      versao: MOVATAK_VERSION,
      gerado_em: new Date().toISOString(),
      cliente_id: Number(clienteId),
      cliente_nome: clienteNome,
      contagens,
      tabelas
    };

    const slug = String(clienteNome).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 40) || 'cliente';
    const dataStr = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="movatak-backup-${slug}-${dataStr}.json"`);
    res.send(JSON.stringify(backup));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// Conexão do WhatsApp (status / reiniciar / QR) — mesma rota serve admin e portal.
// No portal, forcaClienteIdNaUrl trava no próprio cliente (cada um só vê a sua instância).
// ============================================================
app.get('/movatak/admin/clientes/:id/conexao/status', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const creds = await getZapiCreds(req.params.id);
    if (!creds) return res.json({ ok: true, configurado: false, conectado: false, detalhe: 'Instância Z-API não configurada.' });
    const st = await zapiStatus(creds.instance, creds.token, creds.clientToken);
    const conectado = st.connected === true;
    res.json({
      ok: true, configurado: true, conectado,
      detalhe: st.error || (conectado ? 'Conectado' : (st.smartphoneConnected === false ? 'Celular desconectado' : 'Desconectado'))
    });
  } catch (e) {
    res.json({ ok: false, configurado: true, conectado: false, detalhe: 'Erro ao consultar: ' + (e.response?.data?.error || e.message) });
  }
});
app.post('/movatak/admin/clientes/:id/conexao/restart', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const creds = await getZapiCreds(req.params.id);
    if (!creds) return res.status(400).json({ error: 'Instância não configurada.' });
    await zapiRestart(creds.instance, creds.token, creds.clientToken);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.response?.data?.error || e.message });
  }
});
app.get('/movatak/admin/clientes/:id/conexao/qr', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const creds = await getZapiCreds(req.params.id);
    if (!creds) return res.status(400).json({ error: 'Instância não configurada.' });
    try {
      const st = await zapiStatus(creds.instance, creds.token, creds.clientToken);
      if (st.connected === true) return res.json({ ok: true, conectado: true, qr: null });
    } catch (_) {}
    const data = await zapiQrImagem(creds.instance, creds.token, creds.clientToken);
    let img = null;
    if (data) img = data.value || data.qrcode || (typeof data === 'string' ? data : null);
    if (!img) return res.json({ ok: true, conectado: false, qr: null, detalhe: 'QR indisponível no momento, tente novamente.' });
    const qr = String(img).startsWith('data:') ? img : ('data:image/png;base64,' + img);
    res.json({ ok: true, conectado: false, qr });
  } catch (e) {
    res.status(500).json({ error: e.response?.data?.error || e.message });
  }
});

// Envio manual do relatório diário para teste/implantação
app.post('/movatak/admin/clientes/:id/relatorio-diario/enviar', ...forcaClienteIdNaUrl, async (req, res) => {
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
  // Apenas erros de ESTRUTURA AUSENTE (tabela/coluna que não existe) devem ser
  // tratados como "migração ainda não aplicada". Erros de USO de coluna
  // (ex.: "must appear in the GROUP BY clause", "is ambiguous") são bugs de query
  // e NÃO podem ser silenciados — foi o que mascarou o bug do GROUP BY.
  const estruturaAusente =
    msg.includes('does not exist') ||
    msg.includes('não existe') ||
    msg.includes('nao existe') ||
    msg.includes('undefined column') ||
    msg.includes('undefined table');
  const erroDeUso =
    msg.includes('group by') ||
    msg.includes('is ambiguous') ||
    msg.includes('aggregate') ||
    msg.includes('syntax error');
  return estruturaAusente && !erroDeUso;
}


// ============================================================
// Questionário consultivo — schema, motor e recomendação
// ============================================================


// [refatoracao util] normalizarCep() -> src/util.js

// Envia mensagem do questionário: com mídia (legenda junto) quando houver, senão texto.
// Avalia se AGORA (fuso de Brasília/Recife, UTC-3) está dentro de um período de
// ausência configurado pelo cliente. Retorna { ausente, mensagem, periodoChave } —
// periodoChave identifica o período pra controlar o "uma vez por período".
// Data específica (feriado) tem prioridade sobre o horário recorrente semanal.
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

// Recebe uma linha de follow-up que já trouxe as colunas de ausência do cliente
// (ausencia_horarios / ausencia_datas) e diz se o cliente está, AGORA, fora do
// horário de atendimento. Usado para NÃO disparar follow-up durante a ausência.
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

// [refatoracao util] tipoMidia() -> src/util.js
// [refatoracao 3b] enviarMsgQuestionario() -> src/questionario.js

// [refatoracao util] uploadSupabase() -> src/util.js

// [refatoracao 3b] cepTemCobertura() -> src/questionario.js

// [refatoracao 3b] montarTextoPergunta() -> src/questionario.js

// [refatoracao 3b] interpretarResposta() -> src/questionario.js

// [refatoracao 3b] resolverSaltoQuestionario() -> src/questionario.js

// [refatoracao 3b] calcularPontuacao() -> src/questionario.js

// [refatoracao 3b] calcularRecomendacao() -> src/questionario.js

// [refatoracao 3b] avancarQuestionario() -> src/questionario.js

// [refatoracao 3b] iniciarQuestionarioPorTemplate() -> src/questionario.js

// [refatoracao 3b] resolverQuestionarioPorTemplateId() -> src/questionario.js

// [refatoracao 3b] resolverQuestionarioDoLead() -> src/questionario.js

// ============================================================
// Menu de Atendimento — execução no fluxo da conversa
// ============================================================

// Envia a Boas-Vindas ao Lead (mensagem de saudação independente do follow-up).
// É o "passo zero": enviada na entrada, se preenchida. NÃO gera evento, NÃO
// registra conversa, NÃO marca o lead — é totalmente invisível para o sistema.
// Não interfere na mecânica de follow-up, que segue normalmente depois.
async function enviarBoasVindasLead(cliente, telefone) {
  try {
    // Trava de segurança: nunca envia boas-vindas para grupos ou canais.
    if (ehGrupoOuCanal(telefone)) return;
    const msg1 = (cliente.boas_vindas_lead_msg1 || '').trim();
    const msg2 = (cliente.boas_vindas_lead_msg2 || '').trim();
    if (!msg1 && !msg2) return; // nada preenchido → não envia nada (comportamento idêntico ao de hoje)
    if (msg1) {
      await zapiEnviar(cliente.zapi_instance, cliente.zapi_token, cliente.zapi_client_token, telefone, msg1).catch(e => console.error('[boas-vindas][msg1]', e.message));
    }
    if (msg2) {
      const delaySeg = Math.min(Math.max(parseInt(cliente.boas_vindas_lead_delay) || 5, 1), 60);
      await new Promise(r => setTimeout(r, delaySeg * 1000));
      await zapiEnviar(cliente.zapi_instance, cliente.zapi_token, cliente.zapi_client_token, telefone, msg2).catch(e => console.error('[boas-vindas][msg2]', e.message));
    }
  } catch (e) {
    console.error('[boas-vindas]', e.message);
  }
}

// Envia o menu de atendimento para o lead e cria o estado "aguardando escolha".
async function enviarMenuAtendimento(cliente, lead) {
  try {
    const texto = (cliente.menu_atend_texto || '').trim();
    if (!texto) return false;
    await zapiEnviar(cliente.zapi_instance, cliente.zapi_token, cliente.zapi_client_token, lead.telefone, texto);
    await registrarConversa(lead.id, cliente.id, 'saida', texto, null, null, null, null, 'menu').catch(() => null);
    // Pausa o follow-up enquanto o lead decide o setor
    await query(`UPDATE movatak_followup SET status='pausado' WHERE lead_id=$1 AND status='pendente'`, [lead.id]).catch(() => null);
    // Cria/atualiza o estado de menu (encerra estados antigos do mesmo lead)
    await query(`UPDATE movatak_menu_estado SET status='cancelado', atualizado_em=NOW() WHERE lead_id=$1 AND status='aguardando'`, [lead.id]).catch(() => null);
    await query(
      `INSERT INTO movatak_menu_estado (cliente_id, lead_id, status, tentativas) VALUES ($1, $2, 'aguardando', 0)`,
      [cliente.id, lead.id]
    );
    await registrarEventoLead(lead.id, cliente.id, 'menu_enviado', 'Menu de atendimento enviado ao lead', {}).catch(() => null);
    return true;
  } catch (e) {
    console.error('[menu][enviar]', e.message);
    return false;
  }
}

// Processa a resposta do lead ao menu. Retorna true se tratou (e o fluxo deve parar aqui).
async function processarRespostaMenu(cliente, lead, estado, texto) {
  try {
    const mapa = Array.isArray(cliente.menu_atend_mapa) ? cliente.menu_atend_mapa : [];
    const resp = String(texto || '').trim().toLowerCase();

    // Tenta casar por resposta exata (número) OU pelo nome do setor
    let escolha = mapa.find(m => String(m.resposta).trim().toLowerCase() === resp);
    if (!escolha) {
      // Casa pelo nome do setor digitado
      const setoresRes = await query('SELECT id, nome FROM movatak_setores WHERE cliente_id=$1', [cliente.id]).catch(() => ({ rows: [] }));
      const setorPorNome = setoresRes.rows.find(s => String(s.nome).trim().toLowerCase() === resp);
      if (setorPorNome) escolha = mapa.find(m => Number(m.setor_id) === Number(setorPorNome.id));
    }

    if (escolha) {
      // Grava o setor
      await query('UPDATE movatak_leads SET setor_id=$1, atualizado_em=NOW() WHERE id=$2', [escolha.setor_id, lead.id]);
      // Move para a coluna do kanban, se a opção tiver coluna definida
      if (escolha.coluna_id) {
        await query('UPDATE movatak_leads SET funil_coluna_id=$1, atualizado_em=NOW() WHERE id=$2', [escolha.coluna_id, lead.id]).catch(() => null);
      }
      await query(`UPDATE movatak_menu_estado SET status='concluido', atualizado_em=NOW() WHERE id=$1`, [estado.id]).catch(() => null);
      await registrarEventoLead(lead.id, cliente.id, 'menu_respondido', 'Lead escolheu setor pelo menu', { resposta: resp, setor_id: escolha.setor_id, coluna_id: escolha.coluna_id || null, template_id: escolha.template_id || null }).catch(() => null);
      // Se a opção aponta para um autoatendimento próprio, inicia ele agora.
      if (escolha.template_id) {
        await iniciarQuestionarioPorTemplate(cliente, lead, escolha.template_id).catch(e => console.error('[menu][template-start]', e.message));
      }
      // Ação automática ao final do menu: marcar como não lido no WhatsApp (via Z-API)
      if (cliente.menu_atend_marcar_nao_lido && cliente.zapi_instance) {
        await zapiMarcarNaoLido(cliente.zapi_instance, cliente.zapi_token, cliente.zapi_client_token, lead.telefone)
          .catch(e => console.error('[menu][nao-lido]', e.message));
      }
      return true;
    }

    // Resposta inválida → vai para atendimento humano (recurso existente)
    await query(`UPDATE movatak_menu_estado SET status='invalido', atualizado_em=NOW() WHERE id=$1`, [estado.id]).catch(() => null);
    await pararAtendimentoLead(cliente.id, lead.id, 'menu_invalido', texto).catch(e => console.error('[menu][parar]', e.message));
    return true;
  } catch (e) {
    console.error('[menu][resposta]', e.message);
    return false;
  }
}

// [refatoracao 3b] iniciarQuestionario() -> src/questionario.js

// [refatoracao 3b] processarRespostaQuestionario() -> src/questionario.js

// [refatoracao 3b] finalizarQuestionario() -> src/questionario.js

// [refatoracao 3b] processarQuestionariosParados() -> src/questionario.js


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

app.get('/movatak/admin/clientes/:id/campanhas', ...forcaClienteIdNaUrl, async (req, res) => {
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

app.post('/movatak/admin/clientes/:id/campanhas', ...forcaClienteIdNaUrl, async (req, res) => {
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

app.patch('/movatak/admin/campanhas/:id', ...exigeCampanha, async (req, res) => {
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


app.delete('/movatak/admin/campanhas/:id', ...exigeCampanha, async (req, res) => {
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

app.delete('/movatak/admin/templates-followup/:id', ...exigeTemplateFU, async (req, res) => {
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

app.get('/movatak/admin/templates-followup', authMovatakOuApp, async (req, res) => {
  try {
    await garantirEstruturaCampanhasTemplates();
    // Cliente só vê os próprios templates: força o cliente_id do token.
    const clienteId = req.ehCliente ? req.clienteId : (req.query.cliente_id || req.query.clienteId || null);
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

// Atualiza as mensagens de um TEMPLATE específico (o selecionado no dropdown).
// Só templates personalizados (custom:ID) podem ser editados — os padrão são fixos.
app.patch('/movatak/admin/clientes/:id/template-followup-mensagens', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    await garantirEstruturaCampanhasTemplates();
    const templateRef = String(req.body.template || '').trim();
    const recebido = req.body.followup_v2 || {};
    const followup_v2 = {
      fu1: {
        msg1: String((recebido.fu1 && recebido.fu1.msg1) || '').trim(),
        msg2: String((recebido.fu1 && recebido.fu1.msg2) || '').trim()
      },
      fu2: {
        msg1: String((recebido.fu2 && recebido.fu2.msg1) || '').trim(),
        msg2: String((recebido.fu2 && recebido.fu2.msg2) || '').trim(),
        msg3: String((recebido.fu2 && recebido.fu2.msg3) || '').trim()
      }
    };

    if (!templateRef) {
      return res.status(400).json({ error: 'SEM_TEMPLATE' });
    }

    // Templates padrão (constantes no código) não podem ser editados.
    if (!templateRef.startsWith('custom:')) {
      return res.status(400).json({ error: 'TEMPLATE_PADRAO' });
    }

    const templateDbId = templateRef.replace('custom:', '').replace(/\D/g, '');
    const upd = await query(
      `UPDATE movatak_followup_templates
          SET followup_v2 = $1::jsonb
        WHERE id = $2 AND cliente_id = $3 AND ativo = true
        RETURNING id, nome`,
      [JSON.stringify(followup_v2), templateDbId, req.params.id]
    );
    if (!upd.rows.length) return res.status(404).json({ error: 'Template não encontrado.' });

    // Conta uso para informar o alcance.
    const usoCamp = await query(
      `SELECT COUNT(*)::int AS total FROM movatak_campanhas WHERE template_id = $1 AND ativo = true AND excluida_em IS NULL`,
      [templateDbId]
    ).catch(() => ({ rows: [{ total: 0 }] }));

    res.json({ ok: true, template: upd.rows[0], usado_em_campanhas: usoCamp.rows[0].total });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/movatak/admin/clientes/:id/templates-followup', ...forcaClienteIdNaUrl, async (req, res) => {
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

app.get('/movatak/admin/clientes/:id/template-conteudo', ...forcaClienteIdNaUrl, async (req, res) => {
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

app.post('/movatak/admin/clientes/:id/aplicar-template', ...forcaClienteIdNaUrl, async (req, res) => {
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

app.patch('/movatak/admin/leads/:id/cliente', ...exigeLead, async (req, res) => {
  try {
    const lead = await query('SELECT id, cliente_id FROM movatak_leads WHERE id = $1', [req.params.id]);
    if (!lead.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    await query(`UPDATE movatak_leads SET etapa = 'cliente', convertido_em = NOW(), atualizado_em = NOW() WHERE id = $1`, [req.params.id]);
    await query(`UPDATE movatak_followup SET status = 'pausado' WHERE lead_id = $1 AND status = 'pendente'`, [req.params.id]);
    await registrarEventoLead(req.params.id, lead.rows[0].cliente_id, 'cliente_manual', 'Lead marcado como cliente pelo painel');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/admin/leads/:id/descartar', ...exigeLead, async (req, res) => {
  try {
    const lead = await query('SELECT id, cliente_id FROM movatak_leads WHERE id = $1', [req.params.id]);
    if (!lead.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    await query(`UPDATE movatak_leads SET etapa = 'descartado', atualizado_em = NOW() WHERE id = $1`, [req.params.id]);
    await query(`UPDATE movatak_followup SET status = 'pausado' WHERE lead_id = $1 AND status = 'pendente'`, [req.params.id]);
    await registrarEventoLead(req.params.id, lead.rows[0].cliente_id, 'descartado_manual', 'Lead descartado pelo painel');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/admin/leads/:id/vendedor', ...exigeLead, async (req, res) => {
  try {
    const vendedorId = req.body && req.body.vendedor_id ? parseInt(req.body.vendedor_id) : null;
    const lead = await query('SELECT id, cliente_id FROM movatak_leads WHERE id = $1', [req.params.id]);
    if (!lead.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    await query(`UPDATE movatak_leads SET vendedor_id = $1, atualizado_em = NOW() WHERE id = $2`, [vendedorId, req.params.id]);
    await registrarEventoLead(req.params.id, lead.rows[0].cliente_id, 'vendedor_atribuido_manual', 'Vendedor atribuído manualmente pelo painel', { vendedor_id: vendedorId });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Exclui o lead DEFINITIVAMENTE, junto com todos os dados relacionados a ele.
// Diferente de "descartar" (que só muda a etapa) — aqui o lead some do sistema.
app.delete('/movatak/admin/leads/:id', ...exigeLead, async (req, res) => {
  try {
    const lead = await query('SELECT id, cliente_id FROM movatak_leads WHERE id = $1', [req.params.id]);
    if (!lead.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    const leadId = req.params.id;
    // Apaga tudo que referencia o lead antes de apagar o lead em si, pra não deixar órfãos.
    await query('DELETE FROM movatak_conversas WHERE lead_id = $1', [leadId]).catch(() => null);
    await query('DELETE FROM movatak_followup WHERE lead_id = $1', [leadId]).catch(() => null);
    await query('DELETE FROM movatak_lead_eventos WHERE lead_id = $1', [leadId]).catch(() => null);
    await query('DELETE FROM movatak_mensagens WHERE lead_id = $1', [leadId]).catch(() => null);
    await query('DELETE FROM movatak_menu_estado WHERE lead_id = $1', [leadId]).catch(() => null);
    await query('DELETE FROM movatak_questionario_estado WHERE lead_id = $1', [leadId]).catch(() => null);
    await query('DELETE FROM movatak_leads WHERE id = $1', [leadId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// Health check + Versão
// ============================================================
// ============================================================
// API — Planos/Pacotes por cliente (usados na recomendação por pontuação)
// ============================================================
app.get('/movatak/admin/clientes/:id/planos', ...forcaClienteIdNaUrl, async (req, res) => {
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

app.post('/movatak/admin/clientes/:id/planos', ...forcaClienteIdNaUrl, async (req, res) => {
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

app.patch('/movatak/admin/planos/:id', ...exigePlano, async (req, res) => {
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

app.delete('/movatak/admin/planos/:id', ...exigePlano, async (req, res) => {
  try {
    await garantirEstruturaPlanos();
    // Desvincula os leads que usam este plano (evita o bloqueio da foreign key).
    // Os leads continuam existindo, apenas sem plano associado.
    await query('UPDATE movatak_leads SET plano_id = NULL, atualizado_em = NOW() WHERE plano_id = $1', [req.params.id]).catch(() => null);
    await query('DELETE FROM movatak_plano_templates WHERE plano_id = $1', [req.params.id]).catch(() => null);
    await query('DELETE FROM movatak_planos WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// API — Questionário consultivo (config por cliente + cobertura CEP)
// ============================================================
app.post('/movatak/admin/upload-imagem', authMovatakOuApp, async (req, res) => {
  try {
    const dataUrl = (req.body && req.body.dataUrl) || '';
    // O navegador pode mandar parâmetros extras no content-type (ex: "audio/webm;codecs=opus")
    // antes do ";base64," — por isso o (?:;[^;,]+)* aceita qualquer quantidade deles no meio.
    const m = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)(?:;[^;,]+)*;base64,(.+)$/i.exec(dataUrl);
    const TIPOS_PERMITIDOS = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime', 'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-m4a', 'audio/aac'];
    const contentType = m ? m[1].toLowerCase() : '';
    if (!m || !TIPOS_PERMITIDOS.includes(contentType)) {
      return res.status(400).json({ error: 'Arquivo inválido. Envie imagem (PNG, JPG, WEBP), vídeo (MP4, WEBM, MOV) ou áudio (WEBM, OGG, MP3, M4A, WAV).' });
    }
    const ehVideo = contentType.startsWith('video/');
    const ehAudio = contentType.startsWith('audio/');
    const tipo = ehVideo ? 'video' : (ehAudio ? 'audio' : 'imagem');
    const extMap = {
      'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp',
      'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
      'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac'
    };
    const ext = extMap[contentType] || (ehVideo ? 'mp4' : (ehAudio ? 'webm' : 'jpg'));
    const buffer = Buffer.from(m[2], 'base64');
    const limite = ehVideo ? 20 * 1024 * 1024 : 8 * 1024 * 1024;
    if (buffer.length > limite) {
      return res.status(413).json({ error: ehVideo ? 'Vídeo muito grande (máx 20MB).' : 'Arquivo muito grande (máx 8MB).' });
    }
    const url = await uploadSupabase(buffer, contentType, ext);
    res.json({ ok: true, url, tipo });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/admin/clientes/:id/questionario', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    await garantirEstruturaQuestionario();
    const r = await query(
      `SELECT questionario_ativo, questionario_intro, questionario_final,
              questionario_intro_imagem, questionario_final_imagem,
              questionario_passos, questionario_recomendacao,
              questionario_comando_parar, questionario_comando_ativar,
              questionario_msg_parar,
              acao_arquivar_ao_final, acao_marcar_nao_lido, enviar_msg_final,
              quest_lembrete_msg, quest_lembrete_minutos
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
      msg_parar: r.rows[0].questionario_msg_parar || '',
      planos: rp.rows,
      cobertura_total: cob.rows[0].total,
      acao_arquivar_ao_final: !!r.rows[0].acao_arquivar_ao_final,
      acao_marcar_nao_lido: !!r.rows[0].acao_marcar_nao_lido,
      enviar_msg_final: r.rows[0].enviar_msg_final !== false,
      quest_lembrete_msg: r.rows[0].quest_lembrete_msg || '',
      quest_lembrete_minutos: r.rows[0].quest_lembrete_minutos || null
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/admin/clientes/:id/questionario', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    await garantirEstruturaQuestionario();
    const { ativo, intro, final, intro_imagem, final_imagem, passos, recomendacao, comando_parar, comando_ativar, msg_parar, acao_arquivar_ao_final, acao_marcar_nao_lido, enviar_msg_final, quest_lembrete_msg, quest_lembrete_minutos } = req.body || {};
    await query(
      `UPDATE movatak_clientes
          SET questionario_ativo = COALESCE($1, questionario_ativo),
              questionario_intro = COALESCE($2, questionario_intro),
              questionario_final = COALESCE($3, questionario_final),
              questionario_intro_imagem = COALESCE($4, questionario_intro_imagem),
              questionario_final_imagem = COALESCE($5, questionario_final_imagem),
              questionario_passos = COALESCE($6::jsonb, questionario_passos),
              questionario_recomendacao = COALESCE($7::jsonb, questionario_recomendacao),
              acao_arquivar_ao_final = COALESCE($8, acao_arquivar_ao_final),
              acao_marcar_nao_lido = COALESCE($9, acao_marcar_nao_lido),
              questionario_comando_parar = COALESCE($10, questionario_comando_parar),
              questionario_comando_ativar = COALESCE($11, questionario_comando_ativar),
              quest_lembrete_msg = COALESCE($12, quest_lembrete_msg),
              quest_lembrete_minutos = COALESCE($13, quest_lembrete_minutos),
              enviar_msg_final = COALESCE($15, enviar_msg_final),
              questionario_msg_parar = COALESCE($16, questionario_msg_parar)
        WHERE id = $14`,
      [
        typeof ativo === 'boolean' ? ativo : null,
        intro !== undefined ? (intro || '') : null,
        final !== undefined ? (final || '') : null,
        intro_imagem !== undefined ? (intro_imagem || '') : null,
        final_imagem !== undefined ? (final_imagem || '') : null,
        passos !== undefined ? JSON.stringify(Array.isArray(passos) ? passos : []) : null,
        recomendacao !== undefined ? JSON.stringify(Array.isArray(recomendacao) ? recomendacao : []) : null,
        typeof acao_arquivar_ao_final === 'boolean' ? acao_arquivar_ao_final : null,
        typeof acao_marcar_nao_lido === 'boolean' ? acao_marcar_nao_lido : null,
        (typeof comando_parar === 'string') ? comando_parar.trim() : null,
        (typeof comando_ativar === 'string') ? comando_ativar.trim() : null,
        (typeof quest_lembrete_msg === 'string') ? quest_lembrete_msg.trim() : null,
        (Number.isInteger(quest_lembrete_minutos) && quest_lembrete_minutos > 0) ? quest_lembrete_minutos : null,
        req.params.id,
        typeof enviar_msg_final === 'boolean' ? enviar_msg_final : null,
        (typeof msg_parar === 'string') ? msg_parar.trim() : null
      ]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ============================================================
// API — Templates de autoatendimento (questionário) por campanha
// ============================================================
app.get('/movatak/admin/clientes/:id/questionario-templates', ...forcaClienteIdNaUrl, async (req, res) => {
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

app.get('/movatak/admin/questionario-templates/:tid', ...exigeQuestTemplate, async (req, res) => {
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

app.post('/movatak/admin/clientes/:id/questionario-templates', ...forcaClienteIdNaUrl, async (req, res) => {
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

app.patch('/movatak/admin/questionario-templates/:tid', ...exigeQuestTemplate, async (req, res) => {
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

app.delete('/movatak/admin/questionario-templates/:tid', ...exigeQuestTemplate, async (req, res) => {
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

// normalizarReplyInfoConversa, registrarConversa → src/leads.js


app.get('/movatak/admin/clientes/:id/mensagens-rapidas', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    await garantirEstruturaMensagensRapidas();
    const r = await query('SELECT id, titulo, texto, midia_url, vezes_usado, ordem, itens, template_id FROM movatak_mensagens_rapidas WHERE cliente_id=$1 ORDER BY vezes_usado DESC, ordem ASC, id ASC', [req.params.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/clientes/:id/mensagens-rapidas', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    await garantirEstruturaMensagensRapidas();
    const { titulo, texto, midia_url, itens, template_id } = req.body || {};
    const sequencia = Array.isArray(itens) ? itens.filter(it => it && (it.texto || it.midia_url)) : [];
    if (!titulo) return res.status(400).json({ error: 'Título obrigatório.' });
    if (!sequencia.length && !texto) return res.status(400).json({ error: 'Texto obrigatório.' });
    // Quando é uma sequência, "texto" guarda um resumo (usado em listagem/busca);
    // o conteúdo real que será disparado mensagem por mensagem fica em "itens".
    const textoFinal = sequencia.length
      ? (texto || sequencia.map(it => it.texto || '').filter(Boolean).join(' ')).trim().slice(0, 500) || titulo.trim()
      : texto.trim();
    const r = await query(
      'INSERT INTO movatak_mensagens_rapidas (cliente_id, titulo, texto, midia_url, itens, template_id) VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING id, titulo, texto, midia_url, ordem, itens, template_id',
      [req.params.id, titulo.trim(), textoFinal, sequencia.length ? null : (midia_url || null), JSON.stringify(sequencia), template_id ? parseInt(template_id, 10) : null]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/admin/mensagens-rapidas/:id', ...exigeMsgRapida, async (req, res) => {
  try {
    const { titulo, texto, midia_url, itens } = req.body || {};
    await query(
      `UPDATE movatak_mensagens_rapidas SET
         titulo = COALESCE($1, titulo),
         texto = COALESCE($2, texto),
         midia_url = CASE WHEN $3::text IS NULL THEN midia_url ELSE $3 END,
         itens = CASE WHEN $4::jsonb IS NULL THEN itens ELSE $4::jsonb END
       WHERE id=$5`,
      [
        titulo || null, texto || null,
        midia_url !== undefined ? (midia_url || null) : null,
        Array.isArray(itens) ? JSON.stringify(itens) : null,
        req.params.id
      ]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/movatak/admin/mensagens-rapidas/:id', ...exigeMsgRapida, async (req, res) => {
  try {
    await query('DELETE FROM movatak_mensagens_rapidas WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Incrementa o ranking de uso por ID — usado pelas sequências, já que o texto
// salvo é só um resumo e não bate com o texto de nenhuma mensagem realmente enviada.
app.post('/movatak/admin/mensagens-rapidas/:id/usar', ...exigeMsgRapida, async (req, res) => {
  try {
    await query('UPDATE movatak_mensagens_rapidas SET vezes_usado = COALESCE(vezes_usado,0)+1 WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Inicia o autoatendimento de um template a partir do painel, para um lead.
// Reaproveita o MESMO motor do autoatendimento automático, então respeita tudo:
// perguntas que esperam resposta do lead, saltos, opções, delays, etc.
app.post('/movatak/admin/leads/:id/iniciar-autoatendimento', ...exigeLead, async (req, res) => {
  try {
    const templateId = req.body && req.body.template_id ? parseInt(req.body.template_id, 10) : null;
    if (!templateId) return res.status(400).json({ error: 'template_id é obrigatório.' });
    const rl = await query(
      `SELECT l.*, c.* FROM movatak_leads l JOIN movatak_clientes c ON c.id = l.cliente_id WHERE l.id = $1`,
      [req.params.id]
    );
    if (!rl.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    // Despausa a automação deste lead: se estiver pausado, o webhook ignora as
    // respostas dele e o autoatendimento trava na primeira pergunta que espera resposta.
    await query('UPDATE movatak_leads SET automacao_pausada = false, pediu_atendente = false WHERE id = $1', [req.params.id]).catch(() => null);
    // Separa lead e cliente do JOIN (ambos têm colunas; reconsultamos pra ter objetos limpos)
    const leadRow = await query('SELECT * FROM movatak_leads WHERE id = $1', [req.params.id]);
    const lead = leadRow.rows[0];
    const cliRow = await query('SELECT * FROM movatak_clientes WHERE id = $1', [lead.cliente_id]);
    const cliente = cliRow.rows[0];
    // Cancela qualquer questionário em andamento desse lead antes de reiniciar,
    // pra não embolar dois fluxos ao mesmo tempo.
    await query(
      `UPDATE movatak_questionario_estado SET status='cancelado', atualizado_em=NOW()
        WHERE cliente_id=$1 AND telefone=$2 AND status IN ('em_andamento','aguardando')`,
      [cliente.id, lead.telefone]
    ).catch(() => null);
    await iniciarQuestionarioPorTemplate(cliente, lead, templateId);
    await registrarEventoLead(lead.id, cliente.id, 'autoatendimento_manual', 'Autoatendimento iniciado manualmente pelo painel', { template_id: templateId });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/leads/:id/mensagem-rapida', ...exigeLead, async (req, res) => {
  try {
    const { texto, midia_url, midia_tipo, reply_to_conversa_id, reply_to_msg_id } = req.body || {};
    if (!texto && !midia_url) return res.status(400).json({ error: 'Texto ou mídia obrigatório.' });
    const rl = await query('SELECT l.id, l.telefone, l.cliente_id, c.zapi_instance, c.zapi_token, c.zapi_client_token FROM movatak_leads l JOIN movatak_clientes c ON c.id=l.cliente_id WHERE l.id=$1', [req.params.id]);
    if (!rl.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    const row = rl.rows[0];
    let tipoFinal = null;
    let msgId = null;
    const replyResolvido = await resolverReplyInfoLead(row.id, reply_to_conversa_id, reply_to_msg_id, null);
    const replyMsgIdZap = replyResolvido.msgId || null;
    if (midia_url) {
      tipoFinal = tipoMidia(midia_url, midia_tipo);
      if (tipoFinal === 'video') {
        msgId = await zapiEnviarVideo(row.zapi_instance, row.zapi_token, row.zapi_client_token, row.telefone, midia_url, texto || '', replyMsgIdZap);
      } else if (tipoFinal === 'audio') {
        msgId = await zapiEnviarAudio(row.zapi_instance, row.zapi_token, row.zapi_client_token, row.telefone, midia_url, replyMsgIdZap);
      } else {
        msgId = await zapiEnviarImagem(row.zapi_instance, row.zapi_token, row.zapi_client_token, row.telefone, midia_url, texto || '', replyMsgIdZap);
      }
    } else {
      msgId = await zapiEnviar(row.zapi_instance, row.zapi_token, row.zapi_client_token, row.telefone, texto, replyMsgIdZap);
    }
    const conversaId = await registrarConversa(row.id, row.cliente_id, 'saida', texto || '', midia_url || null, tipoFinal, msgId, replyResolvido.info).catch(() => null);
    await registrarEventoLead(row.id, row.cliente_id, 'mensagem_manual', 'Mensagem rápida enviada pelo kanban', { texto: (texto||'').slice(0, 100), midia: !!midia_url });
    await limparPedidoAtendente(row.id); // atendente respondeu → apaga o chip "pediu atendente"
    // Incrementa contador de uso se o texto bate com uma mensagem rápida cadastrada
    if (texto) {
      query('UPDATE movatak_mensagens_rapidas SET vezes_usado = COALESCE(vezes_usado,0)+1 WHERE cliente_id=$1 AND texto=$2', [row.cliente_id, texto]).catch(() => null);
    }
    res.json({ ok: true, conversaId, criado_em: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Alias usado pelo Kanban. Mantém compatibilidade com telas que chamam /mensagem-kanban
// em vez de /mensagem-rapida.
app.post('/movatak/admin/leads/:id/mensagem-kanban', ...exigeLead, async (req, res) => {
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
    await limparPedidoAtendente(row.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


app.post('/movatak/admin/leads/:id/reativar-followup', ...exigeLead, async (req, res) => {
  try {
    const seq = (req.body && Number(req.body.sequencia) === 2) ? 2 : 1;
    const rl = await query('SELECT id, cliente_id, etapa FROM movatak_leads WHERE id=$1', [req.params.id]);
    if (!rl.rows.length) return res.status(404).json({ error: 'Lead não encontrado.' });
    const lead = rl.rows[0];
    await query(`UPDATE movatak_leads SET etapa='followup', atualizado_em=NOW() WHERE id=$1`, [lead.id]);
    await agendarFollowupV2(lead.id, lead.cliente_id, seq, true);
    await enviarFollowupsPendentesDoLead(lead.id, seq);
    await registrarEventoLead(lead.id, lead.cliente_id, 'followup_reativado', 'Follow-up ' + seq + ' disparado manualmente', { sequencia: seq });
    res.json({ ok: true, sequencia: seq });
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


const NICHO_TEMPLATES = {
  estetica: {
    label: 'Clínica de estética',
    agendaTipos: ['avaliacao','consulta','retorno'],
    colunas: [
      ['Novo lead','novo_lead','lead'], ['Avaliação solicitada','avaliacao_solicitada','negociacao'],
      ['Consulta agendada','consulta_agendada','negociacao','consulta'], ['Confirmar presença','confirmar_presenca','followup'],
      ['Compareceu','compareceu','negociacao'], ['Procedimento realizado','procedimento_realizado','cliente'],
      ['Retorno / Pós-venda','retorno_pos_venda','followup','retorno'], ['Perdido','perdido','descartado']
    ]
  },
  barbearia: {
    label: 'Barbearia',
    agendaTipos: ['corte','barba','combo','retorno'],
    colunas: [
      ['Novo contato','novo_contato','lead'], ['Serviço desejado','servico_desejado','negociacao'],
      ['Horário solicitado','horario_solicitado','negociacao'], ['Agendado','agendado','negociacao','corte'],
      ['Confirmado','confirmado','followup'], ['Atendido','atendido','cliente'], ['Reagendar','reagendar','followup','retorno'], ['Perdido','perdido','descartado']
    ]
  },
  salao: {
    label: 'Salão de beleza',
    agendaTipos: ['escova','coloracao','manicure','retorno'],
    colunas: [
      ['Novo contato','novo_contato','lead'], ['Serviço desejado','servico_desejado','negociacao'],
      ['Orçamento enviado','orcamento_enviado','negociacao'], ['Agendado','agendado','negociacao','escova'],
      ['Confirmado','confirmado','followup'], ['Atendido','atendido','cliente'], ['Retorno / Fidelização','retorno_fidelizacao','followup','retorno'], ['Perdido','perdido','descartado']
    ]
  },
  odontologia: {
    label: 'Clínica odontológica',
    agendaTipos: ['avaliacao','consulta','retorno'],
    colunas: [
      ['Novo lead','novo_lead','lead'], ['Triagem','triagem','negociacao'], ['Avaliação agendada','avaliacao_agendada','negociacao','avaliacao'],
      ['Confirmar presença','confirmar_presenca','followup'], ['Plano de tratamento enviado','plano_tratamento_enviado','negociacao'],
      ['Tratamento iniciado','tratamento_iniciado','cliente'], ['Retorno','retorno','followup','retorno'], ['Perdido','perdido','descartado']
    ]
  },
  provedor: {
    label: 'Provedor de internet',
    agendaTipos: ['instalacao','suporte','visita_tecnica'],
    colunas: [
      ['Novo lead','novo_lead','lead'], ['Verificar cobertura','verificar_cobertura','negociacao'], ['Plano escolhido','plano_escolhido','negociacao'],
      ['Instalação agendada','instalacao_agendada','negociacao','instalacao'], ['Instalado','instalado','cliente'],
      ['Suporte','suporte','followup','suporte'], ['Financeiro','financeiro','negociacao'], ['Perdido','perdido','descartado']
    ]
  },
  assistencia: {
    label: 'Assistência técnica',
    agendaTipos: ['orcamento','suporte','retirada','entrega'],
    colunas: [
      ['Novo atendimento','novo_atendimento','lead'], ['Diagnóstico','diagnostico','negociacao'], ['Orçamento enviado','orcamento_enviado','negociacao','orcamento'],
      ['Serviço agendado','servico_agendado','negociacao','suporte'], ['Em execução','em_execucao','negociacao'],
      ['Pronto para entrega','pronto_entrega','followup','entrega'], ['Entregue','entregue','cliente'], ['Cancelado','cancelado','descartado']
    ]
  },
  grafica_dtf: {
    label: 'DTF / Gráfica',
    agendaTipos: ['producao','retirada','envio','retorno'],
    colunas: [
      ['Novo orçamento','novo_orcamento','lead'], ['Modelo enviado','modelo_enviado','negociacao'], ['Aguardando arte','aguardando_arte','followup'],
      ['Pagamento pendente','pagamento_pendente','negociacao'], ['Produção','producao','negociacao','producao'],
      ['Envio / Retirada','envio_retirada','followup','envio'], ['Pedido concluído','pedido_concluido','cliente'], ['Perdido','perdido','descartado']
    ]
  },
  generico: {
    label: 'Comercial genérico',
    agendaTipos: ['atendimento','retorno','reuniao'],
    colunas: [
      ['Novo contato','novo_contato','lead'], ['Em atendimento','em_atendimento','negociacao'], ['Proposta enviada','proposta_enviada','negociacao'],
      ['Retorno agendado','retorno_agendado','followup','retorno'], ['Negociação','negociacao','negociacao'],
      ['Cliente fechado','cliente_fechado','cliente'], ['Perdido','perdido','descartado']
    ]
  }
};

function normalizarNichoCliente(v) {
  const key = String(v || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const aliases = { clinica_estetica: 'estetica', estetica_clinica: 'estetica', salao_de_beleza: 'salao', salao_beleza: 'salao', clinica_odontologica: 'odontologia', odontologica: 'odontologia', provedor_internet: 'provedor', isp: 'provedor', assistencia_tecnica: 'assistencia', dtf: 'grafica_dtf', grafica: 'grafica_dtf', dtf_grafica: 'grafica_dtf', generico_comercial: 'generico' };
  const finalKey = aliases[key] || key;
  return NICHO_TEMPLATES[finalKey] ? finalKey : '';
}

function getNichoTemplate(nicho) {
  const key = normalizarNichoCliente(nicho) || 'generico';
  return { key, ...(NICHO_TEMPLATES[key] || NICHO_TEMPLATES.generico) };
}

async function aplicarTemplateNichoCliente(clienteId, nicho, opts = {}) {
  await garantirEstruturaFunil();
  const tpl = getNichoTemplate(nicho);
  const sincronizar = opts.sincronizar !== false;
  let ordemBase = 0;
  const maxR = await query('SELECT COALESCE(MAX(ordem),0)::int AS max FROM movatak_funil_colunas WHERE cliente_id=$1', [clienteId]).catch(() => ({ rows: [{ max: 0 }] }));
  ordemBase = parseInt((maxR.rows[0] || {}).max || 0, 10);
  const criadas = [];
  let pos = ordemBase + 1;
  for (const item of tpl.colunas) {
    const [nome, slugBase, etapa, agendaTipo] = item;
    const slug = slugifyFunil(slugBase || nome);
    const ins = await query(
      `INSERT INTO movatak_funil_colunas (cliente_id, nome, slug, ordem, etapa_sistema, sincronizar_whatsapp, nicho_template, agenda_tipo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (cliente_id, slug) DO UPDATE SET
         nome = EXCLUDED.nome,
         etapa_sistema = EXCLUDED.etapa_sistema,
         nicho_template = EXCLUDED.nicho_template,
         agenda_tipo = COALESCE(EXCLUDED.agenda_tipo, movatak_funil_colunas.agenda_tipo),
         ativo = true,
         atualizado_em = NOW()
       RETURNING *`,
      [clienteId, nome, slug, pos++, etapa || etapaSistemaPorSlug(slug), sincronizar, tpl.key, agendaTipo || null]
    ).catch(e => { console.error('[nicho][coluna]', e.message); return { rows: [] }; });
    if (ins.rows[0]) criadas.push(ins.rows[0]);
  }
  await query('UPDATE movatak_clientes SET nicho=$1, agenda_ativa=true WHERE id=$2', [tpl.key, clienteId]).catch(() => null);
  return { key: tpl.key, label: tpl.label, colunas: criadas };
}


async function buscarColunaAgenda(clienteId, tipo, colunaId) {
  if (colunaId) {
    const r = await query('SELECT id FROM movatak_funil_colunas WHERE cliente_id=$1 AND id=$2 AND ativo=true LIMIT 1', [clienteId, colunaId]).catch(() => ({ rows: [] }));
    if (r.rows[0]) return r.rows[0].id;
  }
  const tipoNorm = String(tipo || '').trim().toLowerCase();
  if (tipoNorm) {
    const r = await query('SELECT id FROM movatak_funil_colunas WHERE cliente_id=$1 AND ativo=true AND agenda_tipo=$2 ORDER BY ordem ASC, id ASC LIMIT 1', [clienteId, tipoNorm]).catch(() => ({ rows: [] }));
    if (r.rows[0]) return r.rows[0].id;
  }
  const fallback = await query(
    `SELECT id FROM movatak_funil_colunas
      WHERE cliente_id=$1 AND ativo=true AND (slug LIKE '%agend%' OR LOWER(nome) LIKE '%agend%')
      ORDER BY ordem ASC, id ASC LIMIT 1`,
    [clienteId]
  ).catch(() => ({ rows: [] }));
  return fallback.rows[0] ? fallback.rows[0].id : null;
}

// Verifica se já existe agendamento no MESMO horário (inicio) e na MESMA coluna do kanban.
// A coluna é o critério que distingue agendamentos simultâneos (ex.: médicos diferentes =
// colunas diferentes). IS NOT DISTINCT FROM trata coluna nula = coluna nula como conflito.
async function conflitoAgenda(clienteId, inicio, colunaId, ignorarId) {
  const r = await query(
    `SELECT id FROM movatak_agendamentos
      WHERE cliente_id = $1
        AND inicio = $2::timestamptz
        AND funil_coluna_id IS NOT DISTINCT FROM $3
        AND COALESCE(status,'agendado') <> 'cancelado'
        AND ($4::int IS NULL OR id <> $4)
      LIMIT 1`,
    [clienteId, inicio, colunaId ?? null, ignorarId ?? null]
  ).catch(() => ({ rows: [] }));
  return r.rows.length > 0;
}

async function garantirFunilPadraoCliente(clienteId) {
  await garantirEstruturaFunil();
  // Se o cliente JÁ tem colunas (ativas ou não), o funil dele já foi inicializado.
  // Não recriamos nem reaplicamos nada — o usuário tem autonomia total sobre as
  // colunas (excluir, criar), inclusive sobre as que vieram de um template. O
  // template só é (re)aplicado quando o usuário clica explicitamente em "aplicar".
  const existe = await query('SELECT 1 FROM movatak_funil_colunas WHERE cliente_id=$1 LIMIT 1', [clienteId]).catch(() => ({ rows: [] }));
  if (existe.rows.length) return;

  const cliNichoR = await query('SELECT nicho FROM movatak_clientes WHERE id=$1', [clienteId]).catch(() => ({ rows: [] }));
  const nichoCliente = normalizarNichoCliente((cliNichoR.rows[0] || {}).nicho);
  if (nichoCliente) {
    // Primeira inicialização de um cliente com nicho: aplica o template uma única vez.
    await aplicarTemplateNichoCliente(clienteId, nichoCliente, { sincronizar: false }).catch(e => console.error('[nicho][garantir-funil]', e.message));
    return;
  }
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
            fc.id AS coluna_id, fc.nome AS coluna_nome, fc.slug, fc.etapa_sistema, fc.sincronizar_whatsapp, fc.zapi_tag_id, fc.setor_id AS coluna_setor_id,
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

  // O lead herda o setor da coluna para onde foi movido. Sem isso, o lead ficaria
  // na coluna de um setor mas com setor_id de outro — sumindo do filtro por setor e
  // do CRM do vendedor daquele setor. Só atualiza se a coluna tiver setor definido.
  if (row.coluna_setor_id) {
    await query(`UPDATE movatak_leads SET setor_id=$1, atualizado_em=NOW() WHERE id=$2`, [row.coluna_setor_id, leadId]).catch(() => null);
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

// Reconcilia o setor dos leads com o setor das colunas onde eles estão. Útil para
// corrigir leads movidos antes do fix (que ficaram com setor_id de um setor mas em
// coluna de outro). Atualiza só quando há divergência.
app.post('/movatak/admin/clientes/:id/reconciliar-setores', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const clienteId = parseInt(req.params.id, 10);
    const r = await query(
      `UPDATE movatak_leads l
          SET setor_id = fc.setor_id, atualizado_em = NOW()
         FROM movatak_funil_colunas fc
        WHERE l.funil_coluna_id = fc.id
          AND l.cliente_id = $1
          AND fc.setor_id IS NOT NULL
          AND (l.setor_id IS DISTINCT FROM fc.setor_id)
        RETURNING l.id`,
      [clienteId]
    );
    res.json({ ok: true, leads_corrigidos: r.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/admin/clientes/:id/diagnostico', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const clienteId = parseInt(req.params.id, 10);
    const telefoneRaw = String(req.query.telefone || '').trim();
    if (!telefoneRaw) return res.status(400).json({ error: 'Informe o telefone.' });
    const variantes = variantesTelefone(telefoneRaw);
    if (!variantes.length) return res.status(400).json({ error: 'Telefone inválido.' });

    const ph = variantes.map((_, i) => '$' + (i + 2)).join(',');
    const rl = await query(
      `SELECT l.*, camp.nome AS campanha_nome, camp.template_id AS camp_template_id,
              camp.questionario_ativo AS camp_quest_ativo, camp.questionario_template_id AS camp_quest_template_id,
              ft.nome AS template_followup_nome, qt.nome AS template_quest_nome
         FROM movatak_leads l
         LEFT JOIN movatak_campanhas camp ON camp.id = l.campanha_id
         LEFT JOIN movatak_followup_templates ft ON ft.id = COALESCE(camp.template_id, l.template_id_origem)
         LEFT JOIN movatak_questionario_templates qt ON qt.id = camp.questionario_template_id
        WHERE l.cliente_id = $1 AND l.telefone IN (${ph})
        ORDER BY l.atualizado_em DESC NULLS LAST, l.criado_em DESC LIMIT 1`,
      [clienteId, ...variantes]
    );
    if (!rl.rows.length) return res.json({ encontrado: false, variantes_buscadas: variantes });
    const lead = rl.rows[0];

    const [estado, eventos, followups] = await Promise.all([
      query(`SELECT id, passo_idx, tentativas_invalidas, status, atualizado_em FROM movatak_questionario_estado WHERE lead_id = $1 ORDER BY id DESC LIMIT 3`, [lead.id]).catch(() => ({ rows: [] })),
      query(`SELECT tipo, descricao, criado_em FROM movatak_lead_eventos WHERE lead_id = $1 ORDER BY id DESC LIMIT 15`, [lead.id]).catch(() => ({ rows: [] })),
      query(`SELECT sequencia_fu, etapa_seq, status, proximo_envio FROM movatak_followup WHERE lead_id = $1 ORDER BY COALESCE(sequencia_fu,1), etapa_seq`, [lead.id]).catch(() => ({ rows: [] }))
    ]);

    // Qual fonte de questionário este lead usa?
    let fonteQuest = 'Questionário do cliente (padrão)';
    if (lead.camp_quest_ativo === false) fonteQuest = 'Sem autoatendimento (vai direto ao follow-up)';
    else if (lead.camp_quest_template_id) fonteQuest = 'Modelo: ' + (lead.template_quest_nome || ('#' + lead.camp_quest_template_id));

    res.json({
      encontrado: true,
      variantes_buscadas: variantes,
      lead: {
        id: lead.id, nome: lead.nome, telefone: lead.telefone, etapa: lead.etapa,
        automacao_pausada: lead.automacao_pausada,
        campanha: lead.campanha_nome || null,
        gatilho_detectado: lead.gatilho_detectado || null,
        template_followup: lead.template_followup_nome || 'Padrão do cliente',
        fonte_questionario: fonteQuest,
        criado_em: lead.criado_em, atualizado_em: lead.atualizado_em
      },
      questionario_estado: estado.rows,
      eventos: eventos.rows,
      followups: followups.rows
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DASHBOARD SLA — tempo de resposta por setor e vendedor ───
// Cruza cada mensagem de ENTRADA (lead) com a próxima SAÍDA, calcula o gap,
// e agrega por setor → vendedor. Separa respostas humanas de automáticas.
app.get('/movatak/admin/clientes/:id/sla', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    await garantirEstruturaConversas();
    const clienteId = parseInt(req.params.id, 10);
    const dias = Math.max(1, Math.min(parseInt(req.query.dias || '30', 10), 180));

    // Para cada mensagem de entrada, acha a próxima saída do mesmo lead (a "resposta").
    // gap_seg = segundos entre a entrada e essa resposta.
    // primeira = true se é a primeira resposta após uma sequência de entradas (1ª resposta).
    const r = await query(
      `WITH msgs AS (
         SELECT c.id, c.lead_id, c.direcao, c.origem, c.criado_em,
                l.setor_id, l.vendedor_id
           FROM movatak_conversas c
           JOIN movatak_leads l ON l.id = c.lead_id
          WHERE c.cliente_id = $1
            AND c.criado_em >= NOW() - ($2 || ' days')::INTERVAL
       ),
       entradas AS (
         SELECT m.*,
                LAG(direcao) OVER (PARTITION BY lead_id ORDER BY criado_em) AS dir_anterior
           FROM msgs m
       ),
       respostas AS (
         SELECT e.lead_id, e.setor_id, e.vendedor_id, e.criado_em AS entrada_em,
                (e.dir_anterior IS DISTINCT FROM 'entrada') AS primeira_da_sequencia,
                (SELECT s.criado_em FROM msgs s
                   WHERE s.lead_id = e.lead_id AND s.direcao = 'saida' AND s.criado_em > e.criado_em
                   ORDER BY s.criado_em ASC LIMIT 1) AS resposta_em,
                (SELECT s.origem FROM msgs s
                   WHERE s.lead_id = e.lead_id AND s.direcao = 'saida' AND s.criado_em > e.criado_em
                   ORDER BY s.criado_em ASC LIMIT 1) AS resposta_origem
           FROM entradas e
          WHERE e.direcao = 'entrada'
       )
       SELECT setor_id, vendedor_id,
              resposta_origem,
              primeira_da_sequencia,
              COUNT(*) FILTER (WHERE resposta_em IS NOT NULL)::int AS respondidas,
              COUNT(*) FILTER (WHERE resposta_em IS NULL)::int AS sem_resposta,
              AVG(EXTRACT(EPOCH FROM (resposta_em - entrada_em))) FILTER (WHERE resposta_em IS NOT NULL) AS gap_medio_seg
         FROM respostas
        GROUP BY setor_id, vendedor_id, resposta_origem, primeira_da_sequencia`,
      [clienteId, dias]
    );

    // Nomes de setores e vendedores
    const setoresR = await query('SELECT id, nome, cor FROM movatak_setores WHERE cliente_id=$1', [clienteId]).catch(() => ({ rows: [] }));
    const vendedoresR = await query('SELECT id, nome FROM movatak_vendedores WHERE cliente_id=$1', [clienteId]).catch(() => ({ rows: [] }));
    const setorNome = new Map(setoresR.rows.map(s => [Number(s.id), s]));
    const vendNome = new Map(vendedoresR.rows.map(v => [Number(v.id), v.nome]));

    // Quantos leads estão esperando AGORA (última msg foi do lead, sem resposta).
    const esperandoR = await query(
      `WITH ult AS (
         SELECT DISTINCT ON (c.lead_id) c.lead_id, c.direcao, l.setor_id, l.vendedor_id
           FROM movatak_conversas c
           JOIN movatak_leads l ON l.id = c.lead_id
          WHERE c.cliente_id = $1 AND COALESCE(l.arquivado,false) = false
          ORDER BY c.lead_id, c.criado_em DESC
       )
       SELECT setor_id, vendedor_id, COUNT(*)::int AS esperando
         FROM ult WHERE direcao = 'entrada'
        GROUP BY setor_id, vendedor_id`,
      [clienteId]
    ).catch(() => ({ rows: [] }));

    // Monta estrutura hierárquica: setor → vendedores → métricas.
    const ehAuto = (o) => ['followup', 'ausencia', 'menu', 'questionario', 'recomendacao', 'bot'].includes(o);
    const setores = {};
    function getSetor(sid) {
      const k = sid == null ? 0 : Number(sid);
      if (!setores[k]) {
        const s = setorNome.get(k);
        setores[k] = { setor_id: k, setor_nome: s ? s.nome : 'Sem setor', setor_cor: s ? s.cor : null, vendedores: {} };
      }
      return setores[k];
    }
    function getVend(setor, vid) {
      const k = vid == null ? 0 : Number(vid);
      if (!setor.vendedores[k]) {
        setor.vendedores[k] = {
          vendedor_id: k, vendedor_nome: vid ? (vendNome.get(k) || 'Vendedor') : 'Sem vendedor',
          primeira_humano_seg: null, primeira_humano_n: 0,
          primeira_auto_seg: null, primeira_auto_n: 0,
          geral_humano_seg: null, geral_humano_n: 0,
          geral_auto_seg: null, geral_auto_n: 0,
          sem_resposta: 0, esperando: 0
        };
      }
      return setor.vendedores[k];
    }
    function acumular(alvoSeg, alvoN, gap, n) {
      // média ponderada incremental
      const totalN = alvoN + n;
      if (totalN === 0) return [alvoSeg, alvoN];
      const somaAtual = (alvoSeg || 0) * alvoN;
      const novaSoma = somaAtual + gap * n;
      return [novaSoma / totalN, totalN];
    }

    for (const row of r.rows) {
      const setor = getSetor(row.setor_id);
      const v = getVend(setor, row.vendedor_id);
      const auto = ehAuto(row.resposta_origem);
      const gap = row.gap_medio_seg != null ? Number(row.gap_medio_seg) : null;
      const n = Number(row.respondidas) || 0;
      v.sem_resposta += Number(row.sem_resposta) || 0;
      if (gap != null && n > 0) {
        if (row.primeira_da_sequencia) {
          if (auto) { [v.primeira_auto_seg, v.primeira_auto_n] = acumular(v.primeira_auto_seg, v.primeira_auto_n, gap, n); }
          else { [v.primeira_humano_seg, v.primeira_humano_n] = acumular(v.primeira_humano_seg, v.primeira_humano_n, gap, n); }
        }
        if (auto) { [v.geral_auto_seg, v.geral_auto_n] = acumular(v.geral_auto_seg, v.geral_auto_n, gap, n); }
        else { [v.geral_humano_seg, v.geral_humano_n] = acumular(v.geral_humano_seg, v.geral_humano_n, gap, n); }
      }
    }
    for (const row of esperandoR.rows) {
      const setor = getSetor(row.setor_id);
      const v = getVend(setor, row.vendedor_id);
      v.esperando += Number(row.esperando) || 0;
    }

    // Converte para arrays e arredonda.
    const out = Object.values(setores).map(s => {
      const vends = Object.values(s.vendedores).map(v => ({
        ...v,
        primeira_humano_seg: v.primeira_humano_seg != null ? Math.round(v.primeira_humano_seg) : null,
        primeira_auto_seg: v.primeira_auto_seg != null ? Math.round(v.primeira_auto_seg) : null,
        geral_humano_seg: v.geral_humano_seg != null ? Math.round(v.geral_humano_seg) : null,
        geral_auto_seg: v.geral_auto_seg != null ? Math.round(v.geral_auto_seg) : null
      }));
      return { ...s, vendedores: vends };
    });

    res.json({ dias, setores: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/admin/clientes/:id/funil', authMovatakOuApp, async (req, res) => {
  try {
    // Segurança: se for o cliente (portal), força o cliente_id do token —
    // ignora o :id da URL para ele nunca acessar outro cliente.
    const clienteId = req.ehCliente ? req.clienteId : parseInt(req.params.id, 10);
    const setorFiltro = req.query.setor ? parseInt(req.query.setor, 10) : null;
    await garantirFunilPadraoCliente(clienteId);
    // Garante a coluna do avatar antes da query referenciá-la (no-op se já existe).
    await query(`ALTER TABLE movatak_leads ADD COLUMN IF NOT EXISTS foto_url TEXT`).catch(() => null);

    // "Todos" mostra todas as colunas. Um setor específico mostra só as colunas
    // atribuídas a ele (configurado pelo seletor de setor no cabeçalho da coluna).
    const colunasParams = [clienteId];
    let filtroColunaSetorSql = '';
    if (setorFiltro) {
      colunasParams.push(setorFiltro);
      filtroColunaSetorSql = ' AND setor_id = $2';
    }
    const colunasRes = await query(
      `SELECT id, nome, slug, ordem, cor, etapa_sistema, sincronizar_whatsapp, zapi_tag_id, zapi_sync_erro, comando, setor_id, ausencia_ativa, ia_ativa, nicho_template, agenda_tipo, agenda_status
         FROM movatak_funil_colunas
        WHERE cliente_id=$1 AND ativo=true${filtroColunaSetorSql}
        ORDER BY ordem ASC, id ASC`,
      colunasParams
    );
    const colunas = colunasRes.rows.map(c => ({ ...c, leads: [] }));
    const colById = new Map(colunas.map(c => [Number(c.id), c]));
    const colBySlug = new Map(colunas.map(c => [c.slug, c]));

    const params = [clienteId];
    let filtroSetorSql = '';
    if (setorFiltro) {
      params.push(setorFiltro);
      filtroSetorSql = ' AND l.setor_id = $2';
    }
    const leads = await query(
      `SELECT lb.*, ult.conteudo AS ultima_msg, ult.direcao AS ultima_msg_direcao, ult.criado_em AS ultima_msg_em, ult.midia_tipo AS ultima_msg_midia
         FROM (
           SELECT l.id, l.nome, l.telefone, l.etapa, l.funil_coluna_id, l.vendedor_id, l.setor_id,
                  l.nao_lida, l.arquivado, l.foto_url,
                  COALESCE(l.pediu_atendente,false) AS pediu_atendente, l.pediu_atendente_em,
                  s.nome AS setor_nome, s.cor AS setor_cor,
                  l.criado_em, l.atualizado_em, l.convertido_em, l.prioridade_dispensada_em,
                  v.nome AS vendedor_nome,
                  p.nome AS plano_nome, p.valor AS plano_valor,
                  COUNT(f.id) FILTER (WHERE f.status='pendente')::int AS followups_pendentes,
                  MIN(COALESCE(f.sequencia_fu,1)) FILTER (WHERE f.status='pendente')::int AS fu_sequencia_ativa
             FROM movatak_leads l
             LEFT JOIN movatak_vendedores v ON v.id = l.vendedor_id
             LEFT JOIN movatak_planos p ON p.id = l.plano_id
             LEFT JOIN movatak_setores s ON s.id = l.setor_id
             LEFT JOIN movatak_followup f ON f.lead_id = l.id
            WHERE l.cliente_id=$1${filtroSetorSql}
            GROUP BY l.id, v.nome, p.nome, p.valor, s.nome, s.cor
         ) lb
         LEFT JOIN LATERAL (
           SELECT conteudo, direcao, criado_em, midia_tipo FROM movatak_conversas c
            WHERE c.lead_id = lb.id ORDER BY c.criado_em DESC LIMIT 1
         ) ult ON true
        ORDER BY lb.atualizado_em DESC NULLS LAST, lb.criado_em DESC
        LIMIT 500`,
      params
    );

    // Leads ativos (não arquivados) — vão para o kanban central.
    const leadsAtivos = leads.rows.filter(l => !l.arquivado);
    for (const lead of leadsAtivos) {
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
      leads: leadsAtivos.filter(l => l.vendedor_id === v.id)
    }));

    // Setores do cliente + contagem ao vivo (independente do filtro atual,
    // pra mostrar "Financeiro 5 / Negociação 4" nas abas mesmo trocando de aba).
    const clienteInfoRes = await query(
      `SELECT nicho, agenda_ativa FROM movatak_clientes WHERE id=$1`,
      [clienteId]
    ).catch(() => ({ rows: [] }));
    const clienteInfo = clienteInfoRes.rows[0] || {};

    const setoresRes = await query(
      `SELECT id, nome, cor FROM movatak_setores
        WHERE cliente_id=$1 AND COALESCE(ativo,true)=true
        ORDER BY ordem_bot ASC, nome ASC`,
      [clienteId]
    );
    const contagemSetoresRes = await query(
      `SELECT setor_id, COUNT(*)::int AS cnt, COUNT(*) FILTER (WHERE nao_lida = true)::int AS nao_lidas
         FROM movatak_leads
        WHERE cliente_id=$1 AND COALESCE(arquivado,false)=false
        GROUP BY setor_id`,
      [clienteId]
    );
    const contagemPorSetor = new Map(contagemSetoresRes.rows.map(r => [r.setor_id, r.cnt]));
    const naoLidasPorSetor = new Map(contagemSetoresRes.rows.map(r => [r.setor_id, r.nao_lidas]));
    const setores = setoresRes.rows.map(s => ({
      ...s,
      leads_count: contagemPorSetor.get(s.id) || 0,
      nao_lidas: naoLidasPorSetor.get(s.id) || 0
    }));
    const totalGeral = contagemSetoresRes.rows.reduce((acc, r) => acc + r.cnt, 0);
    const totalNaoLidas = contagemSetoresRes.rows.reduce((acc, r) => acc + r.nao_lidas, 0);

    res.json({
      colunas, colunasVendedores,
      setores, setorAtivo: setorFiltro, totalGeral, totalNaoLidas,
      nicho: clienteInfo.nicho || null, agenda_ativa: !!clienteInfo.agenda_ativa,
      leads: leads.rows // lista completa (inclui arquivados) — usada pela caixa de entrada (coluna esquerda)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Métricas do rodapé do Funil de Atendimento (Total de leads, Novas mensagens,
// Em negociação, Conversão do mês). Aceita o mesmo filtro ?setor= do board.
app.get('/movatak/admin/clientes/:id/funil/metricas', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const clienteId = parseInt(req.params.id, 10);
    const setorFiltro = req.query.setor ? parseInt(req.query.setor, 10) : null;
    const params = [clienteId];
    let filtroSetorSql = '';
    if (setorFiltro) { params.push(setorFiltro); filtroSetorSql = ' AND l.setor_id = $2'; }

    const totaisR = await query(
      `SELECT
         COUNT(*)::int AS total_leads,
         COUNT(*) FILTER (WHERE l.nao_lida = true)::int AS novas_mensagens,
         COUNT(*) FILTER (WHERE l.criado_em >= date_trunc('month', now()))::int AS criados_mes,
         COUNT(*) FILTER (WHERE l.convertido_em >= date_trunc('month', now()))::int AS convertidos_mes
       FROM movatak_leads l
       WHERE l.cliente_id=$1 AND COALESCE(l.arquivado,false)=false${filtroSetorSql}`,
      params
    );
    const negociacaoR = await query(
      `SELECT COUNT(*)::int AS n
         FROM movatak_leads l
         LEFT JOIN movatak_funil_colunas c ON c.id = l.funil_coluna_id
        WHERE l.cliente_id=$1 AND COALESCE(l.arquivado,false)=false${filtroSetorSql}
          AND COALESCE(c.etapa_sistema, l.etapa) = 'negociacao'`,
      params
    );
    const t = totaisR.rows[0] || {};
    const conversaoMes = t.criados_mes > 0 ? Math.round((t.convertidos_mes / t.criados_mes) * 100) : 0;
    res.json({
      totalLeads: t.total_leads || 0,
      novasMensagens: t.novas_mensagens || 0,
      emNegociacao: (negociacaoR.rows[0] || {}).n || 0,
      conversaoMes
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


app.get('/movatak/admin/nichos-templates', authMovatak, async (req, res) => {
  try {
    res.json(Object.entries(NICHO_TEMPLATES).map(([key, tpl]) => ({
      key,
      label: tpl.label,
      agendaTipos: tpl.agendaTipos || [],
      colunas: (tpl.colunas || []).map(c => ({ nome: c[0], slug: c[1], etapa: c[2], agenda_tipo: c[3] || null }))
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/clientes/:id/funil/aplicar-nicho', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    const clienteId = parseInt(req.params.id, 10);
    const nicho = normalizarNichoCliente(req.body?.nicho);
    if (!nicho) return res.status(400).json({ error: 'Nicho inválido.' });
    const result = await aplicarTemplateNichoCliente(clienteId, nicho, { sincronizar: req.body?.sincronizar_whatsapp !== false });
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/admin/clientes/:id/agendamentos', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    await garantirEstruturaAgenda();
    const clienteId = parseInt(req.params.id, 10);
    const dias = Math.max(1, Math.min(parseInt(req.query.dias || '30', 10), 120));
    const r = await query(
      `SELECT a.*, l.nome AS lead_nome, l.telefone AS lead_telefone, c.nome AS coluna_nome
         FROM movatak_agendamentos a
         LEFT JOIN movatak_leads l ON l.id = a.lead_id
         LEFT JOIN movatak_funil_colunas c ON c.id = a.funil_coluna_id
        WHERE a.cliente_id=$1
          AND a.inicio >= NOW() - INTERVAL '1 day'
          AND a.inicio <= NOW() + ($2 || ' days')::INTERVAL
        ORDER BY a.inicio ASC
        LIMIT 200`,
      [clienteId, dias]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/clientes/:id/agendamentos', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    await garantirEstruturaAgenda();
    const clienteId = parseInt(req.params.id, 10);
    const { lead_id, titulo, tipo, inicio, fim, status, observacao, coluna_id, mover_kanban, lembrete_min } = req.body || {};
    if (!titulo || !inicio) return res.status(400).json({ error: 'Título e data/horário são obrigatórios.' });
    const tipoNorm = String(tipo || 'atendimento').trim().toLowerCase();
    const lembreteNorm = [5, 15, 30, 60].includes(Number(lembrete_min)) ? Number(lembrete_min) : 0;
    const colunaDestino = await buscarColunaAgenda(clienteId, tipoNorm, coluna_id || null);
    if (await conflitoAgenda(clienteId, inicio, colunaDestino, null)) {
      return res.status(409).json({ error: 'Já existe um agendamento neste horário nesta coluna. Escolha outro horário ou outra coluna.' });
    }
    const ins = await query(
      `INSERT INTO movatak_agendamentos (cliente_id, lead_id, titulo, tipo, status, inicio, fim, observacao, funil_coluna_id, lembrete_min)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [clienteId, lead_id || null, titulo, tipoNorm, status || 'agendado', inicio, fim || null, observacao || null, colunaDestino, lembreteNorm]
    );
    if (lead_id && colunaDestino && mover_kanban !== false) {
      await moverLeadParaColunaFunil(lead_id, colunaDestino, true).catch(e => console.error('[agenda][mover-kanban]', e.message));
      await registrarEventoLead(lead_id, clienteId, 'agendamento_criado', 'Agendamento criado e lead movido no kanban', { agendamento_id: ins.rows[0].id, tipo: tipoNorm, inicio, coluna_id: colunaDestino }).catch(() => null);
    }
    res.json({ ok: true, agendamento: ins.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/admin/agendamentos/:id', ...exigeAgendamento, async (req, res) => {
  try {
    await garantirEstruturaAgenda();
    const { status, observacao, inicio, fim, funil_coluna_id } = req.body || {};
    const r = await query(
      `UPDATE movatak_agendamentos SET
         status = COALESCE($1, status),
         observacao = CASE WHEN $2::text IS NULL THEN observacao ELSE $2 END,
         inicio = COALESCE($3::timestamptz, inicio),
         fim = COALESCE($4::timestamptz, fim),
         funil_coluna_id = COALESCE($5, funil_coluna_id),
         atualizado_em = NOW()
       WHERE id=$6 RETURNING *`,
      [status || null, observacao !== undefined ? observacao : null, inicio || null, fim || null, funil_coluna_id || null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Agendamento não encontrado.' });
    res.json({ ok: true, agendamento: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Muda o status do agendamento e, opcionalmente, move o lead para uma coluna.
app.patch('/movatak/admin/agendamentos/:id/status', ...exigeAgendamento, async (req, res) => {
  try {
    await garantirEstruturaAgenda();
    const { status, mover_para_coluna_id } = req.body || {};
    if (!status) return res.status(400).json({ error: 'Informe o status.' });
    const r = await query(
      `UPDATE movatak_agendamentos SET status=$1, atualizado_em=NOW() WHERE id=$2 RETURNING *`,
      [status, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Agendamento não encontrado.' });
    const ag = r.rows[0];
    let leadMovido = false;
    // Se foi pedido pra mover o lead, valida que a coluna é do mesmo cliente e ativa.
    if (mover_para_coluna_id && ag.lead_id) {
      const col = await query(
        'SELECT id FROM movatak_funil_colunas WHERE id=$1 AND cliente_id=$2 AND ativo=true',
        [mover_para_coluna_id, ag.cliente_id]
      );
      if (col.rows.length) {
        await moverLeadParaColunaFunil(ag.lead_id, mover_para_coluna_id).catch(() => null);
        await registrarEventoLead(ag.lead_id, ag.cliente_id, 'agenda_status', `Agendamento "${ag.titulo || ''}" → ${status}`, { agendamento_id: ag.id, status }).catch(() => null);
        leadMovido = true;
      }
    }
    res.json({ ok: true, agendamento: ag, lead_movido: leadMovido });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Exclui um agendamento permanentemente (delete real).
// Não apaga o lead nem a conversa.
app.delete('/movatak/admin/agendamentos/:id', ...exigeAgendamento, async (req, res) => {
  try {
    await garantirEstruturaAgenda();
    const r = await query(
      `DELETE FROM movatak_agendamentos WHERE id=$1 RETURNING id, lead_id, cliente_id, titulo`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Agendamento não encontrado.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/clientes/:id/funil/colunas', ...forcaClienteIdNaUrl, async (req, res) => {
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

app.patch('/movatak/admin/funil/colunas/:id', ...exigeColuna, async (req, res) => {
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

app.patch('/movatak/admin/funil/colunas/:id/setor', ...exigeColuna, async (req, res) => {
  try {
    const setorId = req.body && req.body.setor_id ? parseInt(req.body.setor_id, 10) : null;
    const r = await query(
      `UPDATE movatak_funil_colunas SET setor_id = $1, atualizado_em = NOW() WHERE id = $2 RETURNING *`,
      [setorId, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Coluna não encontrada.' });
    res.json({ ok: true, coluna: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/admin/funil/colunas/:id/ausencia', ...exigeColuna, async (req, res) => {
  try {
    const ativa = !!(req.body && req.body.ausencia_ativa);
    const r = await query(
      `UPDATE movatak_funil_colunas SET ausencia_ativa = $1, atualizado_em = NOW() WHERE id = $2 RETURNING *`,
      [ativa, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Coluna não encontrada.' });
    res.json({ ok: true, coluna: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/admin/funil/colunas/:id/ia', ...exigeColuna, async (req, res) => {
  try {
    const ativa = !!(req.body && req.body.ia_ativa);
    const r = await query(
      `UPDATE movatak_funil_colunas SET ia_ativa = $1, atualizado_em = NOW() WHERE id = $2 RETURNING *`,
      [ativa, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Coluna não encontrada.' });
    res.json({ ok: true, coluna: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/movatak/admin/funil/colunas/:id', ...exigeColuna, async (req, res) => {
  try {
    await garantirEstruturaFunil();
    // Colunas de vendedor são virtuais no front (ex: "vendedor_12") — nunca chegam
    // como ID numérico real. Se vier algo não-numérico, rejeita explicitamente.
    const idRaw = String(req.params.id || '');
    if (idRaw.startsWith('vendedor_') || idRaw.startsWith('vendedor-')) {
      return res.status(400).json({ error: 'Colunas de vendedor não podem ser excluídas pelo kanban. Remova ou desative o vendedor no menu de vendedores.' });
    }
    const colId = parseInt(idRaw, 10);
    if (!Number.isFinite(colId)) return res.status(400).json({ error: 'ID inválido.' });

    // Confirmação e destino são obrigatórios (regra do briefing).
    const { confirmar, destino_coluna_id } = req.body || {};
    if (!confirmar) return res.status(400).json({ error: 'Confirmação obrigatória para excluir a coluna.' });
    if (!destino_coluna_id) return res.status(400).json({ error: 'Escolha uma coluna de destino para realocar os leads.' });

    const cr = await query('SELECT id, cliente_id, nome FROM movatak_funil_colunas WHERE id=$1 AND ativo=true', [colId]);
    if (!cr.rows.length) return res.status(404).json({ error: 'Coluna não encontrada.' });
    const col = cr.rows[0];

    // O destino precisa ser uma coluna ativa do MESMO cliente e diferente da que será excluída.
    const destId = parseInt(destino_coluna_id, 10);
    if (destId === colId) return res.status(400).json({ error: 'A coluna de destino não pode ser a mesma que está sendo excluída.' });
    const dest = await query('SELECT id FROM movatak_funil_colunas WHERE id=$1 AND cliente_id=$2 AND ativo=true', [destId, col.cliente_id]);
    if (!dest.rows.length) return res.status(400).json({ error: 'Coluna de destino inválida.' });

    // Conta e realoca os leads desta coluna para o destino, registrando o evento.
    const leadsR = await query('SELECT id FROM movatak_leads WHERE funil_coluna_id=$1', [colId]);
    const qtdLeads = leadsR.rows.length;
    if (qtdLeads) {
      await query(
        `UPDATE movatak_leads SET funil_coluna_id=$1, atualizado_em=NOW() WHERE funil_coluna_id=$2`,
        [destId, colId]
      );
      for (const l of leadsR.rows) {
        registrarEventoLead(l.id, col.cliente_id, 'coluna_excluida', `Lead realocado: coluna "${col.nome}" excluída`, { de: colId, para: destId }).catch(() => null);
      }
    }

    // Soft delete — nunca apaga a linha.
    await query('UPDATE movatak_funil_colunas SET ativo=false, atualizado_em=NOW() WHERE id=$1', [colId]);
    res.json({ ok: true, leads_realocados: qtdLeads, destino_coluna_id: destId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/clientes/:id/funil/colunas/reordenar', ...forcaClienteIdNaUrl, async (req, res) => {
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

app.post('/movatak/admin/funil/colunas/:id/sincronizar-whatsapp', ...exigeColuna, async (req, res) => {
  try {
    const tagId = await sincronizarColunaComWhatsapp(req.params.id);
    res.json({ ok: true, zapi_tag_id: tagId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/movatak/admin/leads/:id/vendedor', ...exigeLead, async (req, res) => {
  try {
    const { vendedor_id } = req.body || {};
    await query(
      `UPDATE movatak_leads SET vendedor_id=$1, atualizado_em=NOW() WHERE id=$2`,
      [vendedor_id || null, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


app.post('/movatak/admin/leads/:id/mensagem-kanban', ...exigeLead, async (req, res) => {
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
    await limparPedidoAtendente(lead.id);
    res.json({ ok: true });
  } catch (e) {
    console.error('[funil][mensagem-kanban]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.patch('/movatak/admin/leads/:id/funil', ...exigeLead, async (req, res) => {
  try {
    const colunaId = parseInt(req.body?.coluna_id, 10);
    if (!colunaId) return res.status(400).json({ error: 'Informe a coluna de destino.' });
    const result = await moverLeadParaColunaFunil(req.params.id, colunaId, true);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/admin/clientes/:id/cobertura', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    await garantirEstruturaQuestionario();
    const r = await query('SELECT cep FROM movatak_cobertura_cep WHERE cliente_id = $1 ORDER BY cep ASC', [req.params.id]);
    res.json({ total: r.rows.length, ceps: r.rows.map(x => x.cep) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/clientes/:id/cobertura', ...forcaClienteIdNaUrl, async (req, res) => {
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

app.delete('/movatak/admin/clientes/:id/cobertura', ...forcaClienteIdNaUrl, async (req, res) => {
  try {
    await garantirEstruturaQuestionario();
    await query('DELETE FROM movatak_cobertura_cep WHERE cliente_id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Reset de lead para testes: apaga o lead e tudo ligado a ele, por telefone.
app.post('/movatak/admin/reset-lead', authMovatakOuApp, async (req, res) => {
  try {
    const tel = String((req.body && req.body.telefone) || '').replace(/\D/g, '');
    if (tel.length < 8) return res.status(400).json({ error: 'Telefone inválido.' });

    // Segurança: o cliente só pode resetar leads da PRÓPRIA operação.
    // Para admin, opera em todos. Para cliente, restringe ao cliente_id do token.
    const filtroCliente = req.ehCliente ? ' AND cliente_id = $2' : '';
    const paramsBase = req.ehCliente ? [tel, req.clienteId] : [tel];

    const sel = `SELECT id FROM movatak_leads WHERE regexp_replace(telefone, '[^0-9]', '', 'g') = $1${filtroCliente}`;
    const found = await query(sel, paramsBase);
    const removidos = found.rows.length;
    if (removidos) {
      // Apaga dependências dos leads encontrados (já restritos ao cliente, se for o caso).
      const ids = found.rows.map(r => r.id);
      const phIds = ids.map((_, i) => '$' + (i + 1)).join(',');
      await query(`DELETE FROM movatak_followup WHERE lead_id IN (${phIds})`, ids).catch(() => null);
      await query(`DELETE FROM movatak_mensagens WHERE lead_id IN (${phIds})`, ids).catch(() => null);
      await query(`DELETE FROM movatak_lead_eventos WHERE lead_id IN (${phIds})`, ids).catch(() => null);
      await query(`DELETE FROM movatak_etiqueta_log WHERE lead_id IN (${phIds})`, ids).catch(() => null);
      await query(`DELETE FROM movatak_questionario_estado WHERE lead_id IN (${phIds})`, ids).catch(() => null);
      await query(`DELETE FROM movatak_leads WHERE id IN (${phIds})`, ids);
    }
    res.json({ ok: true, removidos });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// Central de Captação — Google Places (recurso à parte, fora do funil)
// Admin only. Não dispara mensagem automática — promoção é sempre manual.
// ============================================================

// Busca no Google Places (Text Search) e enriquece cada resultado com telefone via Place Details.
// Retorna { itens, textSearchCalls, placeDetailsCalls } para contabilizar consumo da cota.
async function buscarGooglePlaces(nicho, cidade) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) throw new Error('GOOGLE_PLACES_API_KEY não configurada no Railway.');
  const termo = `${nicho} em ${cidade}`;
  const textUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(termo)}&language=pt-BR&region=br&key=${key}`;
  let textSearchCalls = 0, placeDetailsCalls = 0;
  const textResp = await axios.get(textUrl);
  textSearchCalls++;
  if (textResp.data.status && textResp.data.status !== 'OK' && textResp.data.status !== 'ZERO_RESULTS') {
    throw new Error('Google Places: ' + textResp.data.status + (textResp.data.error_message ? ' — ' + textResp.data.error_message : ''));
  }
  const results = textResp.data.results || [];
  const detalhados = [];
  for (const r of results.slice(0, 20)) {
    try {
      const detUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${r.place_id}&fields=name,formatted_phone_number,international_phone_number,formatted_address&language=pt-BR&key=${key}`;
      const detResp = await axios.get(detUrl);
      placeDetailsCalls++;
      const d = detResp.data.result || {};
      const telefoneRaw = d.international_phone_number || d.formatted_phone_number || '';
      const telefone = telefoneRaw.replace(/\D/g, '');
      detalhados.push({
        place_id: r.place_id,
        nome: d.name || r.name,
        telefone,
        endereco: d.formatted_address || r.formatted_address,
        categoria: (r.types || [])[0] || null
      });
    } catch (e) { /* ignora item individual com erro, segue os demais */ }
  }
  return { itens: detalhados, textSearchCalls, placeDetailsCalls };
}

// Cota grátis mensal ESTIMADA por SKU (Google mudou p/ cotas por SKU em 2025).
// Ajustável por env se o Google alterar. O gargalo real é o Place Details.
const CAPTACAO_COTA_TEXT_SEARCH = Number(process.env.CAPTACAO_COTA_TEXT_SEARCH || 5000);
const CAPTACAO_COTA_PLACE_DETAILS = Number(process.env.CAPTACAO_COTA_PLACE_DETAILS || 5000);
function mesAtualStr() {
  const d = new Date();
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

app.post('/movatak/admin/captacao/buscar', authMovatakOuApp, async (req, res) => {
  if (req.ehCliente) return res.status(403).json({ error: 'Recurso restrito ao admin.' });
  try {
    await garantirEstruturaCaptacao();
    const { nicho, cidade } = req.body;
    if (!nicho || !String(nicho).trim() || !cidade || !String(cidade).trim()) {
      return res.status(400).json({ error: 'Informe nicho e cidade.' });
    }
    const nichoT = String(nicho).trim();
    const cidadeT = String(cidade).trim();
    const { itens: encontrados, textSearchCalls, placeDetailsCalls } = await buscarGooglePlaces(nichoT, cidadeT);
    let novos = 0, semTelefone = 0, existentes = 0;
    for (const item of encontrados) {
      if (!item.telefone) { semTelefone++; continue; }
      const r = await query(
        `INSERT INTO movatak_leads_captacao (nome, telefone, endereco, categoria, cidade, nicho_busca, place_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (place_id) WHERE place_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [item.nome, item.telefone, item.endereco, item.categoria, cidadeT, nichoT, item.place_id]
      ).catch((e) => { console.error('[captacao] erro ao inserir lead:', e.message); return { rows: [] }; });
      if (r.rows.length) novos++; else existentes++;
    }
    await query(
      `INSERT INTO movatak_captacao_uso (mes, buscas, text_search, place_details, atualizado_em)
       VALUES ($1, 1, $2, $3, NOW())
       ON CONFLICT (mes) DO UPDATE SET
         buscas = movatak_captacao_uso.buscas + 1,
         text_search = movatak_captacao_uso.text_search + EXCLUDED.text_search,
         place_details = movatak_captacao_uso.place_details + EXCLUDED.place_details,
         atualizado_em = NOW()`,
      [mesAtualStr(), textSearchCalls, placeDetailsCalls]
    ).catch((e) => console.error('[captacao] erro ao registrar uso:', e.message));
    res.json({ ok: true, encontrados: encontrados.length, novos, existentes, semTelefone });
  } catch (e) { res.status(500).json({ error: e.response?.data?.error_message || e.message }); }
});

// Consumo do mês corrente + estimativa de cota grátis restante.
app.get('/movatak/admin/captacao/uso', authMovatakOuApp, async (req, res) => {
  if (req.ehCliente) return res.status(403).json({ error: 'Recurso restrito ao admin.' });
  try {
    await garantirEstruturaCaptacao();
    const mes = mesAtualStr();
    const r = await query('SELECT buscas, text_search, place_details FROM movatak_captacao_uso WHERE mes=$1', [mes]);
    const u = r.rows[0] || { buscas: 0, text_search: 0, place_details: 0 };
    const detalhesRestante = Math.max(0, CAPTACAO_COTA_PLACE_DETAILS - u.place_details);
    const textRestante = Math.max(0, CAPTACAO_COTA_TEXT_SEARCH - u.text_search);
    // O Place Details (telefone) é o gargalo; ~20 por busca.
    const buscasRestantesEstim = Math.floor(detalhesRestante / 20);
    res.json({
      ok: true,
      mes,
      buscas: u.buscas,
      textSearch: u.text_search,
      placeDetails: u.place_details,
      cotaTextSearch: CAPTACAO_COTA_TEXT_SEARCH,
      cotaPlaceDetails: CAPTACAO_COTA_PLACE_DETAILS,
      textSearchRestante: textRestante,
      placeDetailsRestante: detalhesRestante,
      buscasRestantesEstim
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/admin/captacao/leads', authMovatakOuApp, async (req, res) => {
  if (req.ehCliente) return res.status(403).json({ error: 'Recurso restrito ao admin.' });
  try {
    await garantirEstruturaCaptacao();
    const { cidade, nicho, promovido, whatsapp } = req.query;
    const cond = [];
    const params = [];
    if (cidade) { params.push('%' + cidade + '%'); cond.push(`cidade ILIKE $${params.length}`); }
    if (nicho) { params.push('%' + nicho + '%'); cond.push(`nicho_busca ILIKE $${params.length}`); }
    if (promovido === '0') cond.push(`promovido = false`);
    if (promovido === '1') cond.push(`promovido = true`);
    if (whatsapp === '1') cond.push(`tem_whatsapp = true`);
    if (whatsapp === '0') cond.push(`tem_whatsapp = false`);
    if (whatsapp === 'null') cond.push(`tem_whatsapp IS NULL`);
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const r = await query(`SELECT * FROM movatak_leads_captacao ${where} ORDER BY criado_em DESC LIMIT 500`, params);
    res.json({ ok: true, leads: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Limpa os leads capturados ainda NÃO promovidos. Os já promovidos (que viraram
// card no funil) são preservados para manter o histórico do que foi enviado.
app.delete('/movatak/admin/captacao/leads', authMovatakOuApp, async (req, res) => {
  if (req.ehCliente) return res.status(403).json({ error: 'Recurso restrito ao admin.' });
  try {
    await garantirEstruturaCaptacao();
    const r = await query('DELETE FROM movatak_leads_captacao WHERE promovido = false', []);
    res.json({ ok: true, removidos: r.rowCount || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/admin/captacao/colunas/:clienteId', authMovatakOuApp, async (req, res) => {
  if (req.ehCliente) return res.status(403).json({ error: 'Recurso restrito ao admin.' });
  try {
    const r = await query('SELECT id, nome FROM movatak_funil_colunas WHERE cliente_id=$1 AND ativo=true ORDER BY ordem ASC', [req.params.clienteId]);
    res.json({ ok: true, colunas: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Verifica no WhatsApp os leads ainda não checados (tem_whatsapp IS NULL) do filtro atual.
// Usa a instância fixa da captação (env). Processa em série pra não estourar a Z-API.
app.post('/movatak/admin/captacao/verificar-whatsapp', authMovatakOuApp, async (req, res) => {
  if (req.ehCliente) return res.status(403).json({ error: 'Recurso restrito ao admin.' });
  try {
    await garantirEstruturaCaptacao();
    if (!process.env.ZAPI_CAPTACAO_INSTANCE || !process.env.ZAPI_CAPTACAO_TOKEN) {
      return res.status(400).json({ error: 'Instância Z-API de captação não configurada no Railway.' });
    }
    const { cidade, nicho } = req.body || {};
    const cond = ['tem_whatsapp IS NULL'];
    const params = [];
    if (cidade) { params.push('%' + cidade + '%'); cond.push(`cidade ILIKE $${params.length}`); }
    if (nicho) { params.push('%' + nicho + '%'); cond.push(`nicho_busca ILIKE $${params.length}`); }
    const r = await query(
      `SELECT id, telefone FROM movatak_leads_captacao WHERE ${cond.join(' AND ')} ORDER BY criado_em DESC LIMIT 100`,
      params
    );
    let comWhats = 0, semWhats = 0, indefinido = 0;
    for (const lead of r.rows) {
      const existe = await zapiPhoneExiste(lead.telefone);
      if (existe === true) comWhats++;
      else if (existe === false) semWhats++;
      else { indefinido++; continue; } // null: não marca, permite tentar de novo depois
      await query('UPDATE movatak_leads_captacao SET tem_whatsapp=$1 WHERE id=$2', [existe, lead.id]).catch(() => null);
    }
    res.json({ ok: true, verificados: r.rows.length, comWhats, semWhats, indefinido });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/movatak/admin/captacao/promover', authMovatakOuApp, async (req, res) => {
  if (req.ehCliente) return res.status(403).json({ error: 'Recurso restrito ao admin.' });
  try {
    await garantirEstruturaCaptacao();
    await garantirEstruturaFunil();
    const { ids, clienteId, colunaId } = req.body;
    if (!Array.isArray(ids) || !ids.length || !clienteId) {
      return res.status(400).json({ error: 'Informe ids[] e clienteId.' });
    }
    let promovidos = 0, duplicados = 0;
    for (const id of ids) {
      const c = await query('SELECT * FROM movatak_leads_captacao WHERE id=$1 AND promovido=false', [id]);
      if (!c.rows.length) continue;
      const cap = c.rows[0];
      const existe = await query('SELECT id FROM movatak_leads WHERE cliente_id=$1 AND telefone=$2 LIMIT 1', [clienteId, cap.telefone]);
      let leadId;
      if (existe.rows.length) {
        leadId = existe.rows[0].id;
        duplicados++;
      } else {
        const ins = await query(
          `INSERT INTO movatak_leads (cliente_id, nome, telefone, etapa, origem, nao_lida, criado_em, atualizado_em)
           VALUES ($1,$2,$3,'lead','captacao_google_places',false,NOW(),NOW()) RETURNING id`,
          [clienteId, cap.nome || cap.telefone, cap.telefone]
        );
        leadId = ins.rows[0].id;
        promovidos++;
      }
      if (colunaId) {
        await moverLeadParaColunaFunil(leadId, colunaId, false).catch(() => null);
      }
      await query('UPDATE movatak_leads_captacao SET promovido=true, promovido_em=NOW(), lead_id=$1 WHERE id=$2', [leadId, id]);
    }
    res.json({ ok: true, promovidos, duplicados });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/health', (req, res) => {
  res.json({ status: 'ok', version: MOVATAK_VERSION, ts: new Date().toISOString() });
});

// Contador de mensagens do mês corrente + estimativa de custo (WhatsApp per-message).
// Admin vê o total geral e a quebra por cliente; cliente vê só o próprio.
// A taxa por mensagem é informada pelo frontend (?taxa=) por ser configurável.
app.get('/movatak/admin/uso-mensagens', authMovatakOuApp, async (req, res) => {
  try {
    const taxa = Number(req.query.taxa);
    const taxaCobravel = (Number.isFinite(taxa) && taxa >= 0) ? taxa : 0.12;
    // Primeiro dia do mês corrente (UTC), alinhado ao ciclo de cobrança.
    const agora = new Date();
    const inicioMes = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), 1, 0, 0, 0));

    const filtroCliente = req.ehCliente ? 'AND cliente_id = $2' : '';
    const params = req.ehCliente ? [inicioMes.toISOString(), req.clienteId] : [inicioMes.toISOString()];

    const tot = await query(
      `SELECT
         COUNT(*) FILTER (WHERE direcao='saida')   AS enviadas,
         COUNT(*) FILTER (WHERE direcao='entrada')  AS recebidas
       FROM movatak_conversas
       WHERE criado_em >= $1 ${filtroCliente}`,
      params
    );
    const enviadas = Number(tot.rows[0].enviadas || 0);
    const recebidas = Number(tot.rows[0].recebidas || 0);

    // Estimativa de custo: só mensagens ENVIADAS são cobráveis (as recebidas nunca custam).
    // É uma estimativa — o custo real do Meta depende da categoria e da janela de 24h,
    // que o CRM não classifica hoje. A taxa é configurável para refletir a média do gestor.
    const custoEstimado = Number((enviadas * taxaCobravel).toFixed(2));

    const resposta = {
      ok: true,
      mes: inicioMes.toISOString().slice(0, 7),
      taxa: taxaCobravel,
      enviadas, recebidas,
      total: enviadas + recebidas,
      custo_estimado: custoEstimado,
      ehCliente: !!req.ehCliente
    };

    // Admin: quebra por cliente.
    if (!req.ehCliente) {
      const porCliente = await query(
        `SELECT c.id, c.nome,
                COUNT(*) FILTER (WHERE cv.direcao='saida')  AS enviadas,
                COUNT(*) FILTER (WHERE cv.direcao='entrada') AS recebidas
           FROM movatak_conversas cv
           JOIN movatak_clientes c ON c.id = cv.cliente_id
          WHERE cv.criado_em >= $1
          GROUP BY c.id, c.nome
          ORDER BY enviadas DESC`,
        [inicioMes.toISOString()]
      );
      resposta.por_cliente = porCliente.rows.map(r => ({
        id: r.id, nome: r.nome,
        enviadas: Number(r.enviadas || 0),
        recebidas: Number(r.recebidas || 0),
        custo_estimado: Number((Number(r.enviadas || 0) * taxaCobravel).toFixed(2))
      }));
    }
    res.json(resposta);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/movatak/version', (req, res) => {
  res.json({ version: MOVATAK_VERSION });
});

// ============================================================
// Start
// ============================================================
const PORT = process.env.MOVATAK_PORT || process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`[Movatak] Backend ${MOVATAK_VERSION} rodando na porta ${PORT}`);
  garantirEstruturaQuestionario().catch(e => console.error('[questionario] schema:', e.message));
  garantirEstruturaPlanos().catch(e => console.error('[planos] schema:', e.message));
  garantirEstruturaFunil().catch(e => console.error('[funil] schema:', e.message));
  garantirEstruturaCaptacao().catch(e => console.error('[captacao] schema:', e.message));
});
