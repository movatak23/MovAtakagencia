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
  garantirEstruturaAgenda, garantirEstruturaCaptacao, garantirEstruturaAssinaturas
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

const webhook = require('./src/webhook');
const {
  handleMensagem, handleEtiqueta, handleResposta, handleStatus, handleZapiStatus, handleZapi
} = webhook;

const menu = require('./src/menu');
const { enviarBoasVindasLead, enviarMenuAtendimento, processarRespostaMenu } = menu;

const funil = require('./src/funil');
const { moverLeadParaFunilSlug, moverLeadParaColunaFunil, atribuirVendedorBalanceado } = funil;

const antispam = require('./src/antispam');
const {
  contarMensagensAutomaticasHoje, podeEnviarMensagemAutomatica,
  reentradaFU1Permitida, leadRespondeuRecentemente
} = antispam;

const ausencia = require('./src/ausencia');
const { dispararAusenciaSeAplicavel, avaliarAusencia, clienteRowEmAusencia } = ausencia;

const rotasAdmin = require('./src/routes/admin');

const rotasVendedor = require('./src/routes/vendedor');

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

// Injeta no webhook (4a) as deps ainda no index.js. Hoisted.
webhook.init({ textoBateGatilho, comandosDoVendedor, contemComando, localizarCampanhaPorGatilho, normalizarGatilho, resolverReplyInfoLead });

// Materializa o schema de assinaturas/mensalidade no boot (idempotente,
// defaults nao-bloqueantes). Fase A da feature de mensalidade. Ver ASSINATURAS.md.
garantirEstruturaAssinaturas().catch(() => null);

// Injeta no funil os sub-helpers que ainda vivem no index.js
// (dependem de nicho/zapi-extractors). Function declarations sao hoisted.
funil.init({ garantirFunilPadraoCliente, etapaSistemaPorSlug, sincronizarColunaComWhatsapp });

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

// [refatoracao 4b] registrarWebhookCliente() -> src/webhook.js

// [refatoracao util] registrarErroZapi() -> src/util.js

// [refatoracao 4b] csvEscape() -> src/webhook.js

// [refatoracao antispam] contarMensagensAutomaticasHoje() -> src/antispam.js

// [refatoracao antispam] podeEnviarMensagemAutomatica() -> src/antispam.js

// [refatoracao antispam] reentradaFU1Permitida() -> src/antispam.js

// [refatoracao antispam] leadRespondeuRecentemente() -> src/antispam.js

// [refatoracao util] ehGrupoOuCanal() -> src/util.js

// [refatoracao ausencia] dispararAusenciaSeAplicavel() -> src/ausencia.js

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
app.post('/movatak/webhook/mensagem', handleMensagem);

// ============================================================
// ROTA 2 — Webhook de etiqueta aplicada
// Z-API → POST /webhook/etiqueta
// ============================================================
app.post('/movatak/webhook/etiqueta', handleEtiqueta);

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
app.post('/movatak/webhook/resposta', handleResposta);

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
// [refatoracao 5a] 142 rotas /movatak/admin/* -> src/routes/admin.js (registradas por rotasAdmin.register no boot)

// Cadastrar cliente novo (onboarding)

// Config pós-follow-up (ação quando a régua termina sem resposta). Endpoint dedicado
// para não passar pela validação do formulário completo (nome/WhatsApp/Instance).

// Buscar dados de um cliente para edição (sem expor token/client-token)

// Editar dados de um cliente. Token e client-token só são alterados se enviados.
// Salva APENAS as credenciais de acesso ao portal (email/senha) de um cliente.
// Endpoint dedicado — não exige os campos do cadastro completo.


// Leads de um cliente específico

// Buscar mensagens de follow up de um cliente



// Atualizar mensagens de follow up de um cliente (novo formato: 2 blocos)

// Atualizar plano de um lead (quando atendente informa qual plano foi vendido)


// Listar vendedores de um cliente

