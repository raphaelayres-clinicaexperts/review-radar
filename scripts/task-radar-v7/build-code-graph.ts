// Task Radar v7 — grafo de código do repo Laravel (clinicaexperts_app).
//
// Nós: arquivos PHP sob os prefixos PSR-4 do composer.json (principalmente app/).
// Arestas: `use X\Y\Z;` (inclui `use X\Y\{A, B};`) e referências FQCN no corpo
// (`\App\Foo\Bar`, `App\Foo\Bar::class`, `new App\Foo\Bar(...)`) resolvidas via PSR-4.
//
// Não troca a branch local: lê tudo de `origin/main` via `git show`/`git archive` para um
// diretório temporário. A lógica pura (parsing PSR-4/use/FQCN + PageRank) mora em
// code-graph-core.ts, reaproveitada por lambda/refresh-artifacts.ts (que não tem git — lê de
// um tarball do GitHub em vez do checkout local).
//
// Uso: bun run scripts/task-radar-v7/build-code-graph.ts

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { buildCodeGraphFromFiles, type Psr4Map } from "./code-graph-core.ts";

const REPO_PATH = "/Users/raphaeldefalcoayres/projetos/clinicaexperts/clinicaexperts_app";
const REF = "origin/main";
const OUT_PATH = join(import.meta.dir, "v7-code-graph.json");

function git(args: string[]): string {
  return execFileSync("git", ["-C", REPO_PATH, ...args], {
    maxBuffer: 1024 * 1024 * 200,
  }).toString("utf-8");
}

function loadPsr4Map(): Psr4Map {
  const raw = git(["show", `${REF}:composer.json`]);
  const composer = JSON.parse(raw);
  const psr4: Psr4Map = { ...(composer.autoload?.["psr-4"] ?? {}) };
  return psr4;
}

function extractSnapshot(): { dir: string; roots: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "v7-code-graph-"));
  // Extrai apenas os diretórios que interessam ao PSR-4 (evita puxar o repo inteiro).
  const candidateRoots = ["app", "database/factories", "database/seeders", "scripts"];
  const existingRoots: string[] = [];
  for (const root of candidateRoots) {
    try {
      git(["cat-file", "-e", `${REF}:${root}`]);
      existingRoots.push(root);
    } catch {
      // diretório não existe no ref, ignora
    }
  }
  const archiveProc = execFileSync(
    "git",
    ["-C", REPO_PATH, "archive", REF, ...existingRoots],
    { maxBuffer: 1024 * 1024 * 500 }
  );
  const tarPath = join(dir, "snapshot.tar");
  writeFileSync(tarPath, archiveProc);
  execFileSync("tar", ["-x", "-f", tarPath, "-C", dir]);
  rmSync(tarPath);
  return { dir, roots: existingRoots };
}

function walkPhpFiles(rootDir: string): string[] {
  const results: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      const st = statSync(full);
      if (st.isDirectory()) stack.push(full);
      else if (entry.endsWith(".php")) results.push(full);
    }
  }
  return results;
}

async function main() {
  const startedAt = Date.now();
  console.log(`[build-code-graph] resolvendo commit de ${REF}...`);
  const commit = git(["rev-parse", REF]).trim();

  console.log("[build-code-graph] lendo composer.json (PSR-4)...");
  const psr4 = loadPsr4Map();
  console.log(`[build-code-graph] PSR-4 map: ${JSON.stringify(psr4)}`);

  console.log("[build-code-graph] extraindo snapshot via git archive (sem trocar branch)...");
  const { dir: snapshotDir, roots } = extractSnapshot();
  console.log(`[build-code-graph] raízes extraídas: ${roots.join(", ")}`);

  const allPhpFiles: string[] = [];
  for (const root of roots) {
    allPhpFiles.push(...walkPhpFiles(join(snapshotDir, root)));
  }
  console.log(`[build-code-graph] ${allPhpFiles.length} arquivos .php encontrados`);

  const files = new Map<string, string>();
  for (const absPath of allPhpFiles) {
    const relPath = relative(snapshotDir, absPath);
    files.set(relPath, readFileSync(absPath, "utf-8"));
  }

  console.log(`[build-code-graph] rodando PageRank...`);
  const graph = buildCodeGraphFromFiles(files, psr4);
  console.log(
    `[build-code-graph] ${graph.edgeCount} arestas resolvidas de ${graph.totalRefs} referências (${graph.unresolvedCount} não resolvidas: libs externas, traits sem namespace, etc.)`
  );

  const output = {
    generatedAt: new Date().toISOString(),
    commit,
    repoPath: REPO_PATH,
    ref: REF,
    psr4,
    nodeCount: graph.nodeCount,
    edgeCount: graph.edgeCount,
    nodes: graph.nodes,
    edges: graph.edges,
    pagerank: graph.pagerank,
    buildMs: Date.now() - startedAt,
  };

  writeFileSync(OUT_PATH, JSON.stringify(output));
  console.log(`[build-code-graph] salvo em ${OUT_PATH} (${(JSON.stringify(output).length / 1024).toFixed(1)} KB)`);
  console.log(`[build-code-graph] tempo total: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

  rmSync(snapshotDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
