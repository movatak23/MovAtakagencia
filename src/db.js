'use strict';

const { Pool } = require('pg');

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
    ADD COLUMN IF NOT EXISTS trigger_msg TEXT,
    ADD COLUMN IF NOT EXISTS nicho TEXT,
    ADD COLUMN IF NOT EXISTS ia_oferta TEXT,
    ADD COLUMN IF NOT EXISTS ia_tom TEXT,
    ADD COLUMN IF NOT EXISTS ia_resumo TEXT,
    ADD COLUMN IF NOT EXISTS portal_email TEXT,
    ADD COLUMN IF NOT EXISTS portal_senha_hash TEXT,
    ADD COLUMN IF NOT EXISTS portal_senha_trocada_em TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS quest_lembrete_msg TEXT,
    ADD COLUMN IF NOT EXISTS quest_lembrete_minutos INTEGER,
    ADD COLUMN IF NOT EXISTS agenda_ativa BOOLEAN DEFAULT false`, []);
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

function hashStringToInt(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) { h = ((h << 5) - h + str.charCodeAt(i)) | 0; }
  return Math.abs(h);
}
// Trava distribuída no Postgres: só UM processo roda a rotina por vez, mesmo com dois
// backends ligados no mesmo banco. Se não conseguir a trava, pula sem erro.
async function withPgAdvisoryLock(nome, fn) {
  const lockId = hashStringToInt('movatak:' + nome);
  let got = false;
  try {
    const r = await query('SELECT pg_try_advisory_lock($1) AS ok', [lockId]);
    got = !!(r.rows[0] && r.rows[0].ok);
    if (!got) { console.log('[cron] trava ocupada, pulando:', nome); return; }
    return await fn();
  } finally {
    if (got) await query('SELECT pg_advisory_unlock($1)', [lockId]).catch(() => null);
  }
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
    ADD COLUMN IF NOT EXISTS questionario_comando_ativar TEXT,
    ADD COLUMN IF NOT EXISTS questionario_msg_parar TEXT`).catch(() => null);

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
  await query(`ALTER TABLE movatak_questionario_estado ADD COLUMN IF NOT EXISTS template_id INTEGER`).catch(() => null);

  await query(`CREATE TABLE IF NOT EXISTS movatak_cobertura_cep (
    id SERIAL PRIMARY KEY,
    cliente_id INTEGER NOT NULL,
    cep TEXT NOT NULL,
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`).catch(() => null);

  await query(`CREATE INDEX IF NOT EXISTS idx_movatak_quest_estado ON movatak_questionario_estado(cliente_id, telefone, status)`).catch(() => null);
  await query(`ALTER TABLE movatak_questionario_estado ADD COLUMN IF NOT EXISTS tentativas_invalidas INTEGER DEFAULT 0`).catch(() => null);
  await query(`ALTER TABLE movatak_leads ADD COLUMN IF NOT EXISTS automacao_pausada BOOLEAN DEFAULT false`).catch(() => null);
  await query(`ALTER TABLE movatak_leads ADD COLUMN IF NOT EXISTS nao_lida BOOLEAN DEFAULT false`).catch(() => null);
  await query(`ALTER TABLE movatak_leads ADD COLUMN IF NOT EXISTS arquivado BOOLEAN DEFAULT false`).catch(() => null);
  await query(`ALTER TABLE movatak_leads ADD COLUMN IF NOT EXISTS foto_url TEXT`).catch(() => null);
  await query(`ALTER TABLE movatak_leads ADD COLUMN IF NOT EXISTS foto_atualizada_em TIMESTAMPTZ`).catch(() => null);
  // Pós-follow-up: ação automática quando a régua de FU termina sem resposta.
  await query(`ALTER TABLE movatak_clientes ADD COLUMN IF NOT EXISTS pos_followup_acao TEXT DEFAULT 'nenhum'`).catch(() => null);
  await query(`ALTER TABLE movatak_clientes ADD COLUMN IF NOT EXISTS pos_followup_coluna_id INTEGER`).catch(() => null);
  await query(`ALTER TABLE movatak_leads ADD COLUMN IF NOT EXISTS pos_followup_finalizado BOOLEAN DEFAULT false`).catch(() => null);
  // Sinalização visível de que o LEAD pediu pra falar com um atendente humano
  // (comando de parar ou transferência automática por respostas inválidas).
  await query(`ALTER TABLE movatak_leads ADD COLUMN IF NOT EXISTS pediu_atendente BOOLEAN DEFAULT false`).catch(() => null);
  await query(`ALTER TABLE movatak_leads ADD COLUMN IF NOT EXISTS pediu_atendente_em TIMESTAMPTZ`).catch(() => null);
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

