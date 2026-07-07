# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Sistema em produção — mudanças conservadoras

Este é o backend de um CRM de WhatsApp (Movatak) rodando em produção real,
atendendo clientes ao vivo (integração Z-API, envio/recebimento de
mensagens, follow-ups automáticos, IA). **Não é um projeto experimental.**
Trate qualquer alteração com cautela:

- Prefira o menor diff possível que resolve o problema pedido.
- Não "aproveite" para refatorar, renomear ou "melhorar" código vizinho
  que não foi pedido.
- Rode `node --check` nos arquivos alterados antes de considerar terminado.
- Se uma mudança parece arriscada (migração de schema, mudar contrato de
  webhook, alterar régua de follow-up/IA que já está em uso), pare e
  pergunte antes de aplicar.

## Comandos

```bash
npm install       # instala dependências (não versionadas em node_modules)
npm start         # node index.js — sobe o backend (porta MOVATAK_PORT || PORT || 3001)
npm run dev       # node --watch index.js
npm run smoke     # scripts/smoke.js — confirma que index.js e src/**/*.js
                  # dão require()/boot sem erro, com env vars falsas,
                  # sem tocar em banco de dados real. Rodar antes de
                  # cada commit da refatoração.
node --check index.js         # valida sintaxe sem executar
node --check src/algum.js      # idem, para módulos extraídos
```

Não há suíte de testes automatizados além do smoke test acima.

## Refatoração em andamento

O backend está sendo quebrado de um único `index.js` monolítico (~10.500
linhas) em módulos dentro de `src/`. **O plano completo, fase a fase, está
em [REFATORACAO.md](REFATORACAO.md) — leia esse arquivo antes de mover
qualquer código.** Regras de ouro (resumo, ver REFATORACAO.md para
detalhes):

1. Mover código **verbatim** — nunca reescrever lógica na mesma tacada em
   que ela muda de arquivo. Se algo parecer bug, anotar para depois.
2. `node --check` em tudo antes de cada commit.
3. Nunca deixar uma fase de migração pela metade — cada commit deixa o
   sistema pronto para deploy.
4. Direção das dependências entre módulos: `db → zapi/realtime → domínios
   (leads, questionario, ia, followups) → webhook → rotas`.

## Arquitetura do backend (index.js)

Express + Socket.io + PostgreSQL (`pg`) + node-cron, servindo tanto a API
(prefixo único `/movatak/...`, ~212 rotas) quanto o `index.html` estático.
Multi-tenant: quase toda tabela tem `cliente_id`, e cada cliente tem sua
própria instância/token Z-API.

- **Camada de dados**: `pool`/`query()` (pg) + funções `garantirEstrutura*()`
  espalhadas pelo arquivo — cada uma é uma migração idempotente
  (`CREATE TABLE IF NOT EXISTS`/`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`)
  chamada no boot (`httpServer.listen(...)`) ou lazy na primeira rota que
  precisa da tabela. Não existe migration runner separado — a "migração"
  É o `garantirEstrutura*` no código.
- **Autenticação**: três públicos distintos, cada um com seu middleware,
  sem separação de router hoje (tudo em `index.js`):
  - `authMovatak` / segredo admin — painel interno.
  - `authCliente` (app_token) — portal do cliente, somente leitura /
    autoatendimento.
  - `authVendedor` (vendedor_token) — app do vendedor, escopado por setor
    (`vendedorPodeSetor`, `vendedorPodeLead`).
  - Rotas de webhook da Z-API não têm autenticação de usuário (validam por
    outros meios, ex. segredo compartilhado quando aplicável).
- **Z-API**: todas as funções `zapi*` encapsulam chamadas HTTP para
  `https://api.z-api.io/instances/...` (enviar texto, imagem, áudio,
  documento, reagir, apagar, etc). Credenciais (`instance`, `token`,
  `clientToken`) vêm por cliente via `getZapiCreds(clienteId)`.
