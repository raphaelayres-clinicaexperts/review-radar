// Mode "refresh-artifacts": regenera os artefatos do Task Radar v7 (code-graph + co-change +
// task-index consolidado) sem depender de `git` (a Lambda Node22 não tem git no runtime).
//
// Fontes:
//   - code-graph: tarball de `main` do clinicaexperts_app via GitHub API (github-tarball.ts),
//     parseado com o núcleo puro de code-graph-core.ts (mesma lógica do CLI local).
//   - co-change: TaskIndexEntry gravados no Dynamo (PK=TASKIDX) — não usa task-index.json como
//     fonte pra não depender do artefato anterior.
//   - task-index.json: o mesmo dump consolidado do Dynamo, re-publicado no S3.
//
// project-map.json fica de fora (depende do Codex) — continua manual. Reaproveitamos o
// project-map.json já existente em S3 (via ensureTaskRadarArtifacts) só como insumo pro
// cálculo de co-change.

import { join } from "node:path";
import { appAuthConfigured, installationToken } from "./github-app-auth.ts";
import { fetchRepoTarball, getCommitSha, extractTarGz } from "./github-tarball.ts";
import { ensureTaskRadarArtifacts, bucket, prefix } from "./task-radar-artifacts.ts";
import { createStore } from "./store.ts";
import { storeMode } from "./env.ts";
import { buildCodeGraphFromFiles, type Psr4Map } from "../scripts/task-radar-v7/code-graph-core.ts";
import { derivePrModules, buildCochangePairs } from "../scripts/task-radar-v7/build-cochange.ts";
import { loadProjectMap } from "../scripts/task-radar/project-map.ts";

const OWNER = "clinicaexperts";
const REPO = "clinicaexperts_app";
const REF = "main";
const CANDIDATE_ROOTS = ["app", "database/factories", "database/seeders", "scripts"];

function keepPath(relPath: string): boolean {
  if (relPath === "composer.json") return true;
  if (!relPath.endsWith(".php")) return false;
  return CANDIDATE_ROOTS.some((root) => relPath === root || relPath.startsWith(`${root}/`));
}

async function resolveGithubToken(): Promise<string> {
  if (appAuthConfigured()) return installationToken(OWNER, REPO);
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("refresh-artifacts: GITHUB_TOKEN/App auth ausente");
  return token;
}

export interface RefreshArtifactsStats {
  tarballBytes: number;
  extractedFileCount: number;
  codeGraph: { nodeCount: number; edgeCount: number; bytes: number; ms: number };
  cochange: { pairCount: number; prCount: number; bytes: number; ms: number };
  taskIndex: { entryCount: number; bytes: number; ms: number };
  totalMs: number;
}

async function uploadArtifact(
  client: import("@aws-sdk/client-s3").S3Client,
  name: string,
  body: string
): Promise<{ bytes: number; ms: number }> {
  const startedAt = Date.now();
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  await client.send(
    new PutObjectCommand({ Bucket: bucket(), Key: `${prefix()}${name}`, Body: body, ContentType: "application/json" })
  );
  const ms = Date.now() - startedAt;
  console.log(`[refresh-artifacts] upload ${name}: ${(Buffer.byteLength(body) / 1024).toFixed(1)} KB em ${ms}ms`);
  return { bytes: Buffer.byteLength(body), ms };
}

