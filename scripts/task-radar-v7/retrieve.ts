// Task Radar v7 — retrieval de módulos candidatos SEM LLM.
//
// Combina 4 sinais por módulo:
//   a) similaridade de título (jaccard, mesmo tokenizador do pipeline v1-v6) sobre os
//      top-N PRs mais parecidos do task-index.json
//   b) FTS5 lexical (bun:sqlite, índice em memória) sobre summary+classes+path de cada
//      módulo do project-map.json
//   c) expansão por co-change: vizinhos fortes (v7-cochange.json) dos candidatos de (a)+(b)
//   d) prior de centralidade (PageRank do v7-code-graph.json) como desempate leve
//
// Desenhado em duas camadas pra permitir grid search barato em eval-retrieval.ts:
//   computeSignals(taskText, options) — roda os 4 sinais uma vez (caro: FTS query,
//     rankSimilarTasks, expansão de co-change) e devolve scores normalizados (0..1) por módulo.
//   combineSignals(signals, weights, topN) — soma ponderada + corte top-N (barato, repetível
//     pra cada combinação de pesos do grid).
//   retrieveModules(taskText, options, config) — atalho que encadeia as duas.

import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadProjectMap, matchModuleForFile } from "../task-radar/project-map.ts";
import { loadTaskIndex, rankSimilarTasks } from "../task-radar/task-index.ts";
import { tokenize } from "../task-radar/text.ts";
import type { ProjectModule, TaskIndexEntry } from "../task-radar/types.ts";
import { buildCochangePairs, type CochangeIndex, type PrModules } from "./build-cochange.ts";

// Em produção (Lambda) os 4 artefatos são baixados do S3 para /tmp e TASK_RADAR_DATA_DIR
// aponta pra lá (ver lambda/task-radar-artifacts.ts). Localmente (benchmark, eval, CLI) a
// env var não é setada e os caminhos relativos a import.meta.dir continuam valendo — sem
// mudança de comportamento nesses usos.
//
// Importante: os caminhos são computados sob demanda (dentro das funções abaixo), NÃO em
// consts de topo de módulo. lambda/handler.ts importa este módulo dinamicamente depois de
// setar TASK_RADAR_DATA_DIR (ver ensureTaskRadarArtifacts), mas o bundle gerado por
// scripts/build.sh (bun build sem code-splitting) inlina módulos resolvíveis localmente no
// mesmo chunk — o código de topo desses módulos roda no cold start do bundle, antes da env
// var existir, se computado eager. Calculando os caminhos dentro de getModules()/getTaskIndex()
// etc. (chamadas só de fato na hora da requisição) evita essa armadilha.
function projectMapPath(): string {
  return join(process.env.TASK_RADAR_DATA_DIR || join(import.meta.dir, "../.."), "project-map.json");
}
function taskIndexPath(): string {
  return join(process.env.TASK_RADAR_DATA_DIR || join(import.meta.dir, "../.."), "task-index.json");
}
function cochangePath(): string {
  return join(process.env.TASK_RADAR_DATA_DIR || import.meta.dir, "v7-cochange.json");
}
function codeGraphPath(): string {
  return join(process.env.TASK_RADAR_DATA_DIR || import.meta.dir, "v7-code-graph.json");
}

export interface RetrieveWeights {
  titleSim: number;
  fts: number;
  cochange: number;
  centrality: number;
}

export interface RetrieveConfig {
  topPRsForTitle: number;
  ftsTopModules: number;
  cochangeExpansionSeeds: number;
  cochangeNeighborsPerSeed: number;
  topResults: number;
  weights: RetrieveWeights;
}

export const CONFIG: RetrieveConfig = {
  topPRsForTitle: 15,
  ftsTopModules: 40,
  cochangeExpansionSeeds: 15,
  cochangeNeighborsPerSeed: 8,
  topResults: 20,
  // Pesos vencedores do grid em eval-retrieval.ts (melhor Recall@10 nas 20 tasks do
  // benchmark v5). Atenção: grid pequeno (n=20) — risco de overfit, revisitar quando
  // o benchmark crescer.
  weights: {
    titleSim: 0.5,
    fts: 0.2,
    cochange: 0.2,
    centrality: 0.1,
  },
};

export interface RetrieveOptions {
  excludeKeys?: Set<string>;
  excludePrs?: Set<number>;
}

export interface ModuleSignals {
  titleSim: number;
  fts: number;
  cochange: number;
  centrality: number;
}

export interface RetrievedModule {
  path: string;
  score: number;
  signals: ModuleSignals;
}