async function garantirEstruturaConversas() {
  // Anexos do lead (documentos no R2). A coluna r2_chave guarda o caminho do
  // arquivo no bucket; o conteúdo em si fica no R2, não no banco.
  await query(`CREATE TABLE IF NOT EXISTS movatak_lead_anexos (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER NOT NULL,
    cliente_id INTEGER NOT NULL,
    nome_arquivo TEXT NOT NULL,
    tipo TEXT,
    tamanho INTEGER,
    r2_chave TEXT NOT NULL,
    autor TEXT,
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`).catch(() => null);
  await query(`CREATE INDEX IF NOT EXISTS idx_lead_anexos_lead ON movatak_lead_anexos(lead_id)`).catch(() => null);
  await query(`ALTER TABLE movatak_lead_anexos ADD COLUMN IF NOT EXISTS comentario TEXT`).catch(() => null);

  // Registro bruto de todos os webhooks Z-API — idempotência por messageId + diagnóstico.
  await query(`CREATE TABLE IF NOT EXISTS movatak_webhook_eventos (
    id BIGSERIAL PRIMARY KEY,
    origem TEXT NOT NULL DEFAULT 'zapi',
    instance_id TEXT,
    message_id TEXT,
    phone TEXT,
    direction TEXT,
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'recebido',
    erro TEXT,
    recebido_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processado_em TIMESTAMPTZ
  )`).catch(() => null);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_movatak_webhook_evento_msg
    ON movatak_webhook_eventos(instance_id, message_id) WHERE message_id IS NOT NULL`).catch(() => null);
  await query(`CREATE INDEX IF NOT EXISTS idx_movatak_webhook_recebido
    ON movatak_webhook_eventos(recebido_em DESC)`).catch(() => null);

  await query(`CREATE TABLE IF NOT EXISTS movatak_conversas (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER NOT NULL,
    cliente_id INTEGER NOT NULL,
    direcao TEXT NOT NULL CHECK (direcao IN ('entrada','saida')),
    conteudo TEXT,
    midia_url TEXT,
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`).catch(() => null);
  await query(`ALTER TABLE movatak_conversas ADD COLUMN IF NOT EXISTS midia_tipo TEXT`).catch(() => null);
  await query(`ALTER TABLE movatak_conversas ADD COLUMN IF NOT EXISTS msg_id TEXT`).catch(() => null);
  await query(`ALTER TABLE movatak_conversas ADD COLUMN IF NOT EXISTS reply_to_conversa_id INTEGER`).catch(() => null);
  await query(`ALTER TABLE movatak_conversas ADD COLUMN IF NOT EXISTS reply_to_msg_id TEXT`).catch(() => null);
  await query(`ALTER TABLE movatak_conversas ADD COLUMN IF NOT EXISTS reply_to_direcao TEXT`).catch(() => null);
  await query(`ALTER TABLE movatak_conversas ADD COLUMN IF NOT EXISTS reply_to_conteudo TEXT`).catch(() => null);
  await query(`ALTER TABLE movatak_conversas ADD COLUMN IF NOT EXISTS reply_to_midia_url TEXT`).catch(() => null);
  await query(`ALTER TABLE movatak_conversas ADD COLUMN IF NOT EXISTS reply_to_midia_tipo TEXT`).catch(() => null);
  await query(`ALTER TABLE movatak_conversas ADD COLUMN IF NOT EXISTS reply_payload JSONB DEFAULT '{}'::jsonb`).catch(() => null);
  await query(`ALTER TABLE movatak_conversas ADD COLUMN IF NOT EXISTS msg_status TEXT`).catch(() => null);
  await query(`ALTER TABLE movatak_conversas ADD COLUMN IF NOT EXISTS msg_status_em TIMESTAMPTZ`).catch(() => null);
  await query(`ALTER TABLE movatak_conversas ADD COLUMN IF NOT EXISTS zapi_status_payload JSONB DEFAULT '{}'::jsonb`).catch(() => null);
  await query(`ALTER TABLE movatak_conversas ADD COLUMN IF NOT EXISTS origem TEXT DEFAULT 'humano'`).catch(() => null);
  await query(`CREATE INDEX IF NOT EXISTS idx_conversas_lead ON movatak_conversas(lead_id, criado_em DESC)`).catch(() => null);
  await query(`CREATE INDEX IF NOT EXISTS idx_conversas_sla ON movatak_conversas(cliente_id, criado_em)`).catch(() => null);
  // Garante que a mesma mensagem do WhatsApp (mesmo lead + mesmo messageId) nunca
  // seja gravada duas vezes — fecha a corrida entre o envio pelo painel e o webhook fromMe.
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_conversas_lead_msgid ON movatak_conversas(lead_id, msg_id) WHERE msg_id IS NOT NULL`).catch(() => null);
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
  await query(`ALTER TABLE movatak_mensagens_rapidas ADD COLUMN IF NOT EXISTS itens JSONB DEFAULT '[]'::jsonb`).catch(() => null);
  await query(`ALTER TABLE movatak_mensagens_rapidas ADD COLUMN IF NOT EXISTS template_id INTEGER`).catch(() => null);
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
    ADD COLUMN IF NOT EXISTS setor_id INTEGER,
    ADD COLUMN IF NOT EXISTS ausencia_ativa BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS ia_ativa BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS nicho_template TEXT,
    ADD COLUMN IF NOT EXISTS agenda_tipo TEXT,
    ADD COLUMN IF NOT EXISTS agenda_status TEXT,
    ADD COLUMN IF NOT EXISTS criado_em TIMESTAMPTZ DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMPTZ DEFAULT NOW()`).catch(() => null);

  // Configuração de ausência do cliente:
  //   ausencia_msg_padrao  → mensagem disparada nos horários recorrentes de ausência
  //   ausencia_horarios    → JSONB: [{ dias:[0..6], inicio:"HH:MM", fim:"HH:MM" }]  (0=domingo)
  //   ausencia_datas       → JSONB: [{ data:"YYYY-MM-DD", inicio:"HH:MM", fim:"HH:MM", msg:"..." }]
  await query(`ALTER TABLE movatak_clientes ADD COLUMN IF NOT EXISTS ausencia_msg_padrao TEXT`).catch(() => null);
  await query(`ALTER TABLE movatak_clientes ADD COLUMN IF NOT EXISTS ausencia_horarios JSONB DEFAULT '[]'::jsonb`).catch(() => null);
  await query(`ALTER TABLE movatak_clientes ADD COLUMN IF NOT EXISTS ausencia_datas JSONB DEFAULT '[]'::jsonb`).catch(() => null);

  // Controle de "uma vez por período": registra qual período de ausência já foi
  // avisado a cada lead, pra não repetir dentro do mesmo período.
  await query(`CREATE TABLE IF NOT EXISTS movatak_ausencia_enviada (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER NOT NULL,
    cliente_id INTEGER NOT NULL,
    periodo_chave TEXT NOT NULL,
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`).catch(() => null);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_ausencia_lead_periodo ON movatak_ausencia_enviada(lead_id, periodo_chave)`).catch(() => null);

  await query(`ALTER TABLE movatak_clientes ADD COLUMN IF NOT EXISTS acao_arquivar_ao_final BOOLEAN DEFAULT false`).catch(() => null);
  await query(`ALTER TABLE movatak_clientes ADD COLUMN IF NOT EXISTS acao_marcar_nao_lido BOOLEAN DEFAULT false`).catch(() => null);
  await query(`ALTER TABLE movatak_clientes ADD COLUMN IF NOT EXISTS enviar_msg_final BOOLEAN DEFAULT true`).catch(() => null);
  await query(`ALTER TABLE movatak_clientes ADD COLUMN IF NOT EXISTS nicho TEXT`).catch(() => null);
  await query(`ALTER TABLE movatak_clientes ADD COLUMN IF NOT EXISTS agenda_ativa BOOLEAN DEFAULT false`).catch(() => null);
  await query(`ALTER TABLE movatak_leads
    ADD COLUMN IF NOT EXISTS funil_coluna_id INTEGER`).catch(() => null);

  await query(`ALTER TABLE movatak_leads
    ADD COLUMN IF NOT EXISTS convertido_em TIMESTAMPTZ`).catch(() => null);

  await query(`ALTER TABLE movatak_leads
    ADD COLUMN IF NOT EXISTS prioridade_dispensada_em TIMESTAMPTZ`).catch(() => null);

  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_movatak_funil_colunas_cliente_slug ON movatak_funil_colunas(cliente_id, slug)`).catch(() => null);
  await query(`CREATE INDEX IF NOT EXISTS idx_movatak_leads_funil_coluna ON movatak_leads(funil_coluna_id)`).catch(() => null);
  await query(`CREATE INDEX IF NOT EXISTS idx_movatak_leads_cliente_setor_atualizado ON movatak_leads(cliente_id, setor_id, atualizado_em DESC)`).catch(() => null);
  await query(`CREATE INDEX IF NOT EXISTS idx_movatak_conversas_lead_criado_desc ON movatak_conversas(lead_id, criado_em DESC)`).catch(() => null);
  await query(`CREATE INDEX IF NOT EXISTS idx_movatak_lead_eventos_lead_criado ON movatak_lead_eventos(lead_id, criado_em DESC)`).catch(() => null);
  await query(`CREATE INDEX IF NOT EXISTS idx_movatak_followup_lead_proximo ON movatak_followup(lead_id, proximo_envio DESC)`).catch(() => null);
}

async function garantirEstruturaAgenda() {
  await garantirEstruturaFunil();
  await query(`CREATE TABLE IF NOT EXISTS movatak_agendamentos (
    id SERIAL PRIMARY KEY,
    cliente_id INTEGER NOT NULL,
    lead_id INTEGER,
    vendedor_id INTEGER,
    titulo TEXT NOT NULL,
    tipo TEXT,
    status TEXT DEFAULT 'agendado',
    inicio TIMESTAMPTZ NOT NULL,
    fim TIMESTAMPTZ,
    observacao TEXT,
    funil_coluna_id INTEGER,
    criado_em TIMESTAMPTZ DEFAULT NOW(),
    atualizado_em TIMESTAMPTZ DEFAULT NOW()
  )`).catch(() => null);
  await query(`ALTER TABLE movatak_agendamentos
    ADD COLUMN IF NOT EXISTS vendedor_id INTEGER,
    ADD COLUMN IF NOT EXISTS tipo TEXT,
    ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'agendado',
    ADD COLUMN IF NOT EXISTS fim TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS observacao TEXT,
    ADD COLUMN IF NOT EXISTS funil_coluna_id INTEGER,
    ADD COLUMN IF NOT EXISTS cancelado_em TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS lembrete_min INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMPTZ DEFAULT NOW()`).catch(() => null);
  await query(`CREATE INDEX IF NOT EXISTS idx_movatak_agendamentos_cliente_inicio ON movatak_agendamentos(cliente_id, inicio)`).catch(() => null);
  await query(`CREATE INDEX IF NOT EXISTS idx_movatak_agendamentos_lead ON movatak_agendamentos(lead_id)`).catch(() => null);
}

async function garantirEstruturaCaptacao() {
  await query(`CREATE TABLE IF NOT EXISTS movatak_leads_captacao (
    id SERIAL PRIMARY KEY,
    nome TEXT,
    telefone TEXT,
    endereco TEXT,
    categoria TEXT,
    cidade TEXT,
    nicho_busca TEXT,
    place_id TEXT,
    tem_whatsapp BOOLEAN,
    promovido BOOLEAN NOT NULL DEFAULT false,
    promovido_em TIMESTAMPTZ,
    lead_id INTEGER,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`).catch(() => null);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_captacao_place_id ON movatak_leads_captacao(place_id) WHERE place_id IS NOT NULL`).catch(() => null);
  await query(`CREATE INDEX IF NOT EXISTS idx_captacao_cidade_nicho ON movatak_leads_captacao(cidade, nicho_busca)`).catch(() => null);
  await query(`CREATE TABLE IF NOT EXISTS movatak_captacao_uso (
    mes TEXT PRIMARY KEY,
    buscas INTEGER NOT NULL DEFAULT 0,
    text_search INTEGER NOT NULL DEFAULT 0,
    place_details INTEGER NOT NULL DEFAULT 0,
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`).catch(() => null);
}

