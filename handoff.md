# Handoff — MovAtak CRM

Passagem de bastão. Estado em **2026-07-10** (substitui o de 2026-07-08).

## Estado atual

- Produção (`app.movatak.com.br`, serviço Railway `outstanding-radiance`): **5a + 5b já
  deployadas** (`v2.8.3-fase5b-vendedor` confirmada no ar). `main` = commit `abd9547`.
- **Fase 5c (rotas portal) pronta no working tree, AGUARDANDO commit/push (=deploy).**
  Nova versão em `src/config.js`: **`v2.8.4-fase5c-portal`**. Passou em todas as provas
  (reconstrução byte-a-byte, node --check, smoke, funcional 401/400/404, diff de rotas
  212==212 vs pré-5a).
- Working tree não commitado (5c): `index.js` (encolhido), `src/routes/portal.js` (novo),
  `src/config.js` (bump), `REFATORACAO.md`, `handoff.md`. (`ASSINATURAS.md` segue com
  mudança pré-existente não commitada, não é da refatoração.)
- **REFATORAÇÃO DO index.js CONCLUÍDA (Fases 1–5).** `index.js` de ~10.500 →
  **~2.036 linhas** — só o esqueleto (imports, Express, middlewares de auth, ~40 helpers,
  crons, boot, fiação fina de rotas + os `register()` dos 4 módulos de rotas).
- Módulos em `src/`: `config`, `db`, `zapi`, `realtime`, `leads`, `questionario`,
  `followups`, `ia`, `util`, `ausencia`, `antispam`, `funil`, `menu`, `webhook`,
  `routes/admin`, `routes/vendedor`, `routes/portal` (17).
- **Paralelo (outra sessão):** correção do bug pré-existente do `csvEscape`
  (rota `admin/clientes/:id/leads.csv`) está rodando/deve entrar por lá.
- Layering consolidado, **sem ciclos**:
  `db → zapi/realtime → leads/util → ausencia/antispam/funil/followups/questionario → ia/menu`.
- Helpers que ainda vivem no index.js: **66** (era 89 antes dos laterais).

### Refatoração — progresso
- [x] Fase 1 — config + db
- [x] Fase 2 — zapi + realtime
- [x] Fase 3a — leads
- [x] Fase 3b — questionario (16 funções)
- [x] Fase 3d — followups (5 funções + `DIAS_FOLLOWUP_V2`)
- [x] Fase 3c — ia (9 funções, motor Claude Haiku)
- [x] **Laterais** — util, ausência, antispam, funil, menu (23 funções; 8492→8039)
- [x] **Fase 4a** — 5 webhooks menores → `src/webhook.js` (8039→7818)
- [x] **Fase 4b** — `/webhook/zapi` (handleZapi, 684 linhas) + 22 helpers exclusivos
  → `src/webhook.js` (7822→6849; injeta 6 compartilhados; validado ao vivo:
  processou msg real pós-deploy, 0 erro)
- [x] **Fase 5a** — 142 rotas `/movatak/admin/*` → `src/routes/admin.js` via
  `register(app, deps)` (index.js 6849→3335; 111 deps injetadas). **Deployada
  (`v2.8.2`).** Achou bug pré-existente da 4b: `leads.csv` usa `csvEscape` (foi p/
  webhook.js sem export) — corrigir separado.
- [x] **Fase 5b** — 47 rotas `/movatak/vendedor/*` → `src/routes/vendedor.js`
  (index.js 3335→2451; 52 deps injetadas, incl. `authVendedor` + `vendedorPode*`).
  **Deployada (`v2.8.3`).**
- [x] **Fase 5c** — 15 rotas `/movatak/app/*` (portal) → `src/routes/portal.js`
  (index.js 2451→2036; 6 deps, `authCliente`+helpers). Webhook thin-regs + health +
  version ficaram como glue no index.js. **AGUARDANDO commit/push.** → **Fase 5 completa.**

## Método validado (usar de novo — não reinventar)

1. **Script node de extração verbatim**: acha cada função pela assinatura exata
   (linha col-0), fim = primeira linha `}` na col-0 (const: `};`). Remove regiões
   de baixo p/ cima deixando `// [refatoracao Nx] fn() -> src/x.js`. Monta o módulo
   com header + imports + corpos + `module.exports`.
