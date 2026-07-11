# Plano de refatoração do index.js em módulos

Este documento é o guia da refatoração incremental do backend (`index.js`,
~10.500 linhas hoje) em módulos dentro de `src/`. Seguimos fase a fase; cada
fase termina em um commit funcional e passível de deploy.

## Estrutura alvo

```
index.js                  # só o boot: cria app/http/io, monta rotas, chama listen()
src/config.js             # constantes de ambiente, MOVATAK_VERSION, flags (MOVATAK_DEBUG, CRON_ATIVO, etc.)
src/db.js                 # pool (pg), query(), e as migrações garantirEstrutura*()
src/realtime.js           # criação do socket.io e os emitters emitir*()
src/zapi.js               # tudo que fala com a Z-API (zapiEnviar, zapiStatus, zapiPost, etc.)
src/leads.js              # registrarConversa, registrarEventoLead, pararAtendimentoLead, limparPedidoAtendente
src/questionario.js       # lógica do questionário
src/ia.js                 # gerarRespostaIALead, travas de auto-resposta, iaResponderAutomatico
src/followups.js          # agendarFollowupV2, enviarFollowupsPendentesDoLead, finalizarFollowupsEsgotados
src/webhook.js            # handlers de /movatak/webhook/* (migra por último)
src/rotas/admin.js        # express.Router() - rotas de admin (authMovatak)
src/rotas/vendedor.js     # express.Router() - rotas de vendedor (authVendedor)
src/rotas/portal.js       # express.Router() - rotas de portal/cliente (authCliente)
src/rotas/publico.js      # express.Router() - rotas sem autenticação
```

### Direção das dependências

```
db → zapi/realtime → domínios (leads, questionario, ia, followups) → webhook → rotas
```

Um módulo só pode importar de módulos "abaixo" dele nessa cadeia. Nunca o
contrário (ex.: `db.js` não pode importar de `leads.js`).

## Fases (uma fase = um commit = um deploy)

1. **config + db** — extrair constantes de ambiente e a camada de banco
   (pool, `query`, migrações `garantirEstrutura*`).
2. **zapi + realtime** — extrair as funções `zapi*` (envio de mensagens,
   status, mídia, etc.) e a criação do socket.io com os `emitir*`.
3. **domínios, um de cada vez** — `leads.js`, depois `questionario.js`,
   depois `ia.js`, depois `followups.js`. Cada um é seu próprio commit.
4. **webhook** — handler(s) de `/movatak/webhook/*`. Migra por último porque
   depende de tudo acima.
5. **rotas** — dividir as ~212 rotas `/movatak/...` em
   `src/rotas/{admin,vendedor,portal,publico}.js` usando `express.Router()`,
   agrupadas pelo middleware de autenticação que já usam hoje
   (`authMovatak`, `authVendedor`, `authCliente`, sem middleware).

## Regras de ouro

1. **Mover código VERBATIM.** Nunca reescrever lógica ao mesmo tempo que
   move. Copiar a função inteira para o novo arquivo, ajustar só imports/
   exports, e apagar do lugar antigo. Se algo parecer bug ou merecer
   melhoria, anotar para depois — não misturar com a movimentação.
2. **`node --check` em tudo antes de commitar.** Rodar em `index.js` e em
   cada arquivo novo/alterado dentro de `src/` antes de qualquer commit.
3. **Nunca deixar uma fase pela metade.** Se a fase não fechar (arquivo
   ainda com código duplicado, import quebrado, etc.), não commitar — ou
   reverter para o estado da fase anterior. Cada commit deve deixar o
   sistema em condição de deploy.

## Como validar cada fase

- `node --check index.js` e `node --check src/**/*.js` (todos os arquivos
  tocados).
- `npm run smoke` (ver `scripts/smoke.js`) — garante que todo módulo novo
  faz `require()` sem erro, com env vars falsas, sem tocar no banco real.
- Revisão manual do diff: nenhuma linha de lógica deve ter mudado, só a
  localização do código.

## Progresso

- [x] Fase 1 — config + db
- [x] Fase 2 — zapi + realtime
- [x] Fase 3a — leads
- [x] Fase 3b — questionario
- [x] Fase 3c — ia
- [x] Fase 3d — followups
- [x] Fase 4 — webhook
- [ ] Fase 5 — rotas (admin/vendedor/portal/publico)
  - [x] Fase 5a — admin (142 rotas → `src/routes/admin.js`)
  - [x] Fase 5b — vendedor (47 rotas → `src/routes/vendedor.js`)
  - [x] Fase 5c — portal (15 rotas `/movatak/app/*` → `src/routes/portal.js`)

