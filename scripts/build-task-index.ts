import { writeFileSync } from "node:fs";
import { isGeneratedFile } from "../lambda/github-pr.ts";
import { extractJiraKey } from "../lambda/types.ts";
import type { TaskIndexEntry, TaskIndexFile } from "../lambda/types.ts";

const GH = "https://api.github.com";
const REPO_OWNER = "clinicaexperts";
const REPO_NAME = "clinicaexperts_app";
const MAX_PRS = 500;
const MAX_RATE_LIMIT_RETRIES = 5;

interface RawPull {
  number: number;
  title: string;
  head: { ref: string };
  merged_at: string | null;
}

interface RawFile {
  filename: string;
  additions: number;
  deletions: number;
}

interface CliArgs {
  out: string;
  dynamo: boolean;
}

function githubHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN ausente — configure no .env e rode da raiz do projeto");
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "codex-integration-task-index",
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function ghJson<T>(path: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${GH}${path}`, { headers: githubHeaders() });
    if ((res.status === 403 || res.status === 429) && attempt < MAX_RATE_LIMIT_RETRIES) {
      const reset = Number(res.headers.get("x-ratelimit-reset") ?? 0) * 1000;
      const waitMs = Math.min(Math.max(2000, reset - Date.now() + 1000), 30000);
      console.warn(`[task-index] rate limit — aguardando ${Math.round(waitMs / 1000)}s`);
      await sleep(waitMs);
      continue;
    }
    if (!res.ok) {
      throw new Error(`GitHub ${path} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    return res.json() as Promise<T>;
  }
}

async function fetchClosedPulls(owner: string, repo: string, limit: number): Promise<RawPull[]> {
  const out: RawPull[] = [];
  for (let page = 1; out.length < limit; page++) {
    const items = await ghJson<RawPull[]>(
      `/repos/${owner}/${repo}/pulls?state=closed&per_page=100&page=${page}&sort=created&direction=desc`
    );
    if (!items.length) break;
    out.push(...items);
    if (items.length < 100) break;
  }
  return out.slice(0, limit);
}

async function fetchPrFiles(owner: string, repo: string, number: number): Promise<TaskIndexFile[]> {
  const out: TaskIndexFile[] = [];
  for (let page = 1; ; page++) {
    const items = await ghJson<RawFile[]>(
      `/repos/${owner}/${repo}/pulls/${number}/files?per_page=100&page=${page}`
    );
    for (const item of items) {
      if (isGeneratedFile(item.filename)) continue;
      out.push({ f: item.filename, add: item.additions, del: item.deletions });
    }
    if (items.length < 100) break;
  }
  return out;
}

async function buildItem(owner: string, repo: string, pull: RawPull): Promise<TaskIndexEntry> {
  const files = await fetchPrFiles(owner, repo, pull.number);
  return {
    key: extractJiraKey(pull.head.ref, pull.title),
    pr: pull.number,
    title: pull.title,
    mergedAt: pull.merged_at as string,
    branch: pull.head.ref,
    files,
  };
}

async function writeToDynamo(items: TaskIndexEntry[]): Promise<void> {
  const { DynamoDBClient, PutItemCommand } = await import("@aws-sdk/client-dynamodb");
  const client = new DynamoDBClient({});
  const table = process.env.TABLE_NAME ?? "radar-mvp";
  for (const item of items) {
    await client.send(
      new PutItemCommand({
        TableName: table,
        Item: {
          PK: { S: "TASKIDX" },
          SK: { S: `${item.mergedAt}#${item.pr}` },
          data: { S: JSON.stringify(item) },
        },
      })
    );
  }
}

function parseArgs(argv: string[]): CliArgs {
  let out = "task-index.json";
  let dynamo = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out = argv[++i] ?? out;
    if (argv[i] === "--dynamo") dynamo = true;
  }
  return { out, dynamo };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();

  console.log(`[task-index] buscando últimos ${MAX_PRS} PRs fechados de ${REPO_OWNER}/${REPO_NAME}...`);
  const pulls = await fetchClosedPulls(REPO_OWNER, REPO_NAME, MAX_PRS);
  const mergedPulls = pulls.filter((p): p is RawPull & { merged_at: string } => p.merged_at != null);
  console.log(`[task-index] ${pulls.length} PRs fechados carregados, ${mergedPulls.length} merged`);

  const items: TaskIndexEntry[] = [];
  for (const [index, pull] of mergedPulls.entries()) {
    items.push(await buildItem(REPO_OWNER, REPO_NAME, pull));
    if ((index + 1) % 25 === 0 || index + 1 === mergedPulls.length) {
      console.log(`[task-index] arquivos processados: ${index + 1}/${mergedPulls.length}`);
    }
  }

  const json = JSON.stringify(items, null, 2);
  writeFileSync(args.out, json);

  if (args.dynamo) {
    console.log("[task-index] gravando itens na tabela DynamoDB radar-mvp...");
    await writeToDynamo(items);
  }

  const withKey = items.filter((item) => item.key !== null).length;
  const jiraPct = items.length ? ((withKey / items.length) * 100).toFixed(1) : "0.0";
  const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(1);
  const sizeKb = (Buffer.byteLength(json) / 1024).toFixed(1);

  console.log("[task-index] concluído");
  console.log(`[task-index] total PRs fechados escaneados: ${pulls.length}`);
  console.log(`[task-index] total PRs merged indexados: ${items.length}`);
  console.log(`[task-index] com chave Jira: ${withKey} (${jiraPct}%)`);
  console.log(`[task-index] arquivo de saída: ${args.out} (${sizeKb} KB)`);
  console.log(`[task-index] tempo total: ${elapsedS}s`);
}

main().catch((err) => {
  console.error("[task-index] falhou:", err);
  process.exit(1);
});