2. **Provas obrigatórias antes do commit**: (a) reconstrução **byte-a-byte** —
   reinsere os corpos nos ponteiros e remove os blocos adicionados; tem que bater
   igual ao `git show HEAD:index.js`/original; (b) `node --check` em tudo;
   (c) `npm run smoke` (carrega todos os módulos); (d) **symbol-check** — regex de
   chamadas `fn(` no módulo contra o set de providos; pega deps esquecidas
   (foi assim que apareceram `enviarMenuAtendimento`, `registrarErroZapi`,
   `enviarMsgQuestionario`, `garantirEstruturaConversas`). Ignorar falso-positivos
   de SQL/comentário/fragmentos de regex `\b`.
3. **Injeção `init(deps)`**: quando o módulo depende de algo que **ainda vive no
   index.js**, declara `let`s de escopo + `init(deps)`, e o index.js chama
   `modulo.init({...})` no boot (function declarations são hoisted). O corpo movido
   referencia por variável de escopo → fica byte-idêntico. A fiação sai quando a
   dep é extraída.
4. Bump `MOVATAK_VERSION` em `src/config.js`, marcar `REFATORACAO.md`, `commit` +
   `push` **só com autorização** (push no main = **deploy** automático), depois
   `curl -s https://app.movatak.com.br/movatak/version` até virar.
5. **IA/Claude**: consultar a skill `claude-api` **antes** de tocar em código que
   chama a Anthropic (regra do CLAUDE.md). Modelo atual: `claude-haiku-4-5-20251001`.

## Plano — o que falta (ordem recomendada)

### Passo 1 — Laterais (folhas). Extrair primeiro; zera a dívida de injeção.
Ao extrair cada um, **remover as linhas correspondentes dos `init()`** de
followups/questionario/ia — elas passam a importar direto do módulo novo.
- `src/util.js` — telefone/mídia/misc (puros ou quase): `variantesTelefone`,
  `extrairDigitosTelefone`, `telefonesEquivalentes`, `ehGrupoOuCanal`, `tipoMidia`,
  `normalizarCep`, `sleep`, `uploadSupabase`, `registrarErroZapi`, `enviarAlerta`.
- `src/ausencia.js` — `avaliarAusencia`, `clienteRowEmAusencia`,
  `dispararAusenciaSeAplicavel`.
- `src/antispam.js` — `contarMensagensAutomaticasHoje`,
  `podeEnviarMensagemAutomatica`, `reentradaFU1Permitida`, `leadRespondeuRecentemente`.
- `src/funil.js` — `moverLeadParaFunilSlug`, `moverLeadParaColunaFunil`,
  `atribuirVendedorBalanceado`.
- `src/menu.js` — `enviarBoasVindasLead`, `enviarMenuAtendimento`,
  `processarRespostaMenu`.

### Passo 2 — Fase 4: webhook (`src/webhook.js`)
- ~920 linhas: `app.post('/movatak/webhook/mensagem')` + `/webhook/resposta`.
- Padrão novo (não é "mover função"): extrair o **corpo do handler** para
  `handleMensagem(req,res)` / `handleResposta(req,res)`; deixar no index.js só o
  registro fino `app.post('.../mensagem', (req,res)=>webhook.handleMensagem(req,res))`.
- Webhook está no **topo** do call graph (nada o chama além do Express), então
  importa todos os módulos já extraídos. **Caminho mais crítico e de maior tráfego
  do sistema** — verificar com rigor extra.

### Passo 3 — Fase 5: rotas (`src/routes/*.js`) — a maior, ~4.882 linhas
- Padrão: agrupar rotas por domínio, cada `src/routes/<dominio>.js` exporta
  `register(app)` (ou `register(app, deps)`); index.js chama
  `require('./src/routes/admin').register(app)`.
- **Sub-fases** para respeitar "uma fase = um commit = um deploy":
  5a admin · 5b vendedor · 5c portal · 5d publico.
- Depende dos laterais já extraídos, senão a superfície de injeção fica enorme.

### Trilha paralela (opcional) — performance (diagnóstico primeiro, NÃO misturar com refatoração)
A refatoração **não** deixa o sistema mais rápido (código movido verbatim). Se o
objetivo for velocidade, é outra trilha, com medição antes/depois:
- `garantirEstrutura*` roda em hot path (ex.: `garantirEstruturaConversas()` em
  toda `registrarConversa`) → mover pro boot ou memoizar.
