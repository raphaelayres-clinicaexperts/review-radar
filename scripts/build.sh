#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Verificando pré-requisitos"
command -v bun >/dev/null 2>&1 || { echo "ERRO: bun não encontrado no PATH" >&2; exit 1; }
command -v zip >/dev/null 2>&1 || { echo "ERRO: zip não encontrado no PATH" >&2; exit 1; }

if [ ! -f lambda/handler.ts ]; then
  echo "ERRO: lambda/handler.ts não encontrado (ainda não foi criado)" >&2
  exit 1
fi

echo "==> Limpando dist/"
rm -rf dist
mkdir -p dist

echo "==> Compilando lambda/handler.ts (bun build --target=node)"
bun build lambda/handler.ts \
  --target=node \
  --outdir=dist \
  --external "@aws-sdk/*"

ENTRY_JS="dist/handler.js"
if [ ! -f "$ENTRY_JS" ]; then
  ENTRY_JS=$(find dist -maxdepth 1 -name "*.js" | head -n1)
fi
if [ -z "$ENTRY_JS" ] || [ ! -f "$ENTRY_JS" ]; then
  echo "ERRO: build não gerou nenhum arquivo .js em dist/" >&2
  exit 1
fi

echo "==> Empacotando entrypoint como dist/index.mjs (runtime nodejs22.x)"
mv "$ENTRY_JS" dist/index.mjs

if ! grep -q "handler" dist/index.mjs; then
  echo "AVISO: dist/index.mjs não parece exportar 'handler' — verifique 'export const handler' em lambda/handler.ts" >&2
fi

echo "==> Gerando dist/function.zip"
rm -f dist/function.zip
(cd dist && zip -q -r function.zip . -x "function.zip")

echo "==> Build concluído: dist/function.zip"
ls -lh dist/function.zip