### Fase 3b — questionario (`src/questionario.js`)

16 funções do motor de questionário/autoatendimento movidas verbatim:
`reiniciarQuestionarioLead`, `enviarMsgQuestionario`, `cepTemCobertura`,
`montarTextoPergunta`, `interpretarResposta`, `resolverSaltoQuestionario`,
`calcularPontuacao`, `calcularRecomendacao`, `avancarQuestionario`,
`iniciarQuestionarioPorTemplate`, `resolverQuestionarioPorTemplateId`,
`resolverQuestionarioDoLead`, `iniciarQuestionario`, `processarRespostaQuestionario`,
`finalizarQuestionario`, `processarQuestionariosParados`.

**Não há ciclo com followups**: a dependência é unidirecional (questionario →
followups). As funções de followup não chamam nenhuma de questionario.

**Injeção temporária** (`questionario.init(deps)` no boot): o módulo depende de
símbolos que ainda vivem no `index.js` e saem em fases futuras — followups
(`agendarFollowupV2`, `enviarFollowupsPendentesDoLead`, → 3d), funil/vendedor
(`atribuirVendedorBalanceado`, `moverLeadParaFunilSlug`), o menu
(`enviarMenuAtendimento`) e helpers compartilhados (`ehGrupoOuCanal`, `sleep`,
`normalizarDelayQuestionario`, `normalizarCep`, `tipoMidia`). Como as funções
movidas referenciam esses nomes por variável de escopo do módulo, o corpo movido
ficou byte-a-byte idêntico. A fiação de injeção é removida à medida que essas
deps forem extraídas.

**Ficaram no index.js** (não são questionario): `uploadSupabase` e `tipoMidia`
(helpers compartilhados), e o bloco de Menu de Atendimento
(`enviarBoasVindasLead`, `enviarMenuAtendimento`, `processarRespostaMenu`) —
candidato a uma fase 3b-menu própria depois.

### Fase 3d — followups (`src/followups.js`)

5 funções + 1 const movidas verbatim: `followupDataDaLinha`, `agendarFollowupV2`,
`enviarFollowupsPendentesDoLead`, `migrarFU1ParaFU2`, `finalizarFollowupsEsgotados`
e `DIAS_FOLLOWUP_V2` (privada do módulo). Layering: `db → zapi → leads →
followups → questionario` (sem ciclo).

**Imports:** `query` (db), `registrarEventoLead`/`registrarConversa` (leads),
`zapiEnviar` (zapi). **Injetadas** via `followups.init()` (ainda no index.js):
`ehGrupoOuCanal`, `clienteRowEmAusencia` (ausência), `moverLeadParaColunaFunil`
(funil), `podeEnviarMensagemAutomatica` (cluster anti-spam) e `registrarErroZapi`.

**Payoff:** a injeção da 3b encolheu — `agendarFollowupV2` e
`enviarFollowupsPendentesDoLead` agora vêm de `require('./src/followups')` no
index.js e são só encaminhadas ao `questionario.init()` (que ficou intocado).

**Ficaram no index.js** (não são followups extraíveis agora): os blocos
`cron.schedule` (o pump `*/10` e o pós-followup `*/30` — decisão: crons ficam
no index e chamam o módulo), a const `TEMPLATES_FOLLOWUP` (usada por
campanhas/rotas), o cluster anti-spam (`contarMensagensAutomaticasHoje`,
`reentradaFU1Permitida`, `leadRespondeuRecentemente`) e os helpers de ausência
(`avaliarAusencia`, `clienteRowEmAusencia`).

### Fase 3c — ia (`src/ia.js`)

9 funções movidas verbatim: `localizarCampanhaPorIA`, `chamarHaiku` (núcleo
Anthropic via `fetch` — modelo `claude-haiku-4-5-20251001`), `gerarRespostaIALead`,
`enviarComPausasHumanas`, `_normalizarTextoTrava` (privada), `assuntoExigeHumano`,
`respostaIAViolaTravas`, `transferirIAParaHumano`, `iaResponderAutomatico`.