// Cadastrar vendedor e criar etiqueta na Z-API

// Remover vendedor

// ============================================================
// Setores (filas) — atendimento dividido por departamento dentro do mesmo WhatsApp
// ============================================================

// Listar setores de um cliente, com a lista de vendedores vinculados a cada um

// Criar setor novo

// Editar setor (nome, cor, mensagem, ordem)

// Remover setor (soft delete)

// Vincular ou desvincular um vendedor de um setor


// Transferir um lead para outro setor (e opcionalmente outro vendedor) — segue o
// mesmo padrão de auditoria já usado em /movatak/admin/leads/:id/vendedor

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

// Retorna a foto de perfil do lead. Usa cache de 24h (foto_atualizada_em). Se estiver
// vazia ou velha, busca no Z-API uma vez e salva. A URL do WhatsApp expira ~48h, por
// isso renovamos sob demanda em vez de guardar para sempre.
// Chamado pelo frontend quando a foto (URL do WhatsApp) falha ao carregar —
// limpa foto_url para não tentar de novo e poluir o console com 404 externos.


// Arquiva/desarquiva um lead na caixa de entrada (não afeta o WhatsApp real,
// é só organização dentro do CRM — diferente de acao_arquivar_ao_final).

// Ranking de vendedores

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

// [refatoracao 4b] vendedorBateComando() -> src/webhook.js

// [refatoracao 4b] textoBateComandoParar() -> src/webhook.js

// pararAtendimentoLead, limparPedidoAtendente → src/leads.js

const MSG_PARAR_PADRAO = 'Perfeito{nome}! Já registrei seu pedido. 😊 Em breve um dos nossos atendentes vai falar com você por aqui.';// Dedup em memória: evita mandar várias confirmações se o lead repetir o
// comando em sequência (ex: digitou 3x seguidas achando que não foi).
const _ultimaConfirmacaoAtendente = new Map();
// [refatoracao 4b] enviarConfirmacaoAtendente() -> src/webhook.js

// [refatoracao 4b] textoBateComandoAtivar() -> src/webhook.js

// Procura uma coluna do funil cujo "comando" bate o texto e move o lead pra ela.
// Retorna true se moveu. Usado pelos comandos de coluna (fromMe).
// [refatoracao 4b] moverLeadPorComandoColuna() -> src/webhook.js

// [refatoracao 3b] reiniciarQuestionarioLead() -> src/questionario.js

// [refatoracao 4b] textoPareceComandoInterno() -> src/webhook.js


// [refatoracao util] extrairDigitosTelefone() -> src/util.js

// [refatoracao util] telefonesEquivalentes() -> src/util.js

// [refatoracao 4b] telefoneEhDaEmpresa() -> src/webhook.js

// [refatoracao 4b] primeiroTelefoneValido() -> src/webhook.js

// [refatoracao 4b] extrairTelefonePayload() -> src/webhook.js

// [refatoracao 4b] extrairNomeContatoPayloadZapi() -> src/webhook.js

// Extrai a URL da foto de perfil que o Z-API às vezes já manda no payload do webhook.
// Quando presente, é grátis (não precisa chamar a API). Vale ~48h.
// [refatoracao 4b] extrairFotoPayloadZapi() -> src/webhook.js

// [refatoracao util] variantesTelefone() -> src/util.js

// Busca um lead por telefone tolerando a diferença do 9º dígito.
// [refatoracao 4b] buscarLeadPorTelefone() -> src/webhook.js

// [refatoracao 4b] extrairTextoPayloadZapi() -> src/webhook.js

// [refatoracao 4b] extrairMidiaPayloadZapi() -> src/webhook.js


// [refatoracao 4b] primeiroValor() -> src/webhook.js

// [refatoracao 4b] textoDePossivelMensagem() -> src/webhook.js

// [refatoracao 4b] tipoMidiaDePossivelMensagem() -> src/webhook.js

