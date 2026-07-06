#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

AWS_REGION="${AWS_REGION:-us-east-1}"
TABLE_NAME="radar-mvp"
FUNCTION_NAME="radar-mvp"
ROLE_NAME="radar-mvp-lambda"
ROLE_POLICY_NAME="radar-mvp-lambda-policy"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "==> Verificando pré-requisitos"
command -v aws >/dev/null 2>&1 || { echo "ERRO: aws cli não encontrado no PATH" >&2; exit 1; }
command -v bun >/dev/null 2>&1 || { echo "ERRO: bun não encontrado no PATH" >&2; exit 1; }

if ! ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null); then
  echo "ERRO: credenciais AWS inválidas ou ausentes (aws sts get-caller-identity falhou)" >&2
  exit 1
fi
echo "Conta AWS: ${ACCOUNT_ID} | região: ${AWS_REGION}"

echo "==> Carregando variáveis de ambiente"
if [ -f .env ]; then
  while IFS='=' read -r key value; do
    case "$key" in
      GITHUB_TOKEN|WEBHOOK_SECRET|CODEX_CLIENT_ID|AWS_REGION|APP_ID|APP_PRIVATE_KEY_B64|STATS_KEY|JIRA_BASE_URL|JIRA_EMAIL|JIRA_TOKEN) export "$key=$value" ;;
    esac
  done < .env
  echo "Variáveis carregadas de .env"
fi

GITHUB_TOKEN="${GITHUB_TOKEN:-}"
WEBHOOK_SECRET="${WEBHOOK_SECRET:-}"
CODEX_CLIENT_ID="${CODEX_CLIENT_ID:-app_EMoamEEZ73f0CkXaXp7hrann}"
SELF_FUNCTION_NAME="${FUNCTION_NAME}"

if [ -z "$GITHUB_TOKEN" ]; then
  echo "AVISO: GITHUB_TOKEN vazio — usando placeholder. Defina depois com:" >&2
  echo "  aws lambda update-function-configuration --function-name ${FUNCTION_NAME} --region ${AWS_REGION} --environment \"Variables={...,GITHUB_TOKEN=<valor>}\"" >&2
  GITHUB_TOKEN="SET_ME_MANUALLY"
fi
if [ -z "$WEBHOOK_SECRET" ]; then
  echo "AVISO: WEBHOOK_SECRET vazio — usando placeholder. Gere um valor forte e configure depois." >&2
  WEBHOOK_SECRET="SET_ME_MANUALLY"
fi

echo "==> Build do artefato Lambda"
bash scripts/build.sh

if [ ! -f dist/function.zip ]; then
  echo "ERRO: dist/function.zip não foi gerado" >&2
  exit 1
fi

echo "==> DynamoDB: tabela ${TABLE_NAME}"
if aws dynamodb describe-table --table-name "$TABLE_NAME" --region "$AWS_REGION" >/dev/null 2>&1; then
  echo "Tabela ${TABLE_NAME} já existe"
else
  echo "Criando tabela ${TABLE_NAME}"
  aws dynamodb create-table \
    --table-name "$TABLE_NAME" \
    --attribute-definitions AttributeName=PK,AttributeType=S AttributeName=SK,AttributeType=S \
    --key-schema AttributeName=PK,KeyType=HASH AttributeName=SK,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST \
    --region "$AWS_REGION" >/dev/null
  aws dynamodb wait table-exists --table-name "$TABLE_NAME" --region "$AWS_REGION"
fi
TABLE_ARN=$(aws dynamodb describe-table --table-name "$TABLE_NAME" --region "$AWS_REGION" --query 'Table.TableArn' --output text)

FUNCTION_ARN="arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:function:${FUNCTION_NAME}"
LOG_GROUP_STREAMS_ARN="arn:aws:logs:${AWS_REGION}:${ACCOUNT_ID}:log-group:/aws/lambda/${FUNCTION_NAME}:*"
LOG_GROUP_CREATE_ARN="arn:aws:logs:${AWS_REGION}:${ACCOUNT_ID}:*"

echo "==> IAM: role ${ROLE_NAME}"
cat > "$TMP_DIR/trust-policy.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "lambda.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  echo "Role ${ROLE_NAME} já existe"
else
  echo "Criando role ${ROLE_NAME}"
  aws iam create-role \
    --role-name "$ROLE_NAME" \
    --assume-role-policy-document "file://$TMP_DIR/trust-policy.json" >/dev/null
fi
ROLE_ARN=$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)