**Sem injeção** (a fase mais limpa) — só imports: `query`/`garantirEstruturaConversas`
(db), `registrarEventoLead`/`registrarConversa`/`pararAtendimentoLead` (leads),
`zapiEnviar` (zapi), `enviarMsgQuestionario` (questionario). Globais: `fetch`,
`process.env`. Layering: `db → zapi → leads → questionario → ia` (ia → questionario
é unidirecional, sem ciclo).

**Ficaram no index.js:** 4 rotas entremeadas no cluster que chamam as funções
movidas — `transcrever-audio` (Whisper/OpenAI), `dispensar-prioridade`,
`resumo-ia`, `sugerir-resposta`. index.js importa as funções por destructuring.

## Roadmap — o que falta (ordem recomendada)

Fase 3 completa. `index.js` em 8.492 linhas. Composição do que resta (medida):
rotas Express ~4.882 · webhook ~920 · funções soltas/helpers ~1.472 ·
cron.schedule ~139 · imports/boot/middleware ~1.079.

**Ordem sugerida** (extrair folhas primeiro reduz a dívida de injeção — ao criar
cada módulo lateral, remover as linhas correspondentes dos `init()` de
followups/questionario/ia, que passam a importar direto):

1. **Laterais (folhas):**
   - [x] `src/util.js` — telefone/mídia/misc: `variantesTelefone`,
     `extrairDigitosTelefone`, `telefonesEquivalentes`, `ehGrupoOuCanal`,
     `tipoMidia`, `normalizarCep`, `sleep`, `uploadSupabase`, `registrarErroZapi`,
     `enviarAlerta`. **Feito** (`v2.7.24-lateral-util`, index.js 8492→8400). Folha:
     importa só db+zapi (+axios/crypto), sem injeção. questionario/followups seguem
     recebendo os helpers via `init()`, agora forwardeados do util (arquivos deles
     intocados).
   - [x] `src/ausencia.js` — `avaliarAusencia`, `clienteRowEmAusencia`,
     `dispararAusenciaSeAplicavel`. **Feito** (`v2.7.25-lateral-ausencia`, index.js
     8400→8269). Sem injeção (importa db+zapi+leads+util). followups recebe
     `clienteRowEmAusencia` forwardeado do ausencia (arquivo dele intocado).
   - [x] `src/antispam.js` — `contarMensagensAutomaticasHoje`,
     `podeEnviarMensagemAutomatica`, `reentradaFU1Permitida`,
     `leadRespondeuRecentemente`. **Feito** (`v2.7.26-lateral-antispam`, index.js
     8269→8224). Sem injeção (importa db+config). followups recebe
     `podeEnviarMensagemAutomatica` forwardeado (arquivo dele intocado).
   - [x] `src/funil.js` — `moverLeadParaFunilSlug`, `moverLeadParaColunaFunil`,
     `atribuirVendedorBalanceado`. **Feito** (`v2.7.27-lateral-funil`, index.js
     8224→8123). Importa db+leads+zapi; **injeta** 3 sub-helpers que ficam no index
     (`garantirFunilPadraoCliente`, `etapaSistemaPorSlug`,
     `sincronizarColunaComWhatsapp` — dependem de nicho/zapi-extractors, saem
     depois). questionario/followups recebem as fns de funil forwardeadas.
   - [x] `src/menu.js` — `enviarBoasVindasLead`, `enviarMenuAtendimento`,
     `processarRespostaMenu`. **Feito** (`v2.7.28-lateral-menu`, index.js
     8123→8039). Sem injeção — importa db+zapi+leads+util+questionario. menu requer
     questionario (sem ciclo: questionario recebe `enviarMenuAtendimento` por
     injeção, não por require). questionario recebe-o forwardeado do menu.