// Assinatura/mensalidade da MovAtak (SaaS). Colunas defaultam para NAO-bloqueante:
// clientes existentes ficam status='ativa' e vence_em=NULL, e NUNCA sao bloqueados
// (vence_em NULL = cliente nao gerido por assinatura). Ver ASSINATURAS.md.
async function garantirEstruturaAssinaturas() {
  await query(`ALTER TABLE movatak_clientes
    ADD COLUMN IF NOT EXISTS assinatura_status TEXT DEFAULT 'ativa',
    ADD COLUMN IF NOT EXISTS assinatura_vence_em DATE,
    ADD COLUMN IF NOT EXISTS assinatura_valor NUMERIC(10,2),
    ADD COLUMN IF NOT EXISTS assinatura_forma TEXT,
    ADD COLUMN IF NOT EXISTS assinatura_ciclo_dias INTEGER DEFAULT 30,
    ADD COLUMN IF NOT EXISTS mp_customer_id TEXT,
    ADD COLUMN IF NOT EXISTS mp_preapproval_id TEXT,
    ADD COLUMN IF NOT EXISTS ultimo_aviso_marco INTEGER,
    ADD COLUMN IF NOT EXISTS bloqueado_em TIMESTAMPTZ`).catch(() => null);

  await query(`CREATE TABLE IF NOT EXISTS movatak_pagamentos (
    id SERIAL PRIMARY KEY,
    cliente_id INTEGER NOT NULL,
    valor NUMERIC(10,2),
    status TEXT DEFAULT 'pendente',
    metodo TEXT,
    mp_payment_id TEXT,
    referencia TEXT,
    pago_em TIMESTAMPTZ,
    vence_em DATE,
    criado_em TIMESTAMPTZ DEFAULT NOW(),
    atualizado_em TIMESTAMPTZ DEFAULT NOW()
  )`).catch(() => null);

  await query(`CREATE INDEX IF NOT EXISTS idx_pagamentos_cliente ON movatak_pagamentos (cliente_id)`).catch(() => null);
}

