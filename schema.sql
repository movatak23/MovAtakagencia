-- ============================================================
-- Movatak — Schema PostgreSQL
-- Roda no mesmo banco do LoggZap (Railway)
-- ============================================================

-- Clientes Movatak (empresas atendidas)
CREATE TABLE IF NOT EXISTS movatak_clientes (
  id            SERIAL PRIMARY KEY,
  nome          TEXT NOT NULL,
  whatsapp      TEXT NOT NULL,           -- número do WA Business do cliente (ex: 5581999990000)
  zapi_instance TEXT NOT NULL,           -- ID da instância Z-API do cliente
  zapi_token    TEXT NOT NULL,           -- token da instância Z-API
  zapi_client_token TEXT NOT NULL,       -- client-token Z-API
  trigger_msg   TEXT NOT NULL,           -- frase gatilho do anúncio (ex: "Vim pelo anúncio")
  teto_cpl      NUMERIC(10,2),           -- custo por lead máximo acordado
  app_token     TEXT NOT NULL UNIQUE,    -- token de acesso do app mobile do cliente
  ativo         BOOLEAN DEFAULT true,
  criado_em     TIMESTAMPTZ DEFAULT NOW()
);

-- Planos/produtos do cliente (cadastrado no onboarding)
CREATE TABLE IF NOT EXISTS movatak_planos (
  id          SERIAL PRIMARY KEY,
  cliente_id  INT NOT NULL REFERENCES movatak_clientes(id) ON DELETE CASCADE,
  nome        TEXT NOT NULL,            -- ex: "Plano Basic", "Plano Pro"
  valor       NUMERIC(10,2),
  ativo       BOOLEAN DEFAULT true
);

-- Leads recebidos
CREATE TABLE IF NOT EXISTS movatak_leads (
  id            SERIAL PRIMARY KEY,
  cliente_id    INT NOT NULL REFERENCES movatak_clientes(id) ON DELETE CASCADE,
  telefone      TEXT NOT NULL,           -- número do lead (ex: 5581999990000)
  nome          TEXT,
  etapa         TEXT NOT NULL DEFAULT 'lead',
                                         -- lead | followup | cliente | descartado
  plano_id      INT REFERENCES movatak_planos(id),
  criado_em     TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW()
);

-- Fila de follow up
CREATE TABLE IF NOT EXISTS movatak_followup (
  id            SERIAL PRIMARY KEY,
  lead_id       INT NOT NULL REFERENCES movatak_leads(id) ON DELETE CASCADE,
  cliente_id    INT NOT NULL REFERENCES movatak_clientes(id) ON DELETE CASCADE,
  etapa_seq     INT NOT NULL DEFAULT 1,  -- 1=D+1, 2=D+3, 3=D+7, 4=D+14
  proximo_envio TIMESTAMPTZ NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pendente',
                                         -- pendente | enviado | pausado | concluido
  criado_em     TIMESTAMPTZ DEFAULT NOW()
);

-- Log de mensagens enviadas
CREATE TABLE IF NOT EXISTS movatak_mensagens (
  id          SERIAL PRIMARY KEY,
  lead_id     INT NOT NULL REFERENCES movatak_leads(id) ON DELETE CASCADE,
  cliente_id  INT NOT NULL REFERENCES movatak_clientes(id) ON DELETE CASCADE,
  tipo        TEXT NOT NULL,             -- boas_vindas | followup_1 | followup_2 | followup_3 | followup_4
  status      TEXT NOT NULL DEFAULT 'enviado',
  enviado_em  TIMESTAMPTZ DEFAULT NOW()
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_leads_cliente    ON movatak_leads(cliente_id);
CREATE INDEX IF NOT EXISTS idx_leads_telefone   ON movatak_leads(telefone);
CREATE INDEX IF NOT EXISTS idx_leads_etapa      ON movatak_leads(etapa);
CREATE INDEX IF NOT EXISTS idx_followup_status  ON movatak_followup(status, proximo_envio);
CREATE INDEX IF NOT EXISTS idx_clientes_trigger ON movatak_clientes(trigger_msg);