2. **Fase 4 — webhook** (`src/webhook.js`): 6 handlers. Padrão: corpo do handler
   → `async function handleX(req,res)`; index.js registra `app.M(path, handleX)`.
   Split em 2 deploys (decisão do dono, isolar o crítico):
   - [x] **4a** — 5 handlers menores (`handleMensagem`, `handleEtiqueta`,
     `handleResposta`, `handleStatus`, `handleZapiStatus`; ~224 linhas de corpo).
     **Feito** (`v2.7.29-fase4a-webhook`, index.js 8039→7818). Importa
     db/leads/followups/util/realtime/zapi; injeta só `textoBateGatilho`.
   - [x] **4b** — `/webhook/zapi` (o orquestrador). **Feito** (`v2.8.1-fase4b-webhook`,
     index.js 7822→6849). `handleZapi` (corpo de 684 linhas) + **22 helpers exclusivos**
     (payload/comando, 0 usos fora do webhook) movidos pro `src/webhook.js`; **6
     compartilhados injetados** (`comandosDoVendedor`, `contemComando`,
     `localizarCampanhaPorGatilho`, `normalizarGatilho`, `resolverReplyInfoLead`,
     `textoBateGatilho`). webhook.js importa de 13 módulos. Reconstrução byte-a-byte
     + symbol-check (só falso-positivo) + smoke. Os 5 handlers da 4a preservados verbatim.
3. **Fase 5 — rotas** (`src/routes/*.js`, ~4.882 linhas): agrupar por domínio, cada
   arquivo exporta `register(app, deps)`. Sub-fases 5a admin · 5b vendedor · 5c portal ·
   5d publico (uma fase = um commit = um deploy). Depende dos laterais.
   - [x] **5a admin** (`src/routes/admin.js`, `v2.8.2-fase5a-admin`, index.js
     6849→3335): as **142 rotas `/movatak/admin/*`** movidas VERBATIM para dentro de
     `register(app, deps)`. Padrão: os blocos `app.M('/movatak/admin/...', ...)` inteiros
     foram para o módulo, byte-a-byte, na ordem original (col-0, sem reindentar). O
     index.js requer `./src/routes/admin` no topo e chama `rotasAdmin.register(app, {...})`
     **no fim do boot** (antes do `httpServer.listen`), quando todos os middlewares,
     helpers e módulos já estão definidos. **111 deps injetadas** — middlewares de auth
     compartilhados que ficam no index.js (`authMovatak`, `authMovatakOuApp`,
     `forcaClienteIdNaUrl` e os `exige*`, usados também por 5b/5c), ~40 helpers ainda no
     index.js, e funções dos módulos já extraídos. Como os corpos referenciam tudo por
     nome desestruturado de `deps`, os call sites ficaram idênticos.
     **Sem catch-all/`app.get('*')`** e prefixos de rota distintos (`/admin` vs
     `/app`/`/vendedor`/`/webhook`) → registrar as admin no fim não muda o matching do
     Express. Duas rotas admin duplicadas pré-existentes (`PATCH .../leads/:id/vendedor`,
     `POST .../leads/:id/mensagem-kanban`) preservadas na ordem original (Express usa a 1ª).
     Provas: reconstrução byte-a-byte contra `git show HEAD:index.js` (A: 142 blocos
     idênticos; B: index.js == original menos os ranges + adições documentadas) +
     `node --check` + `npm run smoke` (boot roda o `register` com as 111 deps) + checagem
     funcional ao vivo (401 sem auth / 404 em rota inexistente) + diff estático do conjunto
     de 212 rotas registradas (HEAD == pós-5a, idêntico).
     **BUG PRÉ-EXISTENTE achado (não introduzido pela 5a, NÃO corrigido aqui p/ manter
     verbatim):** a rota `GET /movatak/admin/clientes/:id/leads.csv` referencia `csvEscape`,
     que a Fase 4b moveu para `src/webhook.js` sem exportar/reimportar — logo essa rota
     lança `ReferenceError: csvEscape is not defined` desde `v2.8.1` (só ao ser chamada,
     pós-auth). Corrigir em commit separado (exportar `csvEscape` do webhook ou movê-lo p/
     `src/util.js` e injetar).
   - [x] **5b vendedor** (`src/routes/vendedor.js`, `v2.8.3-fase5b-vendedor`, index.js
     3335→2451): as **47 rotas `/movatak/vendedor/*`** movidas VERBATIM para
     `register(app, deps)`, mesmo padrão da 5a. **52 deps injetadas** — `authVendedor` e
     os `vendedorPode*` (`Setor`/`Lead`/`Conversa`/`Coluna`/`Agendamento`, ficam no
     index.js), helpers ainda no index.js e fns de módulos já extraídos. Provas: mesmo
     conjunto da 5a — reconstrução byte-a-byte vs HEAD (47 blocos idênticos + index.js ==
     original menos ranges) + `node --check` + `npm run smoke` + diff de rotas (212==212
     contra o commit pré-5a) + funcional 401/404. Sem bug pré-existente desta vez
     (symbol-check só falso-positivo de regex/local). Scripts genéricos parametrizados por
     `cfg-vendedor.js` no scratchpad (reutilizáveis na 5c trocando o prefixo/config).
   - [x] **5c portal** (`src/routes/portal.js`, `v2.8.4-fase5c-portal`, index.js
     2451→2036): as **15 rotas `/movatak/app/*`** (portal do cliente, `authCliente`;
     `/app/login` é pública) movidas VERBATIM para `register(app, deps)`. Superfície de
     deps mínima — **6 deps** (`authCliente`, `query`, `hashSenha`, `normalizarPermissoes`,
     `garantirEstruturaCampanhasTemplates`, `erroEstruturaBanco`). A rota `app/exportar-leads`
     usa um `esc` CSV **local** (não o `csvEscape` do bug da 5a) — self-contained, sem
     bug. **Deixado como glue no index.js** (não virou módulo): os 6 registros finos de
     webhook (`app.post('/movatak/webhook/...', handleX)` — só fiação p/ handlers já em
     `src/webhook.js`) e `health`/`version` (handlers de 2 linhas). Provas: reconstrução
     byte-a-byte + node --check + smoke + diff de rotas (212==212 vs `e41380c`) + funcional
     (401 sem token / 400 no login / 404). **Fase 5 concluída** — index.js reduzido de
     ~10.500 para ~2.036 linhas (esqueleto: imports, setup Express, middlewares de auth,
     ~40 helpers, crons, boot, e a fiação fina de rotas).