cat > "$TMP_DIR/inline-policy.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DynamoAccess",
      "Effect": "Allow",
      "Action": ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"],
      "Resource": "${TABLE_ARN}"
    },
    {
      "Sid": "SelfInvoke",
      "Effect": "Allow",
      "Action": "lambda:InvokeFunction",
      "Resource": "${FUNCTION_ARN}"
    },
    {
      "Sid": "TaskRadarArtifactsReadWrite",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::clinicaexperts-insights-data/insights-portal/task-radar-v7/*"
    },
    {
      "Sid": "LogGroupCreate",
      "Effect": "Allow",
      "Action": "logs:CreateLogGroup",
      "Resource": "${LOG_GROUP_CREATE_ARN}"
    },
    {
      "Sid": "LogStreamWrite",
      "Effect": "Allow",
      "Action": ["logs:CreateLogStream", "logs:PutLogEvents"],
      "Resource": "${LOG_GROUP_STREAMS_ARN}"
    }
  ]
}
EOF

echo "Aplicando policy inline ${ROLE_POLICY_NAME}"
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "$ROLE_POLICY_NAME" \
  --policy-document "file://$TMP_DIR/inline-policy.json" >/dev/null

echo "==> Variáveis de ambiente da Lambda"
if [ -f github-app.json ]; then
  APP_ID=$(bun -e 'console.log(JSON.parse(require("fs").readFileSync("github-app.json","utf8")).id)')
  APP_PRIVATE_KEY_B64=$(bun -e 'console.log(Buffer.from(JSON.parse(require("fs").readFileSync("github-app.json","utf8")).pem).toString("base64"))')
  echo "GitHub App detectado (id ${APP_ID}) — bot próprio ativado"
fi
ENV_JSON_FILE="$TMP_DIR/env.json"
TABLE_NAME="$TABLE_NAME" \
GITHUB_TOKEN="$GITHUB_TOKEN" \
WEBHOOK_SECRET="$WEBHOOK_SECRET" \
SELF_FUNCTION_NAME="$SELF_FUNCTION_NAME" \
CODEX_CLIENT_ID="$CODEX_CLIENT_ID" \
APP_ID="${APP_ID:-}" \
APP_PRIVATE_KEY_B64="${APP_PRIVATE_KEY_B64:-}" \
STATS_KEY="${STATS_KEY:-}" \
JIRA_BASE_URL="${JIRA_BASE_URL:-}" \
JIRA_EMAIL="${JIRA_EMAIL:-}" \
JIRA_TOKEN="${JIRA_TOKEN:-}" \
bun -e '
const vars = {
  TABLE_NAME: process.env.TABLE_NAME,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,
  SELF_FUNCTION_NAME: process.env.SELF_FUNCTION_NAME,
  CODEX_CLIENT_ID: process.env.CODEX_CLIENT_ID,
  STORE: "dynamo",
};
if (process.env.APP_ID) vars.APP_ID = process.env.APP_ID;
if (process.env.APP_PRIVATE_KEY_B64) vars.APP_PRIVATE_KEY_B64 = process.env.APP_PRIVATE_KEY_B64;
if (process.env.STATS_KEY) vars.STATS_KEY = process.env.STATS_KEY;
if (process.env.JIRA_BASE_URL) vars.JIRA_BASE_URL = process.env.JIRA_BASE_URL;
if (process.env.JIRA_EMAIL) vars.JIRA_EMAIL = process.env.JIRA_EMAIL;
if (process.env.JIRA_TOKEN) vars.JIRA_TOKEN = process.env.JIRA_TOKEN;
process.stdout.write(JSON.stringify({ Variables: vars }));
' > "$ENV_JSON_FILE"

echo "==> Lambda: função ${FUNCTION_NAME}"
if aws lambda get-function --function-name "$FUNCTION_NAME" --region "$AWS_REGION" >/dev/null 2>&1; then
  echo "Função existe — atualizando código"
  aws lambda update-function-code \
    --function-name "$FUNCTION_NAME" \
    --zip-file fileb://dist/function.zip \
    --region "$AWS_REGION" >/dev/null
  aws lambda wait function-updated --function-name "$FUNCTION_NAME" --region "$AWS_REGION"

  echo "Atualizando configuração"
  aws lambda update-function-configuration \
    --function-name "$FUNCTION_NAME" \
    --runtime nodejs22.x \
    --handler index.handler \
    --timeout 900 \
    --memory-size 3008 \
    --role "$ROLE_ARN" \
    --environment "file://$ENV_JSON_FILE" \
    --region "$AWS_REGION" >/dev/null
  aws lambda wait function-updated --function-name "$FUNCTION_NAME" --region "$AWS_REGION"
else
  echo "Função não existe — criando"
  ATTEMPTS=0
  until aws lambda create-function \
    --function-name "$FUNCTION_NAME" \
    --runtime nodejs22.x \
    --handler index.handler \
    --role "$ROLE_ARN" \
    --timeout 900 \
    --memory-size 3008 \
    --zip-file fileb://dist/function.zip \
    --environment "file://$ENV_JSON_FILE" \
    --region "$AWS_REGION" >/dev/null 2>"$TMP_DIR/create-error.log"
  do
    ATTEMPTS=$((ATTEMPTS + 1))
    if [ "$ATTEMPTS" -ge 10 ] || ! grep -q "cannot be assumed by Lambda\|InvalidParameterValueException" "$TMP_DIR/create-error.log"; then
      echo "ERRO ao criar função (tentativa ${ATTEMPTS}):" >&2
      cat "$TMP_DIR/create-error.log" >&2
      exit 1
    fi
    echo "Role IAM ainda propagando, tentando de novo em 5s (tentativa ${ATTEMPTS}/10)"
    sleep 5
  done
  aws lambda wait function-active --function-name "$FUNCTION_NAME" --region "$AWS_REGION"
fi

echo "==> Function URL"
if ! aws lambda get-function-url-config --function-name "$FUNCTION_NAME" --region "$AWS_REGION" >/dev/null 2>&1; then
  echo "Criando function URL (auth NONE)"
  aws lambda create-function-url-config \
    --function-name "$FUNCTION_NAME" \
    --auth-type NONE \
    --region "$AWS_REGION" >/dev/null
else
  echo "Function URL já configurada"
fi

if ! aws lambda get-policy --function-name "$FUNCTION_NAME" --region "$AWS_REGION" 2>/dev/null | grep -q "FunctionURLAllowPublicAccess"; then
  echo "Concedendo lambda:InvokeFunctionUrl público"
  aws lambda add-permission \
    --function-name "$FUNCTION_NAME" \
    --statement-id FunctionURLAllowPublicAccess \
    --action lambda:InvokeFunctionUrl \
    --principal "*" \
    --function-url-auth-type NONE \
    --region "$AWS_REGION" >/dev/null
else
  echo "Permissão pública já concedida"
fi

FUNCTION_URL=$(aws lambda get-function-url-config --function-name "$FUNCTION_NAME" --region "$AWS_REGION" --query FunctionUrl --output text)

echo "==> EventBridge: agendamento diário do refresh-artifacts"
RULE_NAME="radar-mvp-refresh-artifacts-daily"
RULE_STATEMENT_ID="AllowEventBridgeRefreshArtifacts"

RULE_ARN=$(aws events put-rule \
  --name "$RULE_NAME" \
  --schedule-expression "cron(0 6 * * ? *)" \
  --state ENABLED \
  --description "Task Radar v7: regenera code-graph/co-change/task-index diariamente às 06:00 UTC" \
  --region "$AWS_REGION" \
  --query 'RuleArn' --output text)
echo "Rule ${RULE_NAME}: ${RULE_ARN}"

if ! aws lambda get-policy --function-name "$FUNCTION_NAME" --region "$AWS_REGION" 2>/dev/null | grep -q "$RULE_STATEMENT_ID"; then
  echo "Concedendo lambda:InvokeFunction para o EventBridge rule"
  aws lambda add-permission \
    --function-name "$FUNCTION_NAME" \
    --statement-id "$RULE_STATEMENT_ID" \
    --action lambda:InvokeFunction \
    --principal events.amazonaws.com \
    --source-arn "$RULE_ARN" \
    --region "$AWS_REGION" >/dev/null
else
  echo "Permissão do EventBridge já concedida"
fi

cat > "$TMP_DIR/targets.json" <<EOF
[
  {
    "Id": "radar-mvp-refresh-artifacts",
    "Arn": "${FUNCTION_ARN}",
    "Input": "{\"mode\":\"refresh-artifacts\"}"
  }
]
EOF
aws events put-targets \
  --rule "$RULE_NAME" \
  --targets "file://$TMP_DIR/targets.json" \
  --region "$AWS_REGION" >/dev/null
echo "Target configurado: invoca ${FUNCTION_NAME} com {\"mode\":\"refresh-artifacts\"} todo dia às 06:00 UTC"

echo ""
echo "================================================================"
echo "Deploy concluído"
echo "Function URL: ${FUNCTION_URL}"
echo ""
echo "Configure o webhook no GitHub (repo clinicaexperts_app):"
echo "  Settings > Webhooks > Add webhook"
echo "  Payload URL : ${FUNCTION_URL}"
echo "  Content type: application/json"
echo "  Secret      : o valor de WEBHOOK_SECRET (não exibido aqui)"
echo "  Events      : Pull requests, Issue comments"
echo "================================================================"

if [ "$GITHUB_TOKEN" = "SET_ME_MANUALLY" ] || [ "$WEBHOOK_SECRET" = "SET_ME_MANUALLY" ]; then
  echo ""
  echo "AVISO: existem variáveis com placeholder SET_ME_MANUALLY — atualize antes de usar em produção:" >&2
  echo "  aws lambda update-function-configuration --function-name ${FUNCTION_NAME} --region ${AWS_REGION} --environment \"Variables={TABLE_NAME=${TABLE_NAME},GITHUB_TOKEN=<token>,WEBHOOK_SECRET=<secret>,SELF_FUNCTION_NAME=${SELF_FUNCTION_NAME},CODEX_CLIENT_ID=${CODEX_CLIENT_ID}}\"" >&2
fi
