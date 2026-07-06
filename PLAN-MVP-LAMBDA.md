# MVP: RADAR/Gabi em Lambda — review automático de PRs (clinicaexperts_app)

## Objetivo
A cada PR aberto/atualizado no repo `clinicaexperts_app` (e comando `@radar reavaliar` em comentário), rodar o pipeline RADAR (classificação) + Gabi (review) e:
1. Editar o **body do PR** appendando a avaliação entre marcadores `<!-- radar:start -->` / `<!-- radar:end -->` (substituir só esse trecho; NUNCA tocar no resto — Greptile também edita o body).
2. Postar/atualizar **1 comentário** com pontos de melhoria (marcador `<!-- radar:comment -->` — atualizar o existente, nunca empilhar).

## Arquitetura
- **1 Lambda, 2 modos** (Node 22, zip via `bun build --target=node`, memória 1024MB, timeout 900s):
  - `webhook`: Function URL recebe webhook GitHub → valida HMAC (`X-Hub-Signature-256`) → filtra evento → auto-invoca async (`InvocationType: Event`, payload `{mode:"worker", ...}`) → 200 imediato.
  - `worker`: busca diff do PR (GitHub API), roda radar + gabi, escreve body + comentário, salva resultado no Dynamo.
- **DynamoDB single-table** `radar-mvp` (on-demand, PK/SK string):
  - `TOKENS#codex` → tokens OAuth (substitui `tokens.json` em disco; worker faz refresh e persiste de volta)
  - `REVIEW#<repo>#<pr>` → último review (usado no reavaliar pra avaliar delta: "corrigiu X, falta Y")
  - `DEDUP#<repo>#<pr>#<sha>` → conditional write (attribute_not_exists) pra não rodar 2× o mesmo SHA (redelivery de webhook). `@radar reavaliar` ignora dedup.
- **Codex direto**: worker chama `chatgpt.com/backend-api/codex/responses` direto via módulos existentes do server — ELIMINAR o self-call `http://localhost:3456` (`src/reviewer/codex-proxy-client.ts`). Reusar a lógica de proxy/auth que já existe em `src/` (o server já sabe montar essas chamadas).
- **GitHub auth**: PAT via env `GITHUB_TOKEN`. Webhook secret via env `WEBHOOK_SECRET`.

## Regras do worker
- Ignorar: PRs draft, autores bot (`[bot]` no login: dependabot, greptile, renovate...), comentários do próprio bot, PRs com label `skip-radar`.
- `issue_comment`: só reage se body contém `@radar reavaliar` e o issue é PR.
- Edição do body: fetch body imediatamente antes do PATCH; substituir só entre marcadores (append no fim se não existirem); se falhar por conflito, re-fetch e retry 1×.
- Diff: ignorar lockfiles/arquivos gerados; cap de tamanho (ex: 100KB de diff) — se estourar, avisar no comentário que o review foi parcial.
- Erros (cota esgotada, API caiu): comentar falha resumida no PR, nunca falhar silenciosamente. Não vazar stack trace.
- Textos no PR em pt-BR.

## Estrutura de arquivos (novos — NÃO modificar src/server.ts)
```
lambda/
  handler.ts      # export handler; roteia webhook|worker
  worker.ts       # pipeline: diff → radar → gabi → publica no PR
  github-pr.ts    # patch body com marcadores, upsert comentário, get diff
  store.ts        # interface Store: Dynamo (prod) | filesystem (local, reusa tokens.json)
  local.ts        # teste local: `bun lambda/local.ts --pr <owner/repo#123>` roda worker com STORE=fs, sem AWS
scripts/
  deploy.sh       # idempotente: tabela + IAM role + lambda + function URL; imprime URL p/ webhook
  seed-tokens.ts  # lê ./tokens.json → put no Dynamo
  build.sh        # bun build lambda/handler.ts --target=node --outdir=dist + zip
```

## Env vars da Lambda
`TABLE_NAME`, `GITHUB_TOKEN`, `WEBHOOK_SECRET`, `SELF_FUNCTION_NAME` (self-invoke), `CODEX_CLIENT_ID` (default atual de `src/config.ts`).

## Teste local (obrigatório funcionar)
`bun lambda/local.ts --pr <ref>` → roda worker inteiro contra PR real usando tokens.json local e GITHUB_TOKEN do .env, imprime o que escreveria (flag `--dry-run`) ou escreve de verdade.

## Fases
1. **Agente A**: código `lambda/` (com teste local funcionando via dry-run em mock).
2. **Agente B** (paralelo): `scripts/` (deploy idempotente via AWS CLI + seed + build).
3. Deploy + seed tokens (acesso AWS guiado do Raphael).
4. Webhook no repo (acesso GitHub) + PR de teste real.

## IAM (mínimo)
Role da Lambda: `dynamodb:GetItem/PutItem/UpdateItem` na tabela, `lambda:InvokeFunction` em si mesma, logs CloudWatch.
