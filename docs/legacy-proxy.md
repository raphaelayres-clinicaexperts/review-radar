# [Legado] Codex Proxy — Bun/TypeScript

> Este documento é o README original do projeto, de quando ele era apenas um
> proxy local OAuth para a API do Codex/ChatGPT. O proxy (`src/server.ts`,
> `src/cli/*`, `src/services/*`) continua no repositório e é reutilizado pelo
> Review Radar e pela Lambda (`lambda/codex-client.ts`, `lambda/codex-shim.ts`),
> mas o README principal do repo agora documenta o projeto como um todo
> (Review Radar + Task Radar). Veja `README.md` na raiz.

Proxy local que autentica com sua conta ChatGPT Pro via OAuth PKCE e roteia
chamadas pelo endpoint `chatgpt.com/backend-api/codex/responses`, expondo uma
API compatível com o formato OpenAI Chat Completions.

## Pré-requisitos

- [Bun](https://bun.sh) instalado
- Conta ChatGPT Pro/Plus ativa
- **CLIENT_ID** extraído do app desktop Codex (ver abaixo)

## Como extrair o CLIENT_ID

O `CLIENT_ID` (formato `app_xxxxxx`) é hardcoded no binário do app desktop
Codex da OpenAI. Opções para encontrá-lo:

1. **Inspecionar tráfego de rede**: Use mitmproxy, Charles Proxy ou Wireshark
   durante o login do app desktop. O `client_id` aparece como query param na
   URL de `/oauth/authorize`.

2. **Inspecionar o binário**: No macOS, o app Electron tem os fontes em
   `Contents/Resources/app.asar`. Extraia com `npx asar extract` e procure
   por `client_id` ou `app_`.

3. **DevTools**: Se o app desktop permitir abrir DevTools (Ctrl+Shift+I),
   monitore a aba Network durante o login.

## Setup

```bash
# Entrar no diretório do projeto
cd codex-integration

# Definir o CLIENT_ID
export CODEX_CLIENT_ID="app_SEU_ID_AQUI"

# Autenticar (abre o browser)
bun run auth

# Verificar status
bun run status

# Subir o servidor proxy (produção / sem reload)
bun run start

# Desenvolvimento: reinicia o servidor ao guardar ficheiros em src/
bun run dev
```

## Acompanhar uso e percentuais

`GET /usage` faz **sempre** um pedido ao Codex em  
`https://chatgpt.com/backend-api/codex/usage` com o teu token (mesma auth que as completions).

**Primeiro vem o `resumo`** (PT, pensado para bater o olho), alinhado à ideia de **Sessão** / **Semanal** / **Code review**:

- `resumo.sessao` / `resumo.semanal`: `restamPercent`, `usadoPercent`, `barraUsadoPercent` (preenche a barra como no app), `renovaEm` (ex.: `4h 46min`), `renovaEmISO`, `deficitPercent` (só se `used_percent` > 100).
- `resumo.linhas`: frases curtas, uma por linha — o `bun run usage` imprime isto no topo.

| Campo | Significado |
|--------|-------------|
| **`resumo`** | Leitura humana + blocos por janela. |
| **`codex`** | JSON **completo** da API (debug / integrações). |
| **`codexSummary`** | Vista técnica compacta (inglês). |
| **`codexFetch`** | `ok`, `status`, `error`. |
| **`proxy`** | Métricas locais do proxy. |

Resposta mínima só com resumo + fetch: `GET /usage?minimal=1` ou `USAGE_MINIMAL=1 bun run usage`.

Não precisas de ter feito nenhuma completion antes.

```bash
curl -s http://localhost:3456/usage | jq .resumo
curl -s "http://localhost:3456/usage?minimal=1"
bun run usage
```

Log JSON após cada completion (opcional): `CODEX_PROXY_LOG_USAGE=1 bun run start`

Em respostas **sem** `stream`, o objeto `usage` usa valores do último evento com `usage` quando existirem; caso contrário usa a estimativa por caracteres.

**Nota:** `proxy.quotaFromHeaders` depende dos headers da última `POST .../responses` (podem ser escassos). O quadro oficial de cotas Codex está em **`codex`** / **`codexSummary`**.

## Usando como drop-in replacement da OpenAI API

O servidor expõe `POST /v1/chat/completions` no formato padrão:

```bash
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4-mini",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

Com conta **ChatGPT**, use modelos **Codex** (`gpt-5.4`, `gpt-5.4-mini`, `gpt-5-codex`, …). Nomes de chat antigos (`gpt-4o`, `gpt-3.5-turbo`, …) são mapeados para **`gpt-5.4-mini`**.

### Com OpenAI SDK (Node/TS):

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:3456/v1",
  apiKey: "dummy", // não é usado, mas o SDK exige
});

const response = await client.chat.completions.create({
  model: "gpt-5.4-mini",
  messages: [{ role: "user", content: "Olá!" }],
});
```

### Com o Ayres Translation Engine:

No seu config do OpenRouter/provider, aponte o `baseURL` para
`http://localhost:3456/v1` e use `apiKey: "dummy"`.

## Estrutura do projeto (na época do proxy standalone)

Comandos (`bun run start`, `auth`, etc.) devem ser executados na **raiz** do repositório (`tokens.json` e `usage-session.json` ficam aqui).

```
./
├── src/
│   ├── config.ts              # OAuth, URLs, paths de ficheiros
│   ├── server.ts               # HTTP: /v1/chat/completions, /usage, /health
│   ├── cli/
│   │   ├── auth.ts            # OAuth PKCE (browser)
│   │   ├── status.ts          # Estado do token
│   │   └── usage.ts           # Chama GET /usage local
│   └── services/
│       ├── crypto.ts          # PKCE + state
│       ├── tokens.ts          # tokens.json, refresh
│       ├── codex-client.ts    # POST codex/responses (SSE)
│       ├── codex-usage-api.ts # GET codex/usage + resumo PT
│       ├── model-resolve.ts   # Aliases de modelo
│       └── usage-store.ts     # Métricas do proxy
├── tests/                     # bun test tests
├── package.json
├── README.md
├── tokens.json                # (gerado pelo auth, não commitar em público)
└── usage-session.json         # (opcional, persistência local)
```

## Segurança

- Tokens salvos em `tokens.json` (plaintext). Em produção, considere:
  - Criptografar com chave de env var
  - Usar `node-keytar` para OS keychain
  - Rodar em ambiente isolado
- O servidor escuta apenas em localhost por padrão
- CSRF protection via state parameter no fluxo OAuth
- PKCE impede interceptação do authorization code

## Troubleshooting

| Problema | Solução |
|----------|---------|
| `client_id` inválido | Extrair o correto do app desktop |
| 401 no Codex endpoint | `bun run auth` de novo |
| Refresh falha | Sessão expirou completamente, re-autenticar |
| Stream vazio | Usar modelo Codex (`gpt-5.4-mini`, `gpt-5-codex`, …) |
| 400 "model is not supported" | Conta ChatGPT exige ids Codex atuais, não `gpt-4o`/`codex-mini` |
| CORS | O servidor já inclui headers CORS para `*` |