// [refatoracao 4b] urlMidiaDePossivelMensagem() -> src/webhook.js

// [refatoracao 4b] extrairReplyPayloadZapi() -> src/webhook.js

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

// [refatoracao 4b] localizarLeadPorPayload() -> src/webhook.js

app.post('/movatak/webhook/zapi', handleZapi);

// Diagnóstico do webhook Z-API: saúde em segundos, sem expor payload nem dados de lead.
// Sem auth (como /health e /version) — retorna só contadores agregados.
app.get('/movatak/webhook/status', handleStatus);

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

// Atualizar comandos de um cliente

// ============================================================
// Menu de Atendimento — lead escolhe o setor digitando uma opção
// ============================================================

// Ler a configuração do menu de um cliente

// Salvar a configuração do menu

// Atualizar comando de um vendedor


// Atualizar acesso do vendedor ao portal individual

// Define os setores que um vendedor acessa (substitui o conjunto atual).

// [refatoracao 5b] 47 rotas /movatak/vendedor/* -> src/routes/vendedor.js (registradas por rotasVendedor.register no boot)


// ============================================================
// FUNIL DO VENDEDOR — escopo restrito aos setores do vendedor logado.
// O controle de acesso é feito AQUI no backend: o vendedor só recebe colunas e
// leads dos setores aos quais ele pertence. Mesmo que o front peça outro setor,
// o servidor recusa.
// ============================================================


// Conversa de um lead — só se o lead estiver num setor do vendedor.

// Enviar mensagem pelo vendedor — só se o lead for de um setor dele.



// Mover lead entre colunas (dentro do escopo do vendedor) e marcar lido/não lido.


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




















async function vendedorPodeAgendamento(req, agendamentoId) {
  const r = await query(`SELECT a.*, l.setor_id FROM movatak_agendamentos a LEFT JOIN movatak_leads l ON l.id=a.lead_id WHERE a.id=$1 AND a.cliente_id=$2`, [agendamentoId, req.vendedor.cliente_id]).catch(() => ({ rows: [] }));
  const ag = r.rows[0] || null;
  if (!ag) return null;
  if (ag.lead_id && !vendedorPodeSetor(req, ag.setor_id)) return null;
  return ag;
}













// Operações extras do CRM do vendedor — mesmas ações da tela do admin,
// sempre limitadas aos setores liberados para o vendedor logado.









// ============================================================
// API — Resumo de um cliente (cards do topo do dashboard)
// ============================================================


// ============================================================
// API — Operação e fila de follow-up
// ============================================================






// Histórico completo de um lead

// [refatoracao 3c] chamarHaiku() -> src/ia.js

// Gera uma sugestão de resposta para o lead, imitando o estilo das respostas
// anteriores do próprio atendente (puxadas do histórico de conversas).
// Transcreve um áudio (URL pública) para texto usando a API Whisper da OpenAI.
// Requer OPENAI_API_KEY no ambiente.

// Dispensa o lead das prioridades. Ele só reaparece se mandar nova mensagem
// (mensagem com data posterior à dispensa).

// Resumo da conversa do lead por IA — para o vendedor entender o contexto rápido.

// [refatoracao 3c] gerarRespostaIALead() -> src/ia.js


// [refatoracao 3c] enviarComPausasHumanas() -> src/ia.js

// [refatoracao 3c] _normalizarTextoTrava() -> src/ia.js

// [refatoracao 3c] assuntoExigeHumano() -> src/ia.js

// [refatoracao 3c] respostaIAViolaTravas() -> src/ia.js

// [refatoracao 3c] transferirIAParaHumano() -> src/ia.js

// [refatoracao 3c] iaResponderAutomatico() -> src/ia.js

// (delete for everyone, só funciona pra mensagens que a gente mandou e dentro
// da janela de tempo que o WhatsApp permite) e remove do nosso histórico de
// qualquer forma, pra não ficar uma mensagem "travada" caso o lado do WhatsApp falhe.


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









