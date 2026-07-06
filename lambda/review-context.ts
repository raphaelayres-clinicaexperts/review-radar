// Contexto cirúrgico pro reviewer: Gabi (src/reviewer/gabi.ts) e o gate 3 (src/radar/codex.ts)
// só enxergam o diff do PR — não sabem o que as funções chamadas de fato fazem. Aqui usamos o
// grafo de código do Task Radar v7 (v7-code-graph.json, adjacência arquivo→arquivos resolvida
// via `use`/FQCN do PHP — ver scripts/task-radar-v7/code-graph-core.ts) pra achar os vizinhos
// diretos (imports e importadores) dos arquivos alterados, rankear pelos que mais se conectam
// ao diff, e trazer só as assinaturas + corpos dos métodos públicos deles — nunca o arquivo
// inteiro.
//
// O grafo já é baixado do S3 e cacheado em /tmp por lambda/task-radar-artifacts.ts (mesmo
// artefato usado pelo Task Radar v7 pra retrieval). Reaproveitamos esse download aqui.
//
// Contrato: NUNCA lança. Qualquer falha (grafo indisponível, GitHub fora do ar, PR de um repo
// sem grafo, arquivo não encontrado) devolve "" e o review segue só com o diff, como hoje.
// Kill switch: REVIEW_GRAPH_CONTEXT=off desliga completamente (usado no dry-run comparativo).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PR } from "../src/radar/types.ts";
import { githubToken } from "./env.ts";
import { ensureTaskRadarArtifacts } from "./task-radar-artifacts.ts";

export const CONTEXT_HEADER = "### Contexto de código relacionado (não faz parte do diff)";
const MAX_TOTAL_BYTES = 12_000;
const MAX_RELATED_FILES = 6;
const MAX_BYTES_PER_FILE = 4_000; // teto por arquivo — evita 1 vizinho gigante consumir o budget todo

interface CodeGraph {
  commit: string;
  nodes: string[];
  edges: number[][];
  pagerank: number[];
}

interface LoadedGraph extends CodeGraph {
  nodeIndex: Map<string, number>;
  reverseEdges: number[][];
}

let graphPromise: Promise<LoadedGraph | null> | null = null;

function buildDerivedIndices(graph: CodeGraph): LoadedGraph {
  const nodeIndex = new Map<string, number>();
  graph.nodes.forEach((path, idx) => nodeIndex.set(path, idx));
  const reverseEdges: number[][] = Array.from({ length: graph.nodes.length }, () => []);
  graph.edges.forEach((targets, from) => {
    for (const to of targets) reverseEdges[to]?.push(from);
  });
  return { ...graph, nodeIndex, reverseEdges };
}

async function loadCodeGraph(): Promise<LoadedGraph | null> {
  if (!graphPromise) {
    graphPromise = (async () => {
      const dir = await ensureTaskRadarArtifacts();
      const raw = readFileSync(join(dir, "v7-code-graph.json"), "utf-8");
      const graph = JSON.parse(raw) as CodeGraph;
      return buildDerivedIndices(graph);
    })().catch((err) => {
      console.warn("[review-context] grafo indisponível:", String(err).slice(0, 150));
      graphPromise = null; // permite retry numa próxima invocação
      return null;
    });
  }
  return graphPromise;
}

export interface RelatedFile {
  path: string;
  connections: number;
}

// Vizinhos diretos (imports + importadores) dos arquivos alterados, rankeados por quantos
// arquivos do diff cada um toca (desempate: PageRank). Exclui os próprios arquivos do diff.
export function rankRelatedFiles(
  changedFiles: string[],
  graph: LoadedGraph,
  topN = MAX_RELATED_FILES
): RelatedFile[] {
  const changedIdx = new Set<number>();
  for (const filename of changedFiles) {
    const idx = graph.nodeIndex.get(filename);
    if (idx !== undefined) changedIdx.add(idx);
  }
  if (!changedIdx.size) return [];

  const connections = new Map<number, number>();
  const bump = (idx: number) => connections.set(idx, (connections.get(idx) ?? 0) + 1);

  for (const idx of changedIdx) {
    for (const to of graph.edges[idx] ?? []) {
      if (!changedIdx.has(to)) bump(to);
    }
    for (const from of graph.reverseEdges[idx] ?? []) {
      if (!changedIdx.has(from)) bump(from);
    }
  }

  return [...connections.entries()]
    .sort((a, b) => b[1] - a[1] || (graph.pagerank[b[0]] ?? 0) - (graph.pagerank[a[0]] ?? 0))
    .slice(0, topN)
    .map(([idx, count]) => ({ path: graph.nodes[idx]!, connections: count }));
}

function ghHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${githubToken()}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "codex-integration-review-context",
  };
}

// Cache em módulo, invalidado quando o sha do grafo muda (nova versão dos artefatos).
let cachedForCommit: string | null = null;
let contentCache = new Map<string, string | null>();

function cacheFor(commit: string): Map<string, string | null> {
  if (cachedForCommit !== commit) {
    cachedForCommit = commit;
    contentCache = new Map();
  }
  return contentCache;
}

async function fetchFileContent(
  owner: string,
  repo: string,
  path: string,
  cache: Map<string, string | null>
): Promise<string | null> {
  const key = `${owner}/${repo}:${path}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=main`, {
      headers: ghHeaders(),
    });
    if (!res.ok) {
      cache.set(key, null);
      return null;
    }
    const json = (await res.json()) as { content?: string; encoding?: string };
    if (!json.content || json.encoding !== "base64") {
      cache.set(key, null);
      return null;
    }
    const content = Buffer.from(json.content, "base64").toString("utf-8");
    cache.set(key, content);
    return content;
  } catch (err) {
    cache.set(key, null);
    return null;
  }
}

// Assinatura + corpo de cada `public function` do PHP, via casamento de chaves. Regex simples
// de propósito — não é um parser completo, é só pra dar contexto de comportamento pro reviewer.
const PUBLIC_METHOD_RE = /public\s+(?:static\s+)?function\s+\w+\s*\([^)]*\)\s*(?::\s*[?a-zA-Z0-9_\\|]+)?\s*\{/g;

function findMatchingBrace(content: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < content.length; i++) {
    if (content[i] === "{") depth++;
    else if (content[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function extractPublicMembers(content: string, maxBytes = MAX_BYTES_PER_FILE): string {
  const chunks: string[] = [];
  let used = 0;
  PUBLIC_METHOD_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while (used < maxBytes && (match = PUBLIC_METHOD_RE.exec(content))) {
    const braceOpenIdx = match.index + match[0].length - 1;
    const end = findMatchingBrace(content, braceOpenIdx);
    if (end === -1) {
      PUBLIC_METHOD_RE.lastIndex = match.index + match[0].length;
      continue;
    }
    const snippet = content.slice(match.index, end + 1).trim();
    const remaining = maxBytes - used;
    const piece = snippet.length > remaining ? `${snippet.slice(0, remaining)}\n/* ... */` : snippet;
    chunks.push(piece);
    used += piece.length;
    PUBLIC_METHOD_RE.lastIndex = end + 1;
  }
  return chunks.join("\n\n");
}

function contextDisabled(): boolean {
  return (process.env.REVIEW_GRAPH_CONTEXT || "").toLowerCase() === "off";
}

export async function buildRelatedContext(pr: PR): Promise<string> {
  if (contextDisabled()) return "";
  try {
    const graph = await loadCodeGraph();
    if (!graph) return "";

    const related = rankRelatedFiles(
      pr.files.map((f) => f.filename),
      graph
    );
    if (!related.length) return "";

    const cache = cacheFor(graph.commit);
    const parts: string[] = [];
    let budget = MAX_TOTAL_BYTES;

    for (const file of related) {
      if (budget <= 0) break;
      const content = await fetchFileContent(pr.owner, pr.repo, file.path, cache);
      if (!content) continue;
      const extracted = extractPublicMembers(content, Math.min(MAX_BYTES_PER_FILE, budget));
      if (!extracted) continue;
      parts.push(`**${file.path}**:\n${extracted}`);
      budget -= extracted.length;
    }

    if (!parts.length) return "";
    return `${CONTEXT_HEADER}\n${parts.join("\n\n")}`;
  } catch (err) {
    console.warn("[review-context] falhou:", String(err).slice(0, 150));
    return "";
  }
}

export function resetReviewContextCacheForTests(): void {
  graphPromise = null;
  cachedForCommit = null;
  contentCache = new Map();
}
