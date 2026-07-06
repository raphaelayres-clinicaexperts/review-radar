// Task Radar v7 — núcleo puro do grafo de código PHP (PSR-4 + PageRank).
//
// Extraído de build-code-graph.ts pra ser reutilizável por dois consumidores com fontes de
// arquivo diferentes:
//   - build-code-graph.ts (CLI): lê arquivos via `git show`/`git archive` (precisa de git local).
//   - lambda/refresh-artifacts.ts: lê arquivos extraídos de um tarball do GitHub (sem git).
//
// Não faz I/O — recebe um Map<caminho relativo, conteúdo> já carregado em memória.

export interface Psr4Map {
  [namespacePrefix: string]: string; // e.g. "App\\" -> "app/"
}

export const PAGERANK_ITERATIONS = 20;
export const DAMPING = 0.85;

// Ordena prefixos PSR-4 do mais específico (mais longo) pro mais genérico, pra resolver
// namespaces aninhados corretamente (ex: "Database\\Factories\\" antes de "Database\\").
export function sortedPsr4Entries(psr4: Psr4Map): Array<[string, string]> {
  return Object.entries(psr4).sort((a, b) => b[0].length - a[0].length);
}

export function resolveFqcnToPath(fqcn: string, psr4Entries: Array<[string, string]>): string | null {
  const clean = fqcn.replace(/^\\/, "");
  for (const [prefix, baseDir] of psr4Entries) {
    const normalizedPrefix = prefix.endsWith("\\") ? prefix : `${prefix}\\`;
    if (clean.startsWith(normalizedPrefix)) {
      const remainder = clean.slice(normalizedPrefix.length);
      if (!remainder) return null;
      const normalizedBase = baseDir.endsWith("/") ? baseDir : `${baseDir}/`;
      return `${normalizedBase}${remainder.replace(/\\/g, "/")}.php`;
    }
  }
  return null;
}

const USE_LINE_RE = /^use\s+(?!function\s|const\s)([^;]+);/gm;
const GROUP_USE_RE = /^([A-Za-z0-9_\\]+)\\\{([^}]+)\}$/;
const FQCN_REF_RE = /\\?App\\[A-Za-z0-9_]+(?:\\[A-Za-z0-9_]+)+/g;

export function extractUseTargets(content: string): string[] {
  const targets: string[] = [];
  let match: RegExpExecArray | null;
  USE_LINE_RE.lastIndex = 0;
  while ((match = USE_LINE_RE.exec(content))) {
    const body = match[1]!.trim();
    const groupMatch = GROUP_USE_RE.exec(body);
    if (groupMatch) {
      const prefix = groupMatch[1]!;
      const members = groupMatch[2]!.split(",").map((m) => m.trim()).filter(Boolean);
      for (const member of members) {
        const withoutAlias = member.split(/\s+as\s+/i)[0]!.trim();
        if (withoutAlias) targets.push(`${prefix}\\${withoutAlias}`);
      }
    } else {
      const withoutAlias = body.split(/\s+as\s+/i)[0]!.trim();
      if (withoutAlias) targets.push(withoutAlias);
    }
  }
  return targets;
}

export function extractBodyReferences(content: string): string[] {
  const refs = content.match(FQCN_REF_RE) ?? [];
  return refs.map((r) => r.replace(/^\\/, ""));
}

export interface PageRankResult {
  scores: number[];
}

export function computePageRank(nodeCount: number, outEdges: number[][], iterations: number): PageRankResult {
  if (nodeCount === 0) return { scores: [] };
  let ranks = new Array(nodeCount).fill(1 / nodeCount);
  const inEdges: number[][] = Array.from({ length: nodeCount }, () => []);
  for (let from = 0; from < nodeCount; from++) {
    for (const to of outEdges[from]!) inEdges[to]!.push(from);
  }
  const outDegree = outEdges.map((e) => e.length);

  for (let iter = 0; iter < iterations; iter++) {
    let danglingMass = 0;
    for (let i = 0; i < nodeCount; i++) {
      if (outDegree[i] === 0) danglingMass += ranks[i]!;
    }
    const base = (1 - DAMPING) / nodeCount + (DAMPING * danglingMass) / nodeCount;
    const next = new Array(nodeCount).fill(base);
    for (let i = 0; i < nodeCount; i++) {
      for (const from of inEdges[i]!) {
        next[i] += (DAMPING * ranks[from]!) / outDegree[from]!;
      }
    }
    ranks = next;
  }
  return { scores: ranks };
}

export interface CodeGraphCore {
  nodeCount: number;
  edgeCount: number;
  unresolvedCount: number;
  totalRefs: number;
  nodes: string[];
  edges: number[][];
  pagerank: number[];
}

// `files`: caminho relativo (a partir da raiz do repo, ex: "app/Models/User.php") -> conteúdo.
// Só precisa conter os arquivos .php de interesse (o chamador filtra as raízes PSR-4 relevantes).
export function buildCodeGraphFromFiles(files: Map<string, string>, psr4: Psr4Map): CodeGraphCore {
  const psr4Entries = sortedPsr4Entries(psr4);
  const relativePaths = [...files.keys()].sort();
  const nodeIndex = new Map<string, number>();
  relativePaths.forEach((p, i) => nodeIndex.set(p, i));

  const outEdges: number[][] = Array.from({ length: relativePaths.length }, () => []);
  let unresolvedCount = 0;
  let totalRefs = 0;

  for (let i = 0; i < relativePaths.length; i++) {
    const relPath = relativePaths[i]!;
    const content = files.get(relPath)!;

    const targets = new Set<string>();
    for (const t of extractUseTargets(content)) targets.add(t);
    for (const t of extractBodyReferences(content)) targets.add(t);

    const edgeSet = new Set<number>();
    for (const fqcn of targets) {
      totalRefs++;
      const resolvedPath = resolveFqcnToPath(fqcn, psr4Entries);
      if (!resolvedPath) {
        unresolvedCount++;
        continue;
      }
      const targetIdx = nodeIndex.get(resolvedPath);
      if (targetIdx === undefined) {
        unresolvedCount++;
        continue;
      }
      if (targetIdx !== i) edgeSet.add(targetIdx);
    }
    outEdges[i] = [...edgeSet];
  }

  const edgeCount = outEdges.reduce((sum, e) => sum + e.length, 0);
  const { scores } = computePageRank(relativePaths.length, outEdges, PAGERANK_ITERATIONS);

  return {
    nodeCount: relativePaths.length,
    edgeCount,
    unresolvedCount,
    totalRefs,
    nodes: relativePaths,
    edges: outEdges,
    pagerank: scores,
  };
}