// [perf] Executa uma migracao idempotente no maximo UMA vez por processo. As
// garantirEstrutura*/garantirColunas* rodam CREATE/ALTER ... IF NOT EXISTS, que
// so precisam acontecer uma vez; sem isso rodavam a cada chamada — inclusive no
// hot path (garantirEstruturaConversas em toda registrarConversa/webhook), o que
// eram ~6+ round-trips DDL por mensagem. Se a 1a execucao falhar, limpa o cache
// para retentar na proxima chamada (preserva a resiliencia do comportamento antigo).
function umaVez(fn) {
  let pendente = null;
  return function () {
    if (!pendente) pendente = Promise.resolve().then(fn).catch((e) => { pendente = null; throw e; });
    return pendente;
  };
}

module.exports = {
  pool,
  query,
  hashStringToInt,
  withPgAdvisoryLock,
  garantirColunasClientesPortal: umaVez(garantirColunasClientesPortal),
  garantirColunasVendedoresPortal: umaVez(garantirColunasVendedoresPortal),
  garantirEstruturaCampanhasTemplates: umaVez(garantirEstruturaCampanhasTemplates),
  garantirEstruturaQuestionario: umaVez(garantirEstruturaQuestionario),
  garantirEstruturaPlanos: umaVez(garantirEstruturaPlanos),
  garantirEstruturaConversas: umaVez(garantirEstruturaConversas),
  garantirEstruturaMensagensRapidas: umaVez(garantirEstruturaMensagensRapidas),
  garantirEstruturaFunil: umaVez(garantirEstruturaFunil),
  garantirEstruturaAgenda: umaVez(garantirEstruturaAgenda),
  garantirEstruturaCaptacao: umaVez(garantirEstruturaCaptacao),
  garantirEstruturaAssinaturas: umaVez(garantirEstruturaAssinaturas),
};
