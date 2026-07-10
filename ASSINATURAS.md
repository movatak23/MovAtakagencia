# Assinaturas / Mensalidade — MovAtak SaaS

Cobrança recorrente da MovAtak sobre os clientes-empresa (`movatak_clientes`):
bloqueio/liberação automáticos do acesso ao CRM + avisos de vencimento.

## Decisões (fechadas)
- **Quem paga:** MovAtak cobra os `movatak_clientes` (SaaS). "Acesso dele" = acesso ao CRM.
- **Gateway:** **Mercado Pago** (cartão via Preapproval = débito automático; Pix/boleto
  = cobrança+link gerados por ciclo, cliente paga, webhook confirma).
- **Bloqueio:** **suspensão completa** — reusa `movatak_clientes.ativo`. `ativo=false`
  já corta painel + webhook + followups + IA (o `WHERE ativo=true` roda em ~44 pontos).
- **Avisos ("faltam X dias"):** 3 canais — WhatsApp (nº MovAtak dedicado) + banner no
  painel (ao vivo) + e-mail (Resend recomendado).

## Enforcement (reusa `ativo`, sem tocar em 44 queries)
- `authCliente` já faz `WHERE app_token=$1 AND ativo=true` → cliente com `ativo=false`
  já é barrado (401 hoje). Bloqueio por pagamento = setar `ativo=false` +
  `assinatura_status='bloqueada'`. `assinatura_status` desambigua "bloqueado por
  pagamento" de "desativado manualmente" → na liberação, só reativa se foi por pagamento.
- **Polimento futuro:** `authCliente` devolver 402 "assinatura vencida" (paywall) em vez
  de 401 genérico — exige consultar o cliente sem o filtro `ativo`; deixado p/ depois.
- **REGRA DE OURO:** `assinatura_vence_em = NULL` → cliente NÃO gerido por assinatura →
  **nunca bloqueia**. Clientes atuais ficam `status='ativa'`, `vence_em=NULL` → intactos.

## Modelo de dados
`movatak_clientes` (novas colunas, todas não-bloqueantes por default):
- `assinatura_status TEXT DEFAULT 'ativa'` — trial|ativa|vencendo|vencida|bloqueada|cancelada
- `assinatura_vence_em DATE` — fonte da verdade dos dias-para-vencer (NULL = não gerido)
- `assinatura_valor NUMERIC(10,2)`, `assinatura_forma TEXT` (pix|cartao|boleto),
  `assinatura_ciclo_dias INTEGER DEFAULT 30`
- `mp_customer_id TEXT`, `mp_preapproval_id TEXT` (assinatura recorrente MP p/ cartão)
- `ultimo_aviso_marco INTEGER` (idempotência dos avisos), `bloqueado_em TIMESTAMPTZ`

`movatak_pagamentos` (histórico): id, cliente_id, valor, status (pendente|confirmado|
falho|estornado), metodo (pix|cartao|boleto|manual), mp_payment_id, referencia,
pago_em, vence_em (data que a cobrança cobre), criado_em, atualizado_em.

## Ciclo de vida (dirigido por `assinatura_vence_em`)
`ativa → (≤7d) vencendo → (venceu) vencida [carência N dias] → bloqueada
 → (pagou) ativa` (renova `vence_em += ciclo`).

## Fases
- [ ] **Fase A — schema (base, sem gateway).** `garantirEstruturaAssinaturas()` em
  `src/db.js` (ALTER movatak_clientes + CREATE movatak_pagamentos, idempotente,
  defaults não-bloqueantes) + chamada no boot. Zero mudança de comportamento.
- [ ] **Fase B — Mercado Pago.** SDK `mercadopago` + envs (`MP_ACCESS_TOKEN`,
  `MP_WEBHOOK_SECRET`). Onboarding (customer + preapproval cartão OU cobrança Pix/boleto
  por ciclo). Handler `handlePagamento` em `src/webhook.js` (`POST /movatak/webhook/pagamento`):
  **validar `x-signature` do MP**, buscar recurso por `data.id`, atualizar
  `movatak_pagamentos` + `vence_em` + `status` + `ativo`. Painel admin: status,
  histórico, link, override manual (marcar pago / estender / cancelar).
- [ ] **Fase C — avisos + cron.** `src/assinatura.js`: cron 09:00 (padrão existente) →
  calcula dias, envia WhatsApp (instância MovAtak) + e-mail (Resend) nos marcos
  7/3/1/0 + carência (idempotente via `ultimo_aviso_marco`); passada a carência →
  `ativo=false` + `status=bloqueada`. Banner: endpoint que o painel lê (dias+status).
  Cron é **rede de segurança** caso um webhook do MP falhe.
- [ ] **Fase D — paywall UX + reconciliação.** `authCliente` 402 "assinatura vencida";
  garantir cobertura dos 44 pontos de `ativo`; painel de billing completo.

## Setup/ops (fora do código, você provê)
1. Conta Mercado Pago + `access_token` + registrar `notification_url` do webhook.
2. **Instância Z-API dedicada da MovAtak** (avisos ao dono, separada da instância que
   cada cliente usa com os leads dele).
3. Provedor de e-mail (Resend recomendado: API simples; alt. Amazon SES — já há AWS SDK).

## Notas de segurança
- Webhook de pagamento é público → **validação de assinatura `x-signature` obrigatória**.
- Tokens MP só em env (Railway), nunca no código.
- Migração é metadata-only no Postgres (ADD COLUMN c/ default constante não reescreve tabela).