Estimativa do `index.js` no fim: só 4+5 → ~2.000–2.500 linhas; 4+5 + laterais
(+ crons num scheduler) → ~800–1.200 linhas.

**Trilha paralela (opcional, separada da refatoração) — performance.** Mover
código verbatim NÃO acelera nada. Ganhos reais exigem outra trilha, com medição
antes/depois: tirar `garantirEstrutura*` do hot path (boot/memoize); prompt
caching em `chamarHaiku`; revisar índices do cron pump `*/10`. Não misturar com
commits de refatoração.

### Perf 1 — migrações memoizadas (`v2.8.5-perf-migracoes-memoizadas`) — FEITO
Diagnóstico + correção (jul/2026, com medição):
- **`garantirEstrutura*` no hot path → memoizado.** `garantirEstruturaConversas`
  rodava **23 queries DDL por mensagem** (`registrarConversa` em todo webhook/IA).
  Envolvido em `umaVez(fn)` no `module.exports` de `src/db.js` (roda 1× por processo;
  reseta o cache em falha p/ preservar a resiliência). Medido: 2ª chamada em diante =
  0 queries. As 11 funções `garantirEstrutura*`/`garantirColunas*` (todas arg-less)
  passaram a ser memoizadas. Behavior-preserving (DDL idempotente ainda roda 1×).
- **Índice do cron pump `*/10` → nada a fazer.** `EXPLAIN ANALYZE` em produção:
  **0,969 ms**, usando índice parcial existente `idx_followup_envio`. Tabela pequena
  (~1.600 linhas) e já com 7 índices (alguns redundantes: `idx_followup_status` ==
  `idx_movatak_followup_status_envio`). Não é gargalo.
- **Prompt caching em `chamarHaiku` → ADIADO (não é ganho limpo).** O `system` é montado
  por request do banco com bytes voláteis (respostas rápidas ordenadas por `vezes_usado
  DESC`, roteiro/followups por lead). Cache é prefix-match exato → quebra a cada chamada.
  Haiku 4.5 exige prefixo ≥4096 tokens p/ cachear; o trecho estável provavelmente fica
  abaixo. Exige reestruturar a montagem do prompt (prefixo estável vs volátil) — trabalho
  de verdade em código de IA, ganho incerto, medir antes/depois. Não fazer especulativo.

### Faxina do index.js — sem fatia limpa de baixo risco
Os ~40 helpers restantes são interdependentes (nicho ↔ funil ↔ zapi-extractors). Os 3
helpers de funil que sobraram estão injetados via `funil.init` justamente porque dependem
de nicho/zapi-extractors ainda no index — movê-los arrasta a cadeia e arrisca ciclos. Não
há "mover N funções verbatim e pronto"; é um untangling maior. Deixar por ora (menor diff).
