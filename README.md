# Movatak Backend

Backend Node.js para o sistema Marketing Sem Agência 2.0.
Roda no mesmo projeto Railway do LoggZap.

---

## Variáveis de ambiente (Railway)

```
DATABASE_URL        = (mesmo do LoggZap — já configurado)
MOVATAK_SECRET      = uma_senha_forte_aqui   ← você define
MOVATAK_PORT        = 3001                   ← ou deixa o Railway usar PORT
```

---

## Deploy no Railway

1. Copiar os arquivos `index.js`, `package.json` e `schema.sql` para um novo serviço no Railway
   (ou pasta separada no mesmo repositório GitHub do LoggZap)

2. Adicionar as variáveis de ambiente acima

3. Rodar o schema SQL no banco existente:
   - Railway → seu banco PostgreSQL → Query
   - Colar e executar o conteúdo de `schema.sql`

4. Deploy automático pelo GitHub commit

---

## Webhooks Z-API — configurar por cliente

No painel Z-API de cada cliente, configurar:

| Evento                  | URL                                          |
|-------------------------|----------------------------------------------|
| Mensagem recebida       | https://seu-app.railway.app/movatak/webhook/mensagem  |
| Etiqueta aplicada       | https://seu-app.railway.app/movatak/webhook/etiqueta  |
| Mensagem recebida (2)   | https://seu-app.railway.app/movatak/webhook/resposta  |

O campo `instanceId` deve ser enviado pelo Z-API no payload — confirmar nas configs do webhook.

---

## API — App do cliente (React Native)

Header obrigatório: `x-app-token: mvtk_XXXX` (gerado no onboarding)

```
GET /movatak/app/dashboard?dias=30
```

Retorna:
```json
{
  "periodo_dias": 30,
  "total_leads": 45,
  "convertidos": 12,
  "em_followup": 8,
  "leads_hoje": 3,
  "vendas_hoje": 1,
  "taxa_conversao": "26.7",
  "plano_top": { "nome": "Plano Pro", "total": "8" },
  "leads_por_dia": [{ "dia": "2025-05-01", "leads": "3" }]
}
```

---

## API — Painel Movatak (seu acesso)

Header obrigatório: `x-movatak-secret: sua_senha_forte`

```
GET  /movatak/admin/clientes               — lista todos os clientes
POST /movatak/admin/clientes               — cadastra cliente novo
GET  /movatak/admin/clientes/:id/leads     — leads de um cliente
PATCH /movatak/admin/leads/:id/plano       — vincula plano vendido ao lead
```

### Cadastrar cliente (POST /movatak/admin/clientes)

```json
{
  "nome": "Auto Center Silva",
  "whatsapp": "5581999990000",
  "zapi_instance": "INSTANCE_ID_AQUI",
  "zapi_token": "TOKEN_AQUI",
  "zapi_client_token": "CLIENT_TOKEN_AQUI",
  "trigger_msg": "vim pelo anuncio",
  "teto_cpl": 25.00,
  "planos": [
    { "nome": "Revisão Basic", "valor": 299.90 },
    { "nome": "Revisão Premium", "valor": 599.90 }
  ]
}
```

Retorna: `{ "id": 1, "app_token": "mvtk_1234_abcdefgh" }`
→ Esse `app_token` vai no app mobile do cliente.

---

## Sequência de follow up

| Etapa | Quando dispara |
|-------|---------------|
| 1     | D+1           |
| 2     | D+3           |
| 3     | D+7           |
| 4     | D+14          |

Se o lead responder qualquer mensagem → sequência pausada automaticamente.
Se a etiqueta mudar para "Cliente" → sequência cancelada + msg de boas-vindas enviada.
