# review-radar

Bot de review automático de Pull Requests (**Review Radar**) + pré-análise de
tasks do Jira antes de entrarem em desenvolvimento (**Task Radar**), rodando
como uma Lambda única para os repositórios da clinicaexperts.

- **Review Radar**: em todo PR aberto/atualizado, roda classificação de risco
  (`radar`) + review de código (`gabi`) e publica o resultado no próprio PR
  (body + comentário), sem duplicar comentários a cada push.
- **Task Radar**: dado o texto de uma task do Jira, prevê módulos/arquivos
  prováveis de serem tocados e estima esforço, **antes** de alguém pegar a
  task — ver `docs/task-radar-research.md` para o embasamento e os números.

## Arquitetura

```
GitHub (PR / issue_comment)
        │  webhook (HMAC X-Hub-Signature-256)
        ▼
   API Gateway / Lambda Function URL
        │
        ▼
┌───────────────────────────┐
│   Lambda: radar-mvp       │
│   (lambda/handler.ts)     │
│                           │
│  modo "webhook"           │──▶ valida assinatura, filtra evento,
│                           │    auto-invoca async (modo "worker")
│  modo "worker"            │──▶ busca diff (GitHub API)
│                           │    roda radar (risco/gates) + gabi (review)
│                           │    aplica business-rules/ se o path bater
│                           │    edita body do PR + upsert de comentário
│                           │
│  modo "task-analyze"      │──▶ pré-análise de task (Task Radar v7):
│                           │    retrieval (BM25 + grafo de código +
│                           │    co-change) + rerank via LLM
│                           │
│  modo "refresh-artifacts" │──▶ cron diário: regenera code-graph,
│                           │    co-change e task-index
└─────────┬─────────────────┘
          │
          ▼
  DynamoDB (radar-mvp)          S3 (clinicaexperts-insights-data)
  - TOKENS#codex                - artefatos do Task Radar v7
  - REVIEW#<repo>#<pr>            (code-graph, co-change, index)
  - DEDUP#<repo>#<pr>#<sha>

Portal de insights (separado, fora deste repo) consome os artefatos do S3
e os relatórios expostos pela Lambda (rotas /stats, /task-analyze).
```

O core do proxy Codex/ChatGPT (`src/services/codex-client.ts`,
`src/services/tokens.ts`, OAuth PKCE) nasceu como um projeto à parte — ver
`docs/legacy-proxy.md` — e hoje é reaproveitado tanto pelo CLI local
(`src/cli/review.ts`) quanto pela Lambda (`lambda/codex-client.ts`,
`lambda/codex-shim.ts`).

## Mapa de pastas

| Pasta | Conteúdo |
|---|---|
| `src/radar/` | Motor de classificação de risco do PR (gates, tamanho, DRS, integração Jira/GitHub) |
| `src/reviewer/` | "Gabi", o reviewer de código (persona, referências, geração do review) |
| `src/services/` | Cliente Codex/OAuth, resolução de modelo, custo/uso — compartilhado entre CLI e Lambda |
| `src/cli/` | Comandos locais: `auth`, `status`, `usage`, `review` (dry-run) |
| `lambda/` | Handler da Lambda: webhook, worker, task-radar, refresh-artifacts, store (Dynamo/fs), GitHub App auth |
| `scripts/` | Deploy (`deploy.sh`), build (`build.sh`), Task Radar v7 (`task-radar-v7/`), benchmarks, geração de índices |
| `business-rules/` | Registry de regras de negócio por domínio (ex.: `financeiro.md`) injetadas no review quando o diff toca paths relacionados |
| `docs/` | Pesquisa e decisões de arquitetura (`task-radar-research.md`, `legacy-proxy.md`) |
| `tests/` | Testes `bun test` |

## Como rodar local