- **Webhooks da Z-API** (`/movatak/webhook/mensagem`, `/etiqueta`,
  `/resposta`, `/zapi`, `/zapi-status`, `/status`): ponto de entrada de
  tudo que chega do WhatsApp. Registra em `movatak_conversas`
  (`registrarConversa`), dispara eventos (`registrarEventoLead`), pode
  pausar automações (`pararAtendimentoLead`) quando um humano assume.
- **Follow-up**: régua em dois blocos, FU1 (imediato) e FU2 (D+0, D+1,
  D+3), orquestrada por `agendarFollowupV2` /
  `enviarFollowupsPendentesDoLead` e finalizada por
  `finalizarFollowupsEsgotados`. Cron dedicado roda a régua a cada hora;
  desative com `MOVATAK_CRON_ATIVO=false` (necessário ao rodar dois
  serviços contra o mesmo banco, para não duplicar disparo — usa também
  advisory lock do Postgres, `withPgAdvisoryLock`).
  Reentrada/limites configuráveis via env (`MOVATAK_REENTRADA_FU1_HORAS`,
  `MOVATAK_MAX_AUTO_MSG_DIA`, etc).
  Reference: [REFATORACAO.md](REFATORACAO.md)
- **IA**: `gerarRespostaIALead` e `iaResponderAutomatico` respondem leads
  automaticamente, com travas anti-spam e limite diário de mensagens
  automáticas por lead. Também há um fallback por IA para casar um lead
  com a campanha/gatilho certo quando não há match literal (não cria
  fluxo novo, só escolhe entre campanhas existentes).
- **Tempo real**: Socket.io emite eventos (`emitirMensagemLead`,
  `emitirMensagemApagada`, `emitirStatusMensagem`, `emitirLeadFlags`) para
  os painéis abertos (admin/vendedor) reagirem sem polling.
- **Anexos**: Cloudflare R2 via `@aws-sdk/client-s3`, com auto-descoberta
  de bucket no boot. Se as env vars `R2_*` faltarem, o sistema continua
  funcionando normalmente e só os anexos ficam indisponíveis — não trate
  R2 ausente como erro fatal.

## Frontend (index.html)

SPA de página única (~9.900 linhas: HTML + CSS + JS inline, sem build
step). Dois pontos de duplicação importantes ao mexer na UI:

- **Dois blocos de layout do funil/kanban duplicados** (por volta das
  linhas 842 e 7456, ambos `<div class="funil-page funil-page-3col">`) —
  um para o painel principal, outro para dentro do modal de atendimento.
  Qualquer edição de estrutura/UI do funil precisa ser replicada nos
  **dois** blocos, ou os dois vão divergir silenciosamente.
- **Dois escopos de CSS para o funil**: `#modal-funil-atendimento` (funil
  dentro do modal) e `.funil-page` (funil da tela cheia). Muita regra
  existente já usa seletor combinado (`.funil-page .x, #modal-funil-atendimento .x`)
  de propósito — **toda regra nova de CSS para o funil deve cobrir os
  dois seletores**, senão o modal e a tela cheia ficam com aparência
  diferente.

## Variáveis de ambiente relevantes

`DATABASE_URL`, `MOVATAK_SECRET`, `MOVATAK_PORT`/`PORT`,
`MOVATAK_CRON_ATIVO`, `MOVATAK_DEBUG`, `MOVATAK_RELATORIO_DIARIO`,
`MOVATAK_REENTRADA_FU1_HORAS`, `MOVATAK_MAX_AUTO_MSG_DIA`,
`MOVATAK_QUEST_LEMBRETE_HORAS`, `MOVATAK_QUEST_MAX_LEMBRETES`,
`ZAPI_CAPTACAO_INSTANCE`/`_TOKEN`/`_CLIENT_TOKEN`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `R2_BUCKET`, `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `GOOGLE_PLACES_API_KEY`, `SUPABASE_URL`,
`SUPABASE_SERVICE_KEY`, `SUPABASE_BUCKET`, `RASTREIOBOT_URL`,
`CAPTACAO_COTA_TEXT_SEARCH`, `CAPTACAO_COTA_PLACE_DETAILS`.
