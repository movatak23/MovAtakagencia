# PLANO_INSTAGRAM.md — Integração Instagram Direct (aditivo, sem tocar no WhatsApp)

> Base: v2.16.5. Trazer conversas do **Instagram Direct** pro MESMO inbox / chat / kanban do WhatsApp.
> Estratégia: **camada nova em paralelo**. O WhatsApp fica byte-a-byte igual; o Instagram entra ao lado, **gated por flag** e **reversível**.

## Regras de ouro (herdadas do REFATORACAO.md)
- **Aditivo:** nada do WhatsApp é reescrito — só se ADICIONA código ao lado. `handleZapi` e `zapiEnviar*` ficam intocados.
- **Gated:** flag `ig_habilitado` por tenant, **default `false`** → nenhum cliente (DTFclub etc.) vê diferença até você ligar.
- **Uma fase = um commit = um deploy.** `node --check` em tudo + `npm run smoke` antes de commitar. Incrementar `MOVATAK_VERSION`. Nunca deixar fase pela metade.
- **Reversível:** desligar a flag / remover o registro do webhook na Meta = sistema volta 100% ao de hoje.
- Migração de call sites move código **verbatim** (mesmo padrão da refatoração): o galho WhatsApp chama exatamente o `zapiEnviar` de antes; prova byte-a-byte por arquivo.

---

## Fase 0 — Fundação de canal (schema + flag). Zero comportamento novo.
Tudo via `garantirEstrutura*` memoizado (padrão do `src/db.js`). Nenhuma query existente muda, porque o default preserva o mundo atual.

- `movatak_leads`: `ADD COLUMN canal TEXT DEFAULT 'whatsapp'`, `ADD COLUMN canal_id TEXT`.
  (lead antigo sem canal = WhatsApp, como sempre; lookups por `telefone` continuam válidos.)
- `movatak_clientes`: `ADD COLUMN ig_habilitado BOOLEAN DEFAULT false`, `ig_user_id TEXT`, `ig_page_id TEXT`, `ig_access_token TEXT`, `ig_token_expira_em TIMESTAMPTZ`, `ig_app_secret TEXT`, `ig_verify_token TEXT`.
- Índice: `CREATE INDEX ... ON movatak_leads(cliente_id, canal, canal_id) WHERE canal_id IS NOT NULL`.

**Prova:** deploy sobe, `curl /movatak/version` novo; nenhuma rota muda de comportamento. Invisível em produção.

---

## Fase 1 — Camada de envio (dispatcher) com WhatsApp verbatim. Ainda não migra ninguém.
Novo módulo `src/envio.js`:
```
enviarMensagem(cliente, lead, texto, { replyMsgId } = {}) →
   lead.canal === 'instagram' ? igEnviar(cliente, lead, texto, ...)   // stub por ora
                              : zapiEnviar(cliente.zapi_instance, cliente.zapi_token, cliente.zapi_client_token, lead.telefone, texto, replyMsgId)
```
+ irmãs: `enviarImagem/enviarVideo/enviarAudio/enviarDocumento` (mesma bifurcação).
- O galho WhatsApp reproduz **exatamente** a assinatura atual de `zapiEnviar*` (nada muda).
- O galho Instagram existe mas **nunca é chamado** ainda (não há lead com `canal='instagram'`).
- **Não migrar call sites nesta fase.** Só introduzir a camada.

**Prova:** `node --check` + teste unitário: `enviarMensagem` com `lead.canal='whatsapp'` chama `zapiEnviar` com os mesmos args de hoje.

---

## Fase 2 — `src/instagram.js` (Graph API). Biblioteca isolada, desconectada do fluxo.
- `igEnviar(cliente, lead, texto)` → `POST https://graph.facebook.com/v21.0/{ig_user_id}/messages` com `{ recipient:{id: lead.canal_id}, message:{text} }` + page token.
- `igEnviarMidia(...)` (attachment por URL).
- `igPerfil(cliente, igsid)` → `GET /{igsid}?fields=name,username,profile_pic` (nome/@ não vêm no webhook).
- `igValidarAssinatura(rawBody, header, appSecret)` → confere `X-Hub-Signature-256` (HMAC).
- `igRefreshToken(cliente)` → renova o long-lived page token (~60 dias); agendar num cron `*/dia`.
- Helper de **janela 24h**: decide se pode texto livre ou precisa de tag (`human_agent`).

**Prova:** testável isolado (chamada real numa conta de teste). Nada no runtime chama ainda.

---

