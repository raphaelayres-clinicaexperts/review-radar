#!/usr/bin/env bun

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FsStore } from "../lambda/store.ts";
import { directChatCompletion } from "../lambda/codex-client.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(SCRIPT_DIR, "..");

const REPO_PATH =
  process.env.PROJECT_MAP_REPO ??
  "/Users/raphaeldefalcoayres/projetos/clinicaexperts/clinicaexperts_app";

const OUTPUT_JSON = join(PROJECT_ROOT, "project-map.json");
const OUTPUT_MD = join(PROJECT_ROOT, "project-map.md");

const MAX_AI_CALLS = 15;
const MAX_TOTAL_TOKENS = 120_000;
const MIN_BATCH_SIZE = 10;
const MIN_SPLIT_MODULE_SIZE = 8;
const SMALL_DIR_SINGLE_MODULE_THRESHOLD = 25;
const MAX_MD_BYTES = 50_000;

const RELEVANT_TOP_DIRS = ["app", "packages", "database", "routes", "config"];

interface ClassInfo {
  file: string;
  namespace: string | null;
  className: string;
  methods: string[];
}

interface ModuleMechanical {
  name: string;
  path: string;
  filePaths: string[];
  classInfos: ClassInfo[];
}

interface ModuleOutput {
  name: string;
  path: string;
  files: number;
  classes: string[];
  summary: string;
}

interface ProjectMap {
  generatedAt: string;
  commit: string;
  modules: ModuleOutput[];
}

function fail(message: string): never {
  console.error(`ERRO: ${message}`);
  process.exit(1);
}

