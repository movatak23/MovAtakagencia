# Handoff — MovAtak CRM

Passagem de bastão. Estado em **2026-07-10** (substitui o de 2026-07-08).

## Estado atual

- Produção (`app.movatak.com.br`, serviço Railway `outstanding-radiance`) rodando
  **`v2.8.1-fase4b-webhook`**. `main` sincronizado com `origin/main`.
- **Fase 5a (rotas admin) pronta no working tree, AGUARDANDO commit/push (=deploy).**
  Nova versão em `src/config.js`: **`v2.8.2-fase5a-admin`**. Passou em todas as provas
  (reconstrução byte-a-byte, node --check, smoke, checagem funcional, diff de rotas).
- Working tree não commitado: `index.js` (encolhido), `src/routes/admin.js` (novo),
  `src/config.js` (bump de versão), `REFATORACAO.md`, `handoff.md`, `ASSINATURAS.md`.
- **Fase 3 + laterais + Fase 4 (webhook) + Fase 5a (admin) concluídos.** `index.js` de
  ~10.500 → **3.335 linhas** (era 6.849 antes da 5a).
- Módulos em `src/`: `config`, `db`, `zapi`, `realtime`, `leads`, `questionario`,
  `followups`, `ia`, `util`, `ausencia`, `antispam`, `funil`, `menu`, `webhook`,
  `routes/admin` (15).
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
  `register(app, deps)` (index.js 6849→3335; 111 deps injetadas). **AGUARDANDO
  commit/push.** Achou bug pré-existente da 4b: `leads.csv` usa `csvEscape` (foi p/
  webhook.js sem export) — corrigir separado.
- [ ] Fase 5b — rotas vendedor (47 rotas, `authVendedor`) ← **próximo**
- [ ] Fase 5c — rotas portal/público (`/movatak/app/*` + sem auth)

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

**PRÓXIMO = commit/push da Fase 5a** (aguardando autorização; push no main = deploy).
Depois: `curl -s https://app.movatak.com.br/movatak/version` até virar
`v2.8.2-fase5a-admin`. Verificar ao vivo uma rota admin real (ex.: abrir o painel e
carregar leads/funil de um cliente). **Depois disso, corrigir o bug pré-existente do
`csvEscape`** (rota `admin/clientes/:id/leads.csv` — ver REFATORACAO.md 5a) num commit
separado.

**Depois: Fase 5b (rotas vendedor)** — 47 rotas `/movatak/vendedor/*` (middleware
`authVendedor` + `vendedorPodeSetor/Lead/...`). Mesmo padrão da 5a: mover os blocos
`app.M('/movatak/vendedor/...', authVendedor, async(req,res)=>{...})` inteiros e verbatim
para `src/routes/vendedor.js` dentro de `register(app, deps)`; index.js chama
`rotasVendedor.register(app, {...})` no fim do boot. Reaproveitar os scripts do
scratchpad da 5a (`analyze-admin.js`/`build-admin.js`/`reconstruct.js`/`route-diff`),
trocando o prefixo `/movatak/admin/` por `/movatak/vendedor/`.

Método de extração da 5a (validado): script node (1) enumera os nomes top-level
"providáveis" do index.js; (2) acha os blocos de rota por assinatura (`app.M('/prefixo/`
col-0 → primeiro `});` col-0); (3) deps = providáveis ∩ referenciados nos blocos —
**cuidado: tratar `...spread` como referência real, não acesso a propriedade** (foi o
bug que deixou os `exige*`/`forcaClienteIdNaUrl` de fora na 1ª tentativa). Provas
obrigatórias: reconstrução byte-a-byte contra `git show HEAD:index.js` (blocos idênticos
+ index.js == original menos ranges + adições) + `node --check` + `npm run smoke` (boot
executa o `register` → pega dep faltando no call site) + diff estático do conjunto de
rotas registradas (HEAD == depois) + checagem funcional 401/404. Scripts no scratchpad
da sessão.