// Webhook opcional da Z-API para status de mensagem: enviado/entregue/lido/falha.
// Configure no painel Z-API apontando para /movatak/webhook/zapi-status.
app.post('/movatak/webhook/zapi-status', handleZapiStatus);


// Rota de teste do R2 (temporária). Faz upload de um texto, baixa de volta e
// confirma que a integração funciona ponta a ponta. Remover após validar.


// ===== ANEXOS DO LEAD (documentos no R2) =====
const ANEXO_MAX_BYTES = 10 * 1024 * 1024; // 10MB
const ANEXO_TIPOS_OK = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain', 'text/csv'];

// Lista os anexos de um lead.

// Upload de anexo (recebe base64 no corpo JSON). O backend manda pro R2 e salva o registro.

// Download de um anexo (busca do R2 e envia o arquivo).

// Remove um anexo (apaga do R2 e do banco).

// Define/atualiza o comentário de um anexo (texto livre, esvaziar remove).


// Remove uma anotação manual (só eventos do tipo 'anotacao' podem ser apagados).

// Lista operacional de leads do cliente

// Exportação CSV simples para reunião/prestação de contas

// ============================================================
// Backup completo do cliente (somente leitura) — config + leads + conversas + tudo
// que tem cliente_id. Descobre as tabelas por introspecção: nunca referencia coluna
// inexistente e se adapta a mudanças futuras de schema. Baixa como JSON no PC do admin.
// ============================================================

// ============================================================
// Conexão do WhatsApp (status / reiniciar / QR) — mesma rota serve admin e portal.
// No portal, forcaClienteIdNaUrl trava no próprio cliente (cada um só vê a sua instância).
// ============================================================

// Envio manual do relatório diário para teste/implantação


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

// [refatoracao ausencia] avaliarAusencia() -> src/ausencia.js

// [refatoracao ausencia] clienteRowEmAusencia() -> src/ausencia.js

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

// [refatoracao menu] enviarBoasVindasLead() -> src/menu.js

// [refatoracao menu] enviarMenuAtendimento() -> src/menu.js

// [refatoracao menu] processarRespostaMenu() -> src/menu.js

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


// Atualiza as mensagens de um TEMPLATE específico (o selecionado no dropdown).
// Só templates personalizados (custom:ID) podem ser editados — os padrão são fixos.








// Exclui o lead DEFINITIVAMENTE, junto com todos os dados relacionados a ele.
// Diferente de "descartar" (que só muda a etapa) — aqui o lead some do sistema.

// ============================================================
// Health check + Versão
// ============================================================
// ============================================================
// API — Planos/Pacotes por cliente (usados na recomendação por pontuação)
// ============================================================




// ============================================================
// API — Questionário consultivo (config por cliente + cobertura CEP)
// ============================================================




// ============================================================
// API — Templates de autoatendimento (questionário) por campanha
// ============================================================






// API — Mensagens Rápidas (enviadas manualmente do Kanban)
// ============================================================

// normalizarReplyInfoConversa, registrarConversa → src/leads.js






// Incrementa o ranking de uso por ID — usado pelas sequências, já que o texto
// salvo é só um resumo e não bate com o texto de nenhuma mensagem realmente enviada.

// Inicia o autoatendimento de um template a partir do painel, para um lead.
// Reaproveita o MESMO motor do autoatendimento automático, então respeita tudo:
// perguntas que esperam resposta do lead, saltos, opções, delays, etc.


// Alias usado pelo Kanban. Mantém compatibilidade com telas que chamam /mensagem-kanban
// em vez de /mensagem-rapida.



// [refatoracao funil] atribuirVendedorBalanceado() -> src/funil.js

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

// [refatoracao funil] moverLeadParaFunilSlug() -> src/funil.js

// [refatoracao funil] moverLeadParaColunaFunil() -> src/funil.js