export async function refreshArtifacts(): Promise<RefreshArtifactsStats> {
  const totalStart = Date.now();
  console.log("[refresh-artifacts] iniciando...");

  const token = await resolveGithubToken();

  const tarballStart = Date.now();
  const [tarball, commit] = await Promise.all([
    fetchRepoTarball(OWNER, REPO, REF, token),
    getCommitSha(OWNER, REPO, REF, token),
  ]);
  console.log(
    `[refresh-artifacts] tarball ${OWNER}/${REPO}@${commit.slice(0, 7)}: ${(tarball.length / 1024 / 1024).toFixed(1)} MB em ${Date.now() - tarballStart}ms`
  );

  const extractStart = Date.now();
  const files = extractTarGz(tarball, keepPath);
  console.log(`[refresh-artifacts] extraídos ${files.size} arquivos relevantes em ${Date.now() - extractStart}ms`);

  const composerRaw = files.get("composer.json");
  if (!composerRaw) throw new Error("refresh-artifacts: composer.json não encontrado no tarball");
  const composer = JSON.parse(composerRaw.toString("utf-8")) as { autoload?: { "psr-4"?: Psr4Map } };
  const psr4: Psr4Map = composer.autoload?.["psr-4"] ?? {};

  const phpFiles = new Map<string, string>();
  for (const [path, buf] of files) {
    if (path.endsWith(".php")) phpFiles.set(path, buf.toString("utf-8"));
  }

  const graphStart = Date.now();
  const graph = buildCodeGraphFromFiles(phpFiles, psr4);
  const codeGraphJson = JSON.stringify({
    generatedAt: new Date().toISOString(),
    commit,
    repoPath: `${OWNER}/${REPO}`,
    ref: REF,
    psr4,
    nodeCount: graph.nodeCount,
    edgeCount: graph.edgeCount,
    nodes: graph.nodes,
    edges: graph.edges,
    pagerank: graph.pagerank,
    buildMs: Date.now() - graphStart,
  });
  console.log(
    `[refresh-artifacts] code-graph: ${graph.nodeCount} nós, ${graph.edgeCount} arestas (${graph.unresolvedCount}/${graph.totalRefs} refs não resolvidas) em ${Date.now() - graphStart}ms`
  );

  const store = createStore(storeMode());
  const taskIndexStart = Date.now();
  const taskIndexEntries = await store.listTaskIndexEntries();
  const taskIndexJson = JSON.stringify(taskIndexEntries, null, 2);
  console.log(`[refresh-artifacts] task-index: ${taskIndexEntries.length} entradas (Dynamo) em ${Date.now() - taskIndexStart}ms`);

  const dataDir = await ensureTaskRadarArtifacts();
  const projectMap = loadProjectMap(join(dataDir, "project-map.json"));

  const cochangeStart = Date.now();
  const prModules = derivePrModules(taskIndexEntries, projectMap.modules);
  const cochangeIndex = buildCochangePairs(prModules);
  const cochangeJson = JSON.stringify({
    generatedAt: new Date().toISOString(),
    prCount: taskIndexEntries.length,
    moduleCount: projectMap.modules.length,
    prModules,
    ...cochangeIndex,
    buildMs: Date.now() - cochangeStart,
  });
  console.log(`[refresh-artifacts] cochange: ${cochangeIndex.pairs.length} pares em ${Date.now() - cochangeStart}ms`);

  const { S3Client } = await import("@aws-sdk/client-s3");
  const client = new S3Client({});

  const codeGraphUpload = await uploadArtifact(client, "v7-code-graph.json", codeGraphJson);
  const cochangeUpload = await uploadArtifact(client, "v7-cochange.json", cochangeJson);
  const taskIndexUpload = await uploadArtifact(client, "task-index.json", taskIndexJson);

  const stats: RefreshArtifactsStats = {
    tarballBytes: tarball.length,
    extractedFileCount: files.size,
    codeGraph: { nodeCount: graph.nodeCount, edgeCount: graph.edgeCount, bytes: codeGraphUpload.bytes, ms: codeGraphUpload.ms },
    cochange: { pairCount: cochangeIndex.pairs.length, prCount: taskIndexEntries.length, bytes: cochangeUpload.bytes, ms: cochangeUpload.ms },
    taskIndex: { entryCount: taskIndexEntries.length, bytes: taskIndexUpload.bytes, ms: taskIndexUpload.ms },
    totalMs: Date.now() - totalStart,
  };
  console.log(`[refresh-artifacts] concluído em ${stats.totalMs}ms`, JSON.stringify(stats));
  return stats;
}
