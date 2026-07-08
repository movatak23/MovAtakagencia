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
- [ ] Fase 4 — webhook
- [ ] Fase 5 — rotas (admin/vendedor/portal/publico)

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