// Reconcilia o setor dos leads com o setor das colunas onde eles estão. Útil para
// corrigir leads movidos antes do fix (que ficaram com setor_id de um setor mas em
// coluna de outro). Atualiza só quando há divergência.


// ── DASHBOARD SLA — tempo de resposta por setor e vendedor ───
// Cruza cada mensagem de ENTRADA (lead) com a próxima SAÍDA, calcula o gap,
// e agrega por setor → vendedor. Separa respostas humanas de automáticas.


// Métricas do rodapé do Funil de Atendimento (Total de leads, Novas mensagens,
// Em negociação, Conversão do mês). Aceita o mesmo filtro ?setor= do board.







// Muda o status do agendamento e, opcionalmente, move o lead para uma coluna.

// Exclui um agendamento permanentemente (delete real).
// Não apaga o lead nem a conversa.
















// Reset de lead para testes: apaga o lead e tudo ligado a ele, por telefone.

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


// Consumo do mês corrente + estimativa de cota grátis restante.


// Limpa os leads capturados ainda NÃO promovidos. Os já promovidos (que viraram
// card no funil) são preservados para manter o histórico do que foi enviado.


// Verifica no WhatsApp os leads ainda não checados (tem_whatsapp IS NULL) do filtro atual.
// Usa a instância fixa da captação (env). Processa em série pra não estourar a Z-API.


app.get('/movatak/health', (req, res) => {
  res.json({ status: 'ok', version: MOVATAK_VERSION, ts: new Date().toISOString() });
});

// Contador de mensagens do mês corrente + estimativa de custo (WhatsApp per-message).
// Admin vê o total geral e a quebra por cliente; cliente vê só o próprio.
// A taxa por mensagem é informada pelo frontend (?taxa=) por ser configurável.

app.get('/movatak/version', (req, res) => {
  res.json({ version: MOVATAK_VERSION });
});