Pré-requisitos: [Bun](https://bun.sh), conta ChatGPT Pro/Plus (para o Codex) e um `GITHUB_TOKEN` com acesso ao repo que quiser testar.

```bash
# instalar dependências
bun install

# copiar e preencher o .env
cp .env.example .env

# autenticar no Codex (abre o browser, PKCE)
bun run auth
bun run status

# rodar o review de um PR real em dry-run (não escreve nada no GitHub)
bun run review --pr <owner/repo#123> --dry-run

# rodar o worker da Lambda localmente contra um PR real (usa STORE=fs)
bun lambda/local.ts --pr <owner/repo#123> --dry-run

# testes
bun test
```

Detalhes de OAuth/PKCE do proxy Codex e troubleshooting (401, stream vazio,
modelo não suportado) estão em `docs/legacy-proxy.md`.

## Como deployar

Deploy é idempotente via `scripts/deploy.sh` (cria/atualiza tabela DynamoDB,
role IAM, função Lambda, Function URL pública e o schedule diário de
`refresh-artifacts`):

```bash
# precisa de credenciais AWS válidas na sessão (aws sts get-caller-identity)
# se a conta usa MFA, gere uma sessão temporária antes de rodar o script, ex.:
aws sts get-session-token --serial-number <ARN do seu MFA> --token-code <código> \
  --duration-seconds 3600
# exporte AccessKeyId/SecretAccessKey/SessionToken retornados como
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN

bash scripts/deploy.sh
```

O script lê `GITHUB_TOKEN`, `WEBHOOK_SECRET`, `CODEX_CLIENT_ID`, `APP_ID`,
`APP_PRIVATE_KEY_B64`, `STATS_KEY`, `JIRA_*` do `.env` local (se existir) e
sobe como variáveis de ambiente da Lambda. Ao final, imprime a Function URL
para configurar o webhook em Settings > Webhooks do repo do GitHub.

## Benchmarks e resultados

O Task Radar já passou por 7 iterações de arquitetura de retrieval (lexical
→ BM25 → grafo de código + co-change + rerank via LLM). Os números atuais
(v7, benchmark large) giram em torno de **Acc@5 ~95%** e MAP@10
correspondente — bem acima do platô de ~50% precision/recall da v1.

Ver `docs/task-radar-research.md` para: comparação com literatura
(Agentless, LocAgent, SweRank), a tabela de trade-off custo × complexidade ×
Acc@5 de cada abordagem, e a justificativa da arquitetura escolhida para
rodar dentro do timeout da Lambda. Os benchmarks brutos por versão (não
versionados — são artefatos gerados) ficam em `task-benchmark*.json` na raiz;
para regerar: `bun scripts/task-radar-v7/benchmark-v7.ts`.

## Como adicionar regras de negócio

O review injeta contexto de domínio quando o diff toca paths relevantes,
via `business-rules/registry.json`:

```json
{
  "domain": "financeiro",
  "s3Key": "business-rules/financeiro.md",
  "pathPatterns": ["financ", "payment", "pagamento", "billing", "titulo", "..."]
}
```

Para adicionar um novo domínio:

1. Escreva o arquivo de regras em Markdown (ex.: `business-rules/<dominio>.md`).
2. Adicione uma entrada em `business-rules/registry.json` com `domain`,
   `s3Key` (path do arquivo) e `pathPatterns` (substrings testadas contra os
   arquivos do diff — case-insensitive).
3. Rode `bun test tests/business-rules.test.ts` para validar o registry.

## Variáveis de ambiente

Preencha em `.env` (nunca commitado — ver `.env.example`).

| Variável | Uso |
|---|---|
| `CODEX_CLIENT_ID` | Client ID OAuth do app Codex/ChatGPT |
| `GITHUB_TOKEN` | PAT usado pelo worker para ler diffs e escrever no PR |
| `CODEX_PROXY_URL` | URL do proxy local do Codex (dev) |
| `CODEX_REVIEW_MODEL` | Modelo usado no review (`gabi`) |
| `REVIEW_BILLING_MODE` | Modo de cobrança/quota do review |
| `REVIEW_GITHUB_WRITE` | Liga/desliga escrita real no GitHub (false = dry-run) |
| `RADAR_CONFIG_PATH` | Path do `radar.config.json` |
| `REVIEW_GRAPH_CONTEXT` | Liga contexto do grafo de código no review |
| `BUSINESS_RULES` | Liga/desliga injeção de `business-rules/registry.json` |
| `TICKET_CONTEXT` | Liga contexto da issue/task do Jira vinculada ao PR |
| `PORT` | Porta do servidor local |
| `WEBHOOK_SECRET` | Segredo HMAC do webhook do GitHub (Lambda) |
| `APP_ID` | ID do GitHub App (bot próprio, se configurado) |
| `APP_PRIVATE_KEY_B64` | Chave privada do GitHub App, base64 (Lambda) |
| `STATS_KEY` | Chave de acesso às rotas `/stats` e `/task-analyze` |
| `TASK_RADAR_MODEL` | Modelo LLM usado no rerank do Task Radar |
| `TASK_ANALYZE_MIN_CONFIDENCE` | Confiança mínima do rerank para aceitar candidatos sem fallback agêntico |
| `JIRA_BASE_URL` | URL do Jira (`https://<dominio>.atlassian.net`) |
| `JIRA_EMAIL` | E-mail da conta de serviço do Jira |
| `JIRA_TOKEN` | API token do Jira |
| `JIRA_PROJECT` | Chave do projeto Jira (ex.: `CE`) |
| `JIRA_PR_STATUSES` | Status de Jira considerados "em review" |
| `WINDOW_DAYS` | Janela (dias) usada em relatórios/benchmarks |
| `CONCURRENCY` | Concorrência dos scripts de análise em lote |

## Contribuindo

- Testes primeiro: `bun test` deve ficar verde antes de qualquer PR.
- Regras de negócio novas: ver seção acima, não hardcode paths no `radar/gabi`.
- Mudou o pipeline do Task Radar (`scripts/task-radar-v7/`)? Rode o benchmark
  (`benchmark-v7.ts`) antes/depois e compare Acc@5/MAP@10.