// ---------------------------------------------------------------------------
// Carregamento de dados (memoizado a nível de módulo — os JSONs não mudam entre calls).
// ---------------------------------------------------------------------------

let _modules: ProjectModule[] | null = null;
function getModules(): ProjectModule[] {
  if (!_modules) _modules = loadProjectMap(projectMapPath()).modules;
  return _modules;
}

let _taskIndex: TaskIndexEntry[] | null = null;
function getTaskIndex(): TaskIndexEntry[] {
  if (!_taskIndex) _taskIndex = loadTaskIndex(taskIndexPath());
  return _taskIndex;
}

let _prModules: PrModules[] | null = null;
function getPrModules(): PrModules[] {
  if (!_prModules) {
    const raw = JSON.parse(readFileSync(cochangePath(), "utf-8"));
    _prModules = raw.prModules as PrModules[];
  }
  return _prModules;
}

let _centralityByModule: Map<string, number> | null = null;
function getCentralityByModule(): Map<string, number> {
  if (_centralityByModule) return _centralityByModule;
  const raw = JSON.parse(readFileSync(codeGraphPath(), "utf-8")) as {
    nodes: string[];
    pagerank: number[];
  };
  const modules = getModules();
  const sums = new Map<string, number>();
  for (let i = 0; i < raw.nodes.length; i++) {
    // nós do grafo são caminhos relativos ao snapshot extraído (app/..., database/...);
    // o project-map usa os mesmos prefixos (app/...), então o match direto funciona.
    const module = matchModuleForFile(raw.nodes[i]!, modules);
    if (!module) continue;
    sums.set(module.path, (sums.get(module.path) ?? 0) + raw.pagerank[i]!);
  }
  _centralityByModule = sums;
  return sums;
}