- **Prompt caching** em `chamarHaiku` (system prompt estável e repetido → `cache_control`).
- Revisar índices/filtros da query do cron pump `*/10`.

## Estimativa final do index.js
- Só Fases 4 + 5: **~2.000–2.500 linhas** (helpers e crons ficam).
- 4 + 5 + laterais (+ crons num scheduler): **~800–1.200 linhas** (esqueleto:
  imports, setup Express, boot, fiação de módulos, glue).

## Infra / deploy / banco (não é óbvio)
- Produção = Railway **`outstanding-radiance`** (`app.movatak.com.br`), auto-deploy
  do GitHub `movatak23/MovAtakagencia` main. Existe um `MovAtakagencia`
  (`movatakagencia-production...`) que é o **backend ANTIGO desativado** — NÃO é prod.
- Verificar deploy: `curl -s https://app.movatak.com.br/movatak/version`.
- SQL: sem `psql`/`DATABASE_URL` local. Railway CLI —
  `railway link -p "MovAtak - Marketing Sem Agência" -e production`, depois
  `railway run --service Postgres ... node <script>` com `pg` +
  `process.env.DATABASE_PUBLIC_URL` e `ssl:{rejectUnauthorized:false}`.
  **Sempre `railway status` + preview read-only antes de UPDATE.**

## Como retomar
Ler este handoff + `REFATORACAO.md` (seção "Roadmap", fonte da verdade) +
memórias `movatak-refatoracao` e `movatak-infra-deploy` (em
`~/.claude/projects/-Users-ronaldo-Downloads-Nfim/memory/`).

**PRÓXIMO = commit/push da Fase 5c** (aguardando autorização; push no main = deploy).
Depois: `curl -s https://app.movatak.com.br/movatak/version` até virar
`v2.8.4-fase5c-portal` e checar uma rota do portal real (login do cliente + dashboard).
**Com isso a refatoração do index.js (Fases 1–5) está COMPLETA.**

**Perf 1 (feito, `v2.8.5-perf-migracoes-memoizadas`):** memoizei as 11
`garantirEstrutura*`/`garantirColunas*` em `src/db.js` (via `umaVez()`) — tirou 23
queries DDL por mensagem do hot path (`registrarConversa`). Índice do cron pump é
não-problema (EXPLAIN 0,969 ms, já indexado). Prompt caching no `chamarHaiku`
diagnosticado mas **adiado** (o prompt tem bytes voláteis + trecho estável < 4096 tokens
do Haiku → precisa reestruturar a montagem, ganho incerto, medir). Faxina do index.js:
sem fatia limpa (helpers nicho/funil/zapi interdependentes). Detalhes em REFATORACAO.md.

**O que sobra depois da 5c (não é mais refatoração de rotas):**
- Corrigir o bug pré-existente do `csvEscape` (rota `admin/clientes/:id/leads.csv` — ver
  REFATORACAO.md 5a). **Já delegado a outra sessão** (task_3654b72e) — conferir se entrou.
- Opcional/faxina: mover as fiações finas (webhook thin-regs, health, version) e/ou os
  ~40 helpers restantes e os crons pra módulos, se quiser encolher ainda mais o index.js.
- Trilha de performance (separada, com medição antes/depois): tirar `garantirEstrutura*`
  do hot path, prompt caching em `chamarHaiku`, revisar índices do cron pump `*/10`.

Método de extração (validado na 5a, 5b e 5c): script node (1) enumera os nomes top-level
"providáveis" do index.js; (2) acha os blocos de rota por assinatura (`app.M('/prefixo/`
col-0 → primeiro `});` col-0); (3) deps = providáveis ∩ referenciados nos blocos —
**cuidado: tratar `...spread` como referência real, não acesso a propriedade** (foi o
bug que deixou os `exige*`/`forcaClienteIdNaUrl` de fora na 1ª tentativa). Provas
obrigatórias: reconstrução byte-a-byte contra `git show HEAD:index.js` (blocos idênticos
+ index.js == original menos ranges + adições) + `node --check` + `npm run smoke` (boot
executa o `register` → pega dep faltando no call site) + diff estático do conjunto de
rotas registradas (HEAD == depois) + checagem funcional 401/404. Scripts no scratchpad
da sessão.
