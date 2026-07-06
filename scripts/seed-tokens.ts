#!/usr/bin/env bun

import { existsSync } from "node:fs";

const TABLE_NAME = process.env.TABLE_NAME ?? "radar-mvp";
const AWS_REGION = process.env.AWS_REGION ?? "us-east-1";
const TOKENS_SK = process.env.TOKENS_SK ?? "TOKENS#codex";
const TOKENS_PATH = "./tokens.json";

function fail(message: string): never {
  console.error(`ERRO: ${message}`);
  process.exit(1);
}

if (!existsSync(TOKENS_PATH)) {
  fail(`${TOKENS_PATH} não encontrado no diretório atual`);
}

const raw = await Bun.file(TOKENS_PATH).text();

let tokens: Record<string, unknown>;
try {
  tokens = JSON.parse(raw);
} catch {
  fail(`${TOKENS_PATH} não é um JSON válido`);
}

const requiredKeys = ["access_token", "id_token", "account_id", "expires_at"];
const missingKeys = requiredKeys.filter((key) => !(key in tokens));
if (missingKeys.length > 0) {
  fail(`tokens.json não tem os campos esperados: ${missingKeys.join(", ")}`);
}

function toAttributeValue(value: unknown): { S: string } | { N: string } {
  if (typeof value === "number") return { N: String(value) };
  return { S: String(value) };
}

const item: Record<string, unknown> = {
  PK: { S: "TOKENS#codex" },
  SK: { S: TOKENS_SK },
};
for (const [key, value] of Object.entries(tokens)) {
  item[key] = toAttributeValue(value);
}

console.log(`Gravando TOKENS#codex (SK=${TOKENS_SK}) na tabela ${TABLE_NAME} (${AWS_REGION})...`);

const proc = Bun.spawnSync(
  [
    "aws",
    "dynamodb",
    "put-item",
    "--table-name",
    TABLE_NAME,
    "--region",
    AWS_REGION,
    "--item",
    JSON.stringify(item),
  ],
  { stdout: "pipe", stderr: "pipe" },
);

if (proc.exitCode !== 0) {
  const stderr = proc.stderr.toString().slice(0, 500);
  fail(`falha ao gravar no DynamoDB (exit ${proc.exitCode}): ${stderr}`);
}

console.log(`OK: TOKENS#codex gravado em ${TABLE_NAME}.`);