// ============================================================
// Start
// ============================================================
const PORT = process.env.MOVATAK_PORT || process.env.PORT || 3001;
// [refatoracao 5a] Registra as rotas /movatak/admin/* (movidas para
// src/routes/admin.js). Chamado no fim do boot, quando todos os middlewares,
// helpers e modulos ja estao definidos. deps = tudo que os handlers admin
// referenciam e que ainda vive no index.js ou em modulos ja extraidos.
rotasAdmin.register(app, {
  ANEXO_MAX_BYTES, ANEXO_TIPOS_OK, CAPTACAO_COTA_PLACE_DETAILS, CAPTACAO_COTA_TEXT_SEARCH, MOVATAK_ADMIN_WA,
  MOVATAK_DEBUG, MOVATAK_VERSION, NICHO_TEMPLATES, R2_BUCKET, R2_ListBucketsCommand,
  R2_PRONTO, TEMPLATES_FOLLOWUP, ZAPI_ADVANCED_ENDPOINTS, agendarFollowupV2, aplicarTemplateNichoCliente,
  authMovatak, authMovatakOuApp, axios, buscarColunaAgenda, buscarGooglePlaces,
  chamarHaiku, config, conflitoAgenda, emitirMensagemApagada, emitirMensagemLead,
  enviarFollowupsPendentesDoLead, erroEstruturaBanco, etapaSistemaPorSlug, exigeAgendamento, exigeCampanha,
  exigeColuna, exigeConversa, exigeLead, exigeMsgRapida, exigePlano,
  exigeQuestTemplate, exigeSetor, exigeTemplateFU, exigeVendedor, extrairComandosDoBody,
  followups, forcaClienteIdNaUrl, garantirColunasClientesPortal, garantirColunasVendedoresPortal, garantirEstruturaAgenda,
  garantirEstruturaCampanhasTemplates, garantirEstruturaCaptacao, garantirEstruturaConversas, garantirEstruturaFunil, garantirEstruturaMensagensRapidas,
  garantirEstruturaPlanos, garantirEstruturaQuestionario, garantirFunilPadraoCliente, gerarRespostaIALead, gerarToken,
  getZapiCreds, hashSenha, iniciarQuestionarioPorTemplate, limparPayloadAvancado, limparPedidoAtendente,
  listarTemplatesCustom, localizarCampanhaPorGatilho, marcarChatLidoNoZap, mesAtualStr, montarRelatorioDiarioCliente,
  moverLeadParaColunaFunil, normalizarGatilho, normalizarListaComandos, normalizarNichoCliente, normalizarPermissoes,
  obterLeadComZapi, obterMensagemComZapi, parseMoedaParaNumero, query, r2Client,
  r2Delete, r2Download, r2Upload, registrarConversa, registrarEventoLead,
  resolverReplyInfoLead, resolverTemplateCampanha, sincronizarColunaComWhatsapp, slugFunilPorEtapa, slugifyFunil,
  textoBateGatilho, tipoMidia, uploadSupabase, variantesTelefone, zapiApagarMensagem,
  zapiBuscarFoto, zapiEditarTexto, zapiEncaminharMensagem, zapiEnviar, zapiEnviarAudio,
  zapiEnviarContato, zapiEnviarDocumento, zapiEnviarImagem, zapiEnviarLink, zapiEnviarLocalizacao,
  zapiEnviarVideo, zapiHeaders, zapiLerMensagem, zapiListarChats, zapiModificarChat,
  zapiPhoneExiste, zapiPost, zapiQrImagem, zapiReagirMensagem, zapiRestart,
  zapiStatus,
});
// [refatoracao 5b] Registra as rotas /movatak/vendedor/* (movidas para
// src/routes/vendedor.js). Chamado no fim do boot, quando todos os middlewares,
// helpers e modulos ja estao definidos. deps = tudo que os handlers vendedor
// referenciam e que ainda vive no index.js ou em modulos ja extraidos.
rotasVendedor.register(app, {
  ZAPI_ADVANCED_ENDPOINTS, agendarFollowupV2, authVendedor, axios, buscarColunaAgenda,
  conflitoAgenda, emitirMensagemApagada, emitirMensagemLead, enviarFollowupsPendentesDoLead, etapaSistemaPorSlug,
  garantirColunasVendedoresPortal, garantirEstruturaAgenda, garantirEstruturaFunil, garantirEstruturaMensagensRapidas, garantirEstruturaQuestionario,
  hashSenha, iniciarQuestionarioPorTemplate, limparPayloadAvancado, limparPedidoAtendente, marcarChatLidoNoZap,
  montarPayloadRespostaZapi, moverLeadParaColunaFunil, query, registrarConversa, registrarEventoLead,
  resolverReplyInfoLead, sincronizarColunaComWhatsapp, slugFunilPorEtapa, slugifyFunil, tipoMidia,
  uploadSupabase, vendedorPodeAgendamento, vendedorPodeColuna, vendedorPodeConversa, vendedorPodeLead,
  vendedorPodeSetor, zapiApagarMensagem, zapiEditarTexto, zapiEncaminharMensagem, zapiEnviar,
  zapiEnviarAudio, zapiEnviarContato, zapiEnviarDocumento, zapiEnviarImagem, zapiEnviarLink,
  zapiEnviarLocalizacao, zapiEnviarVideo, zapiHeaders, zapiLerMensagem, zapiModificarChat,
  zapiPost, zapiReagirMensagem,
});
httpServer.listen(PORT, () => {
  console.log(`[Movatak] Backend ${MOVATAK_VERSION} rodando na porta ${PORT}`);
  garantirEstruturaQuestionario().catch(e => console.error('[questionario] schema:', e.message));
  garantirEstruturaPlanos().catch(e => console.error('[planos] schema:', e.message));
  garantirEstruturaFunil().catch(e => console.error('[funil] schema:', e.message));
  garantirEstruturaCaptacao().catch(e => console.error('[captacao] schema:', e.message));
});