## Fase 3 — Webhook de entrada, **paralelo** ao `handleZapi`.
Novo handler (`src/webhook.js` ou `src/webhook_ig.js`): `handleInstagram`.
- `GET /movatak/webhook/instagram`: responde `hub.challenge` (verificação da Meta).
- `POST /movatak/webhook/instagram`: valida assinatura → resolve tenant por `ig_user_id`/`ig_page_id` (**só tenants com `ig_habilitado=true`**; senão 200 e ignora) → `upsert` lead por `(cliente_id, canal='instagram', canal_id=IGSID)` → busca nome/@ via `igPerfil` → grava `movatak_conversas` (dedup de `message_echoes` reusando a lógica de `fromMe`/`uq_conversas_lead_msgid`) → dispara o downstream (menu/questionario/IA/funil), **que já é keyed por lead**.
- Registrar o thin-route no `index.js` (glue), igual aos webhooks atuais.

**`handleZapi` não é tocado.** Risco no fluxo WhatsApp = zero.

**Prova:** teste ao vivo numa conta IG de teste com `ig_habilitado=true` (mensagem entra, vira lead, cai no funil, IA responde). Tenants sem flag: nada muda.

---

## Fase 4 — Ligar a **saída** para IG (migração incremental dos 44 call sites).
Trocar `zapiEnviar*(...)` por `enviarMensagem/enviarMidia(cliente, lead, ...)`, **um arquivo por commit**, cada um provado byte-a-byte no caminho WhatsApp (o galho `else` é idêntico ao código anterior). Enquanto um arquivo não é migrado, ele segue chamando `zapiEnviar` direto e **continua funcionando** (só não envia por IG — tolerável durante a migração, já que leads IG são gated/poucos).

Ordem sugerida — do menos crítico ao mais crítico (inventário v2.16.5):

| # | Arquivo | Call sites | Observação |
|---|---------|-----------|------------|
| 4a | `src/util.js` | 1 | trivial |
| 4b | `src/ausencia.js` | 1 | resposta de ausência |
| 4c | `src/ia.js` | 1 | resposta da IA (Haiku) |
| 4d | `src/followups.js` | 1 | **ver Fase 5** (janela 24h) |
| 4e | `src/menu.js` | 3 | boas-vindas + menu |
| 4f | `src/questionario.js` | 4 | motor de autoatendimento |
| 4g | `src/routes/vendedor.js` | 16 | painel do vendedor |
| 4h | `src/routes/admin.js` | 15 | painel admin |
| 4i | `index.js` | 2 | glue restante |

Total: **44**. As 8 definições em `src/zapi.js` **permanecem** (o dispatcher chama elas no galho WhatsApp).

**Prova por arquivo:** reconstrução byte-a-byte do galho WhatsApp vs `git show HEAD:<arquivo>` + `node --check` + smoke + teste funcional do envio WhatsApp.

---

## Fase 5 — Política de janela / followup do Instagram.
O Instagram **não tem template geral** como o WhatsApp: fora das 24h só dá pra reengajar com a tag `human_agent` (7 dias, exige aprovação) ou tags pontuais.
- No `followups`/dispatcher: se `lead.canal='instagram'` e **fora da janela**, não disparar régua livre → usar `human_agent` (se aprovado) ou pular e logar. Configurável por tenant.
- Não altera a régua do WhatsApp (galho `canal='whatsapp'` intocado).

---

## Fase 6 — UI multicanal (frontend).
Editar **`public/index.html`** (frontend servido; ver regra em `movatak-frontend-servido-public`). Cobrir os **dois** blocos de layout do funil.
- Selo de canal no card (inbox + kanban), filtro `Todos / WhatsApp / Instagram`, status "Instagram: conectado", `@handle` no lugar do telefone, badge "Instagram Direct" no header do chat, faixa de **janela 24h**.
- Kanban **único** (canal = filtro/selo, não board separado). Preview de referência: artifact publicado.

---

## Fase 7 — Onboarding + App Review Meta (calendário).
- Tela em **Credenciais**: conectar conta IG (OAuth Meta), gravar `ig_*`, ligar `ig_habilitado`.
- **App Review** (`instagram_manage_messages`, `pages_manage_metadata`) — começar **já**, roda em paralelo às fases de código; é o gargalo de prazo (semanas).

---

## Rollback
`UPDATE movatak_clientes SET ig_habilitado=false` (ou remover o registro do webhook na Meta) → nenhum lead IG entra/sai; o WhatsApp nunca foi reescrito, então volta ao estado atual sem redeploy.

## Sequência mínima pra um piloto funcional
0 → 1 → 2 → 3 → (4c IA, 4e menu, 4f questionario) → 6 (UI básica) → ligar flag num tenant de teste. As migrações 4g/4h (painéis) e a 5 (política de followup) entram depois, sem travar o piloto.