// bun:sqlite só existe sob o runtime Bun. Import dinâmico e lazy (em vez de estático no topo
// do arquivo): localmente (bun run, benchmark-v7.ts, eval-retrieval.ts) segue funcionando
// idêntico a antes. Sob o runtime real do Node.js (Lambda, nodejs22.x — ver lambda/handler.ts,
// que importa este módulo dinamicamente para o modo task-analyze) o loader ESM do Node não
// resolve o protocolo "bun:", então aqui degradamos com graça: sem FTS (peso 0.2 do score
// final simplesmente some, os outros 3 sinais continuam de pé) em vez de derrubar o processo.
let _ftsDb: Database | null | undefined;
async function getFtsDb(): Promise<Database | null> {
  if (_ftsDb !== undefined) return _ftsDb;
  try {
    const { Database: BunDatabase } = await import("bun:sqlite");
    const db = new BunDatabase(":memory:");
    db.run(`CREATE VIRTUAL TABLE modules_fts USING fts5(module_path UNINDEXED, content)`);
    const insert = db.prepare(`INSERT INTO modules_fts (module_path, content) VALUES (?, ?)`);
    for (const m of getModules()) {
      const doc = [m.name, m.path.replace(/\//g, " "), m.classes.join(" "), m.classes.join(" "), m.summary].join(" ");
      insert.run(m.path, doc);
    }
    _ftsDb = db;
  } catch {
    _ftsDb = null;
  }
  return _ftsDb;
}

function minMaxNormalize(scores: Map<string, number>): Map<string, number> {
  if (scores.size === 0) return scores;
  let min = Infinity;
  let max = -Infinity;
  for (const v of scores.values()) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const normalized = new Map<string, number>();
  const range = max - min;
  for (const [k, v] of scores) normalized.set(k, range === 0 ? (max === 0 ? 0 : 1) : (v - min) / range);
  return normalized;
}

// ---------------------------------------------------------------------------
// Sinal (a): similaridade de título sobre top-N PRs do task-index.
// ---------------------------------------------------------------------------

function signalTitleSimilarity(taskText: string, options: RetrieveOptions): Map<string, number> {
  const similar = rankSimilarTasks(taskText, getTaskIndex(), getModules(), {
    excludeKeys: options.excludeKeys,
    excludePrs: options.excludePrs,
    topN: CONFIG.topPRsForTitle,
  }).filter((s) => s.score > 0);

  const raw = new Map<string, number>();
  for (const ref of similar) {
    for (const modulePath of ref.modules) {
      raw.set(modulePath, (raw.get(modulePath) ?? 0) + ref.score);
    }
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Sinal (b): FTS5 lexical sobre summary+classes+path do project-map.
// ---------------------------------------------------------------------------

async function signalFts(taskText: string): Promise<Map<string, number>> {
  const tokens = tokenize(taskText);
  if (tokens.length === 0) return new Map();

  const uniqueTokens = [...new Set(tokens)];
  const query = uniqueTokens.map((t) => `"${t}"`).join(" OR ");
  const db = await getFtsDb();
  if (!db) return new Map();

  const raw = new Map<string, number>();
  try {
    const rows = db
      .query(`SELECT module_path, bm25(modules_fts) as score FROM modules_fts WHERE modules_fts MATCH ? ORDER BY score ASC LIMIT ?`)
      .all(query, CONFIG.ftsTopModules) as Array<{ module_path: string; score: number }>;
    for (const row of rows) {
      // bm25() do SQLite: menor (mais negativo) = melhor match. Inverte o sinal pra
      // "maior = melhor" antes de normalizar junto com os outros sinais.
      raw.set(row.module_path, -row.score);
    }
  } catch {
    // query MATCH mal formada (raro, tokens já são [a-z0-9]+) — sem candidatos de FTS.
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Sinal (c): expansão por co-change dos candidatos de (a) + (b).
// ---------------------------------------------------------------------------

function signalCochangeExpansion(
  seedModules: string[],
  cochangeIndex: CochangeIndex
): Map<string, number> {
  const raw = new Map<string, number>();
  const seeds = seedModules.slice(0, CONFIG.cochangeExpansionSeeds);
  for (const seed of seeds) {
    const neighbors = cochangeIndex.neighborsByModule[seed] ?? [];
    for (const neighbor of neighbors.slice(0, CONFIG.cochangeNeighborsPerSeed)) {
      raw.set(neighbor.module, (raw.get(neighbor.module) ?? 0) + neighbor.conditional);
    }
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Sinal (d): prior de centralidade (PageRank do grafo de código).
// ---------------------------------------------------------------------------

function signalCentrality(candidateModules: Set<string>): Map<string, number> {
  const centrality = getCentralityByModule();
  const raw = new Map<string, number>();
  for (const m of candidateModules) raw.set(m, centrality.get(m) ?? 0);
  return raw;
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

export interface ComputedSignals {
  perModule: Map<string, ModuleSignals>;
}

export async function computeSignals(taskText: string, options: RetrieveOptions = {}): Promise<ComputedSignals> {
  const rawA = signalTitleSimilarity(taskText, options);
  const rawB = await signalFts(taskText);

  // Sementes de expansão: união dos candidatos de (a) e (b), ordenados pela soma dos
  // scores brutos (não ponderados — a expansão não depende dos pesos finais do CONFIG).
  const seedCandidates = new Set([...rawA.keys(), ...rawB.keys()]);
  const seedOrder = [...seedCandidates].sort(
    (m1, m2) => (rawA.get(m2) ?? 0) + (rawB.get(m2) ?? 0) - ((rawA.get(m1) ?? 0) + (rawB.get(m1) ?? 0))
  );

  const prModules = getPrModules();
  const cochangeIndex = buildCochangePairs(prModules, options.excludePrs);
  const rawC = signalCochangeExpansion(seedOrder, cochangeIndex);

  const candidateModules = new Set([...rawA.keys(), ...rawB.keys(), ...rawC.keys()]);
  const rawD = signalCentrality(candidateModules);

  const normA = minMaxNormalize(rawA);
  const normB = minMaxNormalize(rawB);
  const normC = minMaxNormalize(rawC);
  const normD = minMaxNormalize(rawD);

  const perModule = new Map<string, ModuleSignals>();
  for (const m of candidateModules) {
    perModule.set(m, {
      titleSim: normA.get(m) ?? 0,
      fts: normB.get(m) ?? 0,
      cochange: normC.get(m) ?? 0,
      centrality: normD.get(m) ?? 0,
    });
  }
  return { perModule };
}

export function combineSignals(
  signals: ComputedSignals,
  weights: RetrieveWeights,
  topN: number
): RetrievedModule[] {
  const scored: RetrievedModule[] = [...signals.perModule.entries()].map(([path, s]) => ({
    path,
    score:
      weights.titleSim * s.titleSim +
      weights.fts * s.fts +
      weights.cochange * s.cochange +
      weights.centrality * s.centrality,
    signals: s,
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN);
}

export async function retrieveModules(
  taskText: string,
  options: RetrieveOptions = {},
  config: RetrieveConfig = CONFIG
): Promise<RetrievedModule[]> {
  const signals = await computeSignals(taskText, options);
  return combineSignals(signals, config.weights, config.topResults);
}

if (import.meta.main) {
  const sampleText = process.argv[2] ?? "Corrigir erro ao carregar usuários no admin";
  const result = await retrieveModules(sampleText);
  console.log(JSON.stringify(result, null, 2));
}
