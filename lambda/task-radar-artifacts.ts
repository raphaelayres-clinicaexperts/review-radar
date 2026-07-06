// Task Radar v7 — os 4 artefatos (project-map.json, task-index.json, v7-cochange.json,
// v7-code-graph.json) são grandes (~2 MB somados) e não fazem parte do bundle da Lambda
// (dist/function.zip só contém dist/index.mjs — ver scripts/build.sh). Em produção eles são
// baixados do S3 (bucket clinicaexperts-insights-data) para /tmp na primeira invocação e
// cacheados a nível de módulo (a mesma Promise é reaproveitada por invocações subsequentes
// na mesma execution environment; os arquivos em /tmp também sobrevivem entre invocações
// warm, então um cold start seguinte na mesma env pula o download).
//
// scripts/task-radar-v7/retrieve.ts e rerank.ts leem TASK_RADAR_DATA_DIR (quando setado) no
// lugar dos caminhos relativos a import.meta.dir — setamos essa env var aqui após o download.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ARTIFACT_FILES = ["project-map.json", "task-index.json", "v7-cochange.json", "v7-code-graph.json"] as const;

export function bucket(): string {
  return process.env.TASK_RADAR_ARTIFACTS_BUCKET || "clinicaexperts-insights-data";
}

export function prefix(): string {
  const raw = process.env.TASK_RADAR_ARTIFACTS_PREFIX || "insights-portal/task-radar-v7/";
  return raw.endsWith("/") ? raw : `${raw}/`;
}

function localDir(): string {
  return process.env.TASK_RADAR_DATA_DIR || "/tmp/task-radar-v7-data";
}

async function downloadArtifact(
  client: import("@aws-sdk/client-s3").S3Client,
  name: string,
  dir: string
): Promise<void> {
  const dest = join(dir, name);
  if (existsSync(dest)) return;
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const res = await client.send(new GetObjectCommand({ Bucket: bucket(), Key: `${prefix()}${name}` }));
  if (!res.Body) throw new Error(`S3 GetObject sem body: ${prefix()}${name}`);
  const bytes = await res.Body.transformToByteArray();
  writeFileSync(dest, Buffer.from(bytes));
}

let cached: Promise<string> | null = null;

// Idempotente e memoizado: primeira chamada baixa os arquivos que faltarem, seta
// TASK_RADAR_DATA_DIR e retorna o diretório; chamadas seguintes (mesma execution
// environment) reaproveitam a mesma Promise sem tocar em rede ou disco.
export async function ensureTaskRadarArtifacts(): Promise<string> {
  if (!cached) {
    cached = (async () => {
      const dir = localDir();
      mkdirSync(dir, { recursive: true });
      const missing = ARTIFACT_FILES.filter((name) => !existsSync(join(dir, name)));
      if (missing.length > 0) {
        const { S3Client } = await import("@aws-sdk/client-s3");
        const client = new S3Client({});
        await Promise.all(missing.map((name) => downloadArtifact(client, name, dir)));
      }
      process.env.TASK_RADAR_DATA_DIR = dir;
      return dir;
    })().catch((err) => {
      cached = null; // permite retry numa próxima invocação em caso de falha transitória
      throw err;
    });
  }
  return cached;
}

export function resetTaskRadarArtifactsCacheForTests(): void {
  cached = null;
}