function runGit(args: string[]): string {
  const proc = Bun.spawnSync(["git", "-C", REPO_PATH, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    const stderr = proc.stderr.toString().slice(0, 2000);
    fail(`git ${args.join(" ")} falhou (exit ${proc.exitCode}): ${stderr}`);
  }
  return proc.stdout.toString();
}

function fetchOriginMain(): void {
  console.log(`[map] git fetch origin main em ${REPO_PATH}...`);
  runGit(["fetch", "origin", "main"]);
}

function getCommitSha(): string {
  return runGit(["rev-parse", "origin/main"]).trim();
}

function listTree(): string[] {
  const raw = runGit(["ls-tree", "-r", "--name-only", "origin/main"]);
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function diffChangedFiles(sinceSha: string): string[] {
  const raw = runGit(["diff", "--name-only", sinceSha, "origin/main"]);
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

async function batchCatFile(paths: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (paths.length === 0) return result;

  const proc = Bun.spawn(["git", "-C", REPO_PATH, "cat-file", "--batch"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const input = paths.map((p) => `origin/main:${p}`).join("\n") + "\n";
  proc.stdin.write(input);
  await proc.stdin.end();

  const stdoutBuf = Buffer.from(await new Response(proc.stdout).arrayBuffer());
  await proc.exited;

  let offset = 0;
  let idx = 0;
  while (offset < stdoutBuf.length && idx < paths.length) {
    const nlIndex = stdoutBuf.indexOf(0x0a, offset);
    if (nlIndex === -1) break;
    const header = stdoutBuf.toString("utf-8", offset, nlIndex);
    offset = nlIndex + 1;
    const path = paths[idx];
    idx++;

    if (header.endsWith("missing")) continue;

    const parts = header.split(" ");
    const size = Number(parts[2]);
    if (!Number.isFinite(size)) continue;

    const content = stdoutBuf.toString("utf-8", offset, offset + size);
    result.set(path, content);
    offset += size + 1;
  }

  return result;
}

function extractPhpInfo(
  file: string,
  content: string
): ClassInfo | null {
  const namespaceMatch = content.match(/^namespace\s+([^;]+);/m);
  const namespace = namespaceMatch ? namespaceMatch[1].trim() : null;

  const classMatch = content.match(
    /^(?:abstract\s+|final\s+|readonly\s+)*(?:class|interface|trait|enum)\s+(\w+)/m
  );
  if (!classMatch) return null;
  const className = classMatch[1];

  const methodMatches = [
    ...content.matchAll(/^\s*public\s+(?:static\s+)?function\s+(\w+)\s*\(/gm),
  ];
  const methods = methodMatches
    .map((m) => m[1])
    .filter((m) => m !== "__construct");

  return { file, namespace, className, methods };
}

interface RawModule {
  name: string;
  path: string;
  filePaths: string[];
}

function buildModules(allPaths: string[]): RawModule[] {
  const modules: RawModule[] = [];

  const appFiles = allPaths.filter((p) => p.startsWith("app/"));
  const topDirs = new Map<string, string[]>();
  for (const f of appFiles) {
    const rest = f.slice("app/".length);
    const slash = rest.indexOf("/");
    const top = slash === -1 ? "__root__" : rest.slice(0, slash);
    if (!topDirs.has(top)) topDirs.set(top, []);
    topDirs.get(top)!.push(f);
  }

  for (const [top, files] of topDirs) {
    if (top === "__root__") {
      modules.push({ name: "app (root files)", path: "app", filePaths: files });
      continue;
    }

    const children = new Map<string, string[]>();
    const rootOfTop: string[] = [];
    for (const f of files) {
      const rest = f.slice(`app/${top}/`.length);
      const slash = rest.indexOf("/");
      if (slash === -1) {
        rootOfTop.push(f);
        continue;
      }
      const child = rest.slice(0, slash);
      if (!children.has(child)) children.set(child, []);
      children.get(child)!.push(f);
    }

    const hasSignificantChildren = [...children.values()].some(
      (c) => c.length >= MIN_SPLIT_MODULE_SIZE
    );

    if (
      children.size === 0 ||
      (!hasSignificantChildren && files.length <= SMALL_DIR_SINGLE_MODULE_THRESHOLD)
    ) {
      modules.push({ name: `app/${top}`, path: `app/${top}`, filePaths: files });
      continue;
    }

    const misc: string[] = [...rootOfTop];
    for (const [child, childFiles] of children) {
      if (childFiles.length >= MIN_SPLIT_MODULE_SIZE) {
        modules.push({
          name: `app/${top}/${child}`,
          path: `app/${top}/${child}`,
          filePaths: childFiles,
        });
      } else {
        misc.push(...childFiles);
      }
    }
    if (misc.length > 0) {
      modules.push({ name: `app/${top} (misc)`, path: `app/${top}`, filePaths: misc });
    }
  }

  const pkgFiles = allPaths.filter((p) => p.startsWith("packages/ClinicaExperts/"));
  const pkgs = new Map<string, string[]>();
  for (const f of pkgFiles) {
    const rest = f.slice("packages/ClinicaExperts/".length);
    const slash = rest.indexOf("/");
    const pkg = slash === -1 ? rest : rest.slice(0, slash);
    if (!pkgs.has(pkg)) pkgs.set(pkg, []);
    pkgs.get(pkg)!.push(f);
  }
  for (const [pkg, files] of pkgs) {
    modules.push({
      name: `packages/ClinicaExperts/${pkg}`,
      path: `packages/ClinicaExperts/${pkg}`,
      filePaths: files,
    });
  }

  const routeFiles = allPaths.filter((p) => p.startsWith("routes/"));
  if (routeFiles.length > 0) {
    modules.push({ name: "routes", path: "routes", filePaths: routeFiles });
  }

  for (const dir of ["config", "database"]) {
    const files = allPaths.filter((p) => p.startsWith(`${dir}/`));
    if (files.length > 0) modules.push({ name: dir, path: dir, filePaths: files });
  }

  return modules;
}

async function computeMechanical(modules: RawModule[]): Promise<Map<string, ModuleMechanical>> {
  const allPhpPaths = Array.from(
    new Set(modules.flatMap((m) => m.filePaths.filter((f) => f.endsWith(".php"))))
  );

  console.log(`[map] lendo conteúdo de ${allPhpPaths.length} arquivos .php via git cat-file --batch...`);
  const contents = await batchCatFile(allPhpPaths);

  const result = new Map<string, ModuleMechanical>();
  for (const mod of modules) {
    const classInfos: ClassInfo[] = [];
    for (const file of mod.filePaths) {
      if (!file.endsWith(".php")) continue;
      const content = contents.get(file);
      if (!content) continue;
      const info = extractPhpInfo(file, content);
      if (info) classInfos.push(info);
    }
    result.set(mod.path, {
      name: mod.name,
      path: mod.path,
      filePaths: mod.filePaths,
      classInfos,
    });
  }
  return result;
}

function topClasses(mod: ModuleMechanical, limit = 10): string[] {
  return [...mod.classInfos]
    .sort((a, b) => b.methods.length - a.methods.length)
    .slice(0, limit)
    .map((c) => c.className);
}

function mechanicalFallbackSummary(mod: ModuleMechanical): string {
  const classes = topClasses(mod, 3).join(", ") || "sem classes identificadas";
  return `Módulo com ${mod.filePaths.length} arquivo(s). Principais classes: ${classes}.`;
}

interface BudgetTracker {
  calls: number;
  totalTokens: number;
}

function buildModuleBlock(mod: ModuleMechanical): string {
  const classes = [...mod.classInfos]
    .sort((a, b) => b.methods.length - a.methods.length)
    .slice(0, 8);
  const lines = classes.map((c) => {
    const methods = c.methods.slice(0, 6).join(", ") || "sem métodos públicos";
    const ns = c.namespace ? `${c.namespace}\\` : "";
    return `  CLASSE: ${ns}${c.className} (${methods})`;
  });
  return [
    `MODULE_PATH: ${mod.path}`,
    `FILES: ${mod.filePaths.length}`,
    ...lines,
  ].join("\n");
}

async function annotateBatch(
  store: FsStore,
  batch: ModuleMechanical[],
  budget: BudgetTracker
): Promise<Map<string, string>> {
  const result = new Map<string, string>();

  if (budget.calls >= MAX_AI_CALLS || budget.totalTokens >= MAX_TOTAL_TOKENS) {
    for (const mod of batch) result.set(mod.path, mechanicalFallbackSummary(mod));
    return result;
  }

  const system =
    "Você é um engenheiro sênior documentando um monólito Laravel (PHP) para dar contexto rápido a uma IA que vai analisar tasks do Jira. " +
    "A entrada é uma lista de blocos. Cada bloco começa com uma linha 'MODULE_PATH: <caminho>', seguida de 'FILES: <n>' e, opcionalmente, linhas 'CLASSE: ...' com as classes mais relevantes do módulo. " +
    "Para cada bloco, escreva 1-2 frases em português, objetivas, cobrindo: (1) a responsabilidade principal do módulo e (2) com quais outras partes do sistema ele integra (ex: outros módulos, filas, APIs externas, banco de dados). " +
    "Responda em formato estrito de linhas, uma por módulo, no formato exato:\n" +
    "<caminho> ||| resumo em 1-2 frases\n" +
    "O <caminho> DEVE ser copiado exatamente do valor após 'MODULE_PATH: ' daquele bloco — nunca use nomes de classes, namespaces PHP ou qualquer outro identificador. " +
    "Não inclua markdown, cabeçalhos ou texto fora desse formato. Responda com exatamente uma linha por bloco recebido, na mesma ordem, sem pular nenhum.";

  const user = batch.map((mod) => buildModuleBlock(mod)).join("\n\n");

  try {
    const res = await directChatCompletion(store, { system, user });
    budget.calls += 1;
    budget.totalTokens += res.promptTokens + res.completionTokens;

    const lines = res.content.split("\n").map((l) => l.trim()).filter(Boolean);
    const parsed = new Map<string, string>();
    for (const line of lines) {
      const sepIndex = line.indexOf("|||");
      if (sepIndex === -1) continue;
      const path = line.slice(0, sepIndex).trim();
      const summary = line.slice(sepIndex + 3).trim();
      if (path && summary) parsed.set(path, summary);
    }

    for (const mod of batch) {
      result.set(mod.path, parsed.get(mod.path) ?? mechanicalFallbackSummary(mod));
    }
  } catch (err) {
    console.warn(
      `[map] falha ao anotar batch (${batch.map((m) => m.path).join(", ")}): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    for (const mod of batch) result.set(mod.path, mechanicalFallbackSummary(mod));
  }

  return result;
}

function computeBatchSize(totalModules: number): number {
  return Math.max(MIN_BATCH_SIZE, Math.ceil(totalModules / MAX_AI_CALLS));
}

function toModuleOutput(mod: ModuleMechanical, summary: string): ModuleOutput {
  return {
    name: mod.name,
    path: mod.path,
    files: mod.filePaths.length,
    classes: topClasses(mod),
    summary,
  };
}

function renderMarkdown(map: ProjectMap): string {
  const lines: string[] = [];
  lines.push(`# Mapa do projeto — clinicaexperts_app`);
  lines.push(``);
  lines.push(`Gerado em: ${map.generatedAt}`);
  lines.push(`Commit (origin/main): ${map.commit}`);
  lines.push(`Módulos: ${map.modules.length}`);
  lines.push(``);
  for (const mod of map.modules) {
    lines.push(`## ${mod.path} (${mod.files} arquivos)`);
    if (mod.classes.length > 0) lines.push(`Classes: ${mod.classes.join(", ")}`);
    lines.push(mod.summary);
    lines.push(``);
  }
  let text = lines.join("\n");

  if (Buffer.byteLength(text, "utf-8") > MAX_MD_BYTES) {
    console.warn("[map] project-map.md excedeu o limite, truncando classes por módulo...");
    const trimmedLines: string[] = [];
    trimmedLines.push(`# Mapa do projeto — clinicaexperts_app`);
    trimmedLines.push(``);
    trimmedLines.push(`Gerado em: ${map.generatedAt}`);
    trimmedLines.push(`Commit (origin/main): ${map.commit}`);
    trimmedLines.push(`Módulos: ${map.modules.length}`);
    trimmedLines.push(``);
    for (const mod of map.modules) {
      trimmedLines.push(`## ${mod.path} (${mod.files} arquivos)`);
      if (mod.classes.length > 0) trimmedLines.push(`Classes: ${mod.classes.slice(0, 4).join(", ")}`);
      trimmedLines.push(mod.summary);
      trimmedLines.push(``);
    }
    text = trimmedLines.join("\n");
  }

  return text;
}

function loadExistingMap(): ProjectMap | null {
  if (!existsSync(OUTPUT_JSON)) return null;
  try {
    return JSON.parse(readFileSync(OUTPUT_JSON, "utf-8")) as ProjectMap;
  } catch {
    return null;
  }
}

function parseArgs(argv: string[]): { since?: string } {
  const args: { since?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--since" && argv[i + 1]) {
      args.since = argv[i + 1];
      i++;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const { since } = parseArgs(process.argv.slice(2));

  if (!existsSync(REPO_PATH)) fail(`checkout do Laravel não encontrado em ${REPO_PATH}`);

  fetchOriginMain();
  const commit = getCommitSha();
  const allPaths = listTree();

  console.log(`[map] ${allPaths.length} arquivos em origin/main (${commit.slice(0, 10)})`);
  console.log(
    `[map] top-level dirs relevantes: ${RELEVANT_TOP_DIRS.filter((d) =>
      allPaths.some((p) => p.startsWith(`${d}/`))
    ).join(", ")}`
  );

  const rawModules = buildModules(allPaths);
  console.log(`[map] ${rawModules.length} módulos identificados`);

  const store = new FsStore();
  const budget: BudgetTracker = { calls: 0, totalTokens: 0 };

  const existing = since ? loadExistingMap() : null;
  const existingByPath = new Map((existing?.modules ?? []).map((m) => [m.path, m]));

  let dirtyPaths: Set<string> | null = null;
  if (since) {
    if (!existing) {
      console.warn(
        "[map] --since informado mas project-map.json não existe ainda; rodando geração completa."
      );
    } else {
      const changed = new Set(diffChangedFiles(since));
      dirtyPaths = new Set();
      for (const mod of rawModules) {
        const isNew = !existingByPath.has(mod.path);
        const touched = mod.filePaths.some((f) => changed.has(f));
        if (isNew || touched) dirtyPaths.add(mod.path);
      }
      console.log(
        `[map] modo incremental desde ${since}: ${dirtyPaths.size}/${rawModules.length} módulos precisam reanotação`
      );
    }
  }

  const toRecompute = dirtyPaths
    ? rawModules.filter((m) => dirtyPaths!.has(m.path))
    : rawModules;
  const mechanicalMap = await computeMechanical(toRecompute);

  const finalOutputs: ModuleOutput[] = [];
  const modulesNeedingAnnotation: ModuleMechanical[] = [];

  for (const mod of rawModules) {
    if (dirtyPaths && !dirtyPaths.has(mod.path)) {
      const prev = existingByPath.get(mod.path);
      if (prev) {
        finalOutputs.push(prev);
        continue;
      }
    }
    const mech = mechanicalMap.get(mod.path);
    if (!mech) continue;
    modulesNeedingAnnotation.push(mech);
  }

  const batchSize = computeBatchSize(modulesNeedingAnnotation.length);
  console.log(
    `[map] anotando ${modulesNeedingAnnotation.length} módulos via Codex em lotes de ${batchSize} (limite ${MAX_AI_CALLS} chamadas / ${MAX_TOTAL_TOKENS} tokens)`
  );

  for (let i = 0; i < modulesNeedingAnnotation.length; i += batchSize) {
    const batch = modulesNeedingAnnotation.slice(i, i + batchSize);
    console.log(
      `[map] lote ${Math.floor(i / batchSize) + 1}: ${batch.map((m) => m.path).join(", ")}`
    );
    const summaries = await annotateBatch(store, batch, budget);
    for (const mod of batch) {
      finalOutputs.push(toModuleOutput(mod, summaries.get(mod.path) ?? mechanicalFallbackSummary(mod)));
    }
  }

  finalOutputs.sort((a, b) => a.path.localeCompare(b.path));

  const map: ProjectMap = {
    generatedAt: new Date().toISOString(),
    commit,
    modules: finalOutputs,
  };

  writeFileSync(OUTPUT_JSON, JSON.stringify(map, null, 2));
  const md = renderMarkdown(map);
  writeFileSync(OUTPUT_MD, md);

  console.log(`[map] OK: ${finalOutputs.length} módulos`);
  console.log(`[map] chamadas Codex: ${budget.calls}, tokens gastos: ${budget.totalTokens}`);
  console.log(`[map] ${OUTPUT_JSON}`);
  console.log(`[map] ${OUTPUT_MD} (${Buffer.byteLength(md, "utf-8")} bytes)`);
}

main().catch((err) => {
  fail(err instanceof Error ? `${err.message}\n${err.stack}` : String(err));
});
