// Task Radar v7 — avaliação do retrieval SEM LLM, nas mesmas 20 tasks do benchmark v5.
//
// Gabarito: para cada key do benchmark, une os módulos reais de TODOS os PRs daquela key
// no task-index.json (às vezes uma key tem mais de um PR — hotfix/follow-up).
// Sem vazamento: os PRs da própria key são excluídos dos sinais de retrieval
// (rankSimilarTasks via excludeKeys/excludePrs, e a matriz de co-change via excludePrs).
//
// Métricas: Recall@5, Recall@10, Recall@20, MAP@10.
// Grid rápido: testa combinações de pesos (reaproveitando os sinais já computados por task,
// que não dependem dos pesos) e reporta a melhor por Recall@10.
//
// Uso: bun run scripts/task-radar-v7/eval-retrieval.ts

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadProjectMap, deriveModulePaths } from "../task-radar/project-map.ts";
import { loadTaskIndex } from "../task-radar/task-index.ts";
import { computeSignals, combineSignals, CONFIG, type RetrieveWeights } from "./retrieve.ts";

const TASK_INDEX_PATH = join(import.meta.dir, "../../task-index.json");
const PROJECT_MAP_PATH = join(import.meta.dir, "../../project-map.json");

// --keys-file=<path> (ou --keys-file <path>) aponta pra outro arquivo { rows: [{key,title}] } —
// permite rodar o mesmo grid/avaliação numa amostra diferente das 20 tasks do benchmark v5
// (ex.: amostra maior pra checar overfit dos pesos). Sem a flag, comportamento idêntico a antes.
function parseKeysFileArg(): string | null {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--keys-file") return args[i + 1] ?? null;
    if (arg.startsWith("--keys-file=")) return arg.slice("--keys-file=".length);
  }
  return null;
}

const BENCHMARK_PATH = parseKeysFileArg() ?? join(import.meta.dir, "../../task-benchmark-v5.json");

// --out=<path> opcional — por padrão grava em v7-retrieval-eval.json (mesmo nome de sempre)
// pra não quebrar o fluxo v1-v6; use --out pra não sobrescrever o eval original ao rodar
// numa amostra diferente.
function parseOutArg(): string | null {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--out") return args[i + 1] ?? null;
    if (arg.startsWith("--out=")) return arg.slice("--out=".length);
  }
  return null;
}

const OUT_PATH = parseOutArg() ?? join(import.meta.dir, "v7-retrieval-eval.json");

interface BenchmarkRow {
  key: string;
  title: string;
}

interface BenchmarkFile {
  rows: BenchmarkRow[];
}

interface EvalCase {
  key: string;
  title: string;
  goldModules: string[];
  excludePrs: Set<number>;
}

function buildEvalCases(): EvalCase[] {
  const benchmark = JSON.parse(readFileSync(BENCHMARK_PATH, "utf-8")) as BenchmarkFile;
  const modules = loadProjectMap(PROJECT_MAP_PATH).modules;
  const entries = loadTaskIndex(TASK_INDEX_PATH);

  const cases: EvalCase[] = [];
  for (const row of benchmark.rows) {
    const matchingEntries = entries.filter((e) => e.key === row.key);
    const excludePrs = new Set(matchingEntries.map((e) => e.pr));
    const goldSet = new Set<string>();
    for (const entry of matchingEntries) {
      for (const m of deriveModulePaths(entry.files, modules)) goldSet.add(m);
    }
    cases.push({
      key: row.key,
      title: row.title,
      goldModules: [...goldSet],
      excludePrs,
    });
  }
  return cases;
}

export function recallAtK(retrieved: string[], gold: string[], k: number): number {
  if (gold.length === 0) return 1;
  const topK = new Set(retrieved.slice(0, k));
  const hits = gold.filter((g) => topK.has(g)).length;
  return hits / gold.length;
}

// Hit@k (a.k.a. Success@k): 1 se pelo menos um módulo do gabarito aparece no top-k, 0 caso
// contrário. Usado no benchmark v7 como "Acc@5" do ranking pós-rerank — mais informativo que
// recall puro quando o gabarito tem muitos módulos (recall@5 fica baixo por definição).
export function hitAtK(retrieved: string[], gold: string[], k: number): number {
  if (gold.length === 0) return 1;
  const topK = new Set(retrieved.slice(0, k));
  return gold.some((g) => topK.has(g)) ? 1 : 0;
}

export function averagePrecisionAtK(retrieved: string[], gold: string[], k: number): number {
  if (gold.length === 0) return 1;
  const goldSet = new Set(gold);
  const denom = Math.min(gold.length, k);
  let hits = 0;
  let sumPrecision = 0;
  for (let i = 0; i < Math.min(k, retrieved.length); i++) {
    if (goldSet.has(retrieved[i]!)) {
      hits++;
      sumPrecision += hits / (i + 1);
    }
  }
  return denom === 0 ? 0 : sumPrecision / denom;
}

interface WeightConfig {
  name: string;
  weights: RetrieveWeights;
}

const GRID: WeightConfig[] = [
  { name: "default (35/35/20/10)", weights: { titleSim: 0.35, fts: 0.35, cochange: 0.2, centrality: 0.1 } },
  { name: "fts-heavy (20/50/20/10)", weights: { titleSim: 0.2, fts: 0.5, cochange: 0.2, centrality: 0.1 } },
  { name: "titleSim-heavy (50/20/20/10)", weights: { titleSim: 0.5, fts: 0.2, cochange: 0.2, centrality: 0.1 } },
  { name: "no-centrality (40/40/20/00)", weights: { titleSim: 0.4, fts: 0.4, cochange: 0.2, centrality: 0.0 } },
  { name: "cochange-heavy (25/25/40/10)", weights: { titleSim: 0.25, fts: 0.25, cochange: 0.4, centrality: 0.1 } },
];

interface CaseResult {
  key: string;
  goldCount: number;
  recall5: number;
  recall10: number;
  recall20: number;
  ap10: number;
}

interface ConfigResult {
  name: string;
  weights: RetrieveWeights;
  meanRecall5: number;
  meanRecall10: number;
  meanRecall20: number;
  meanAp10: number;
  perCase: CaseResult[];
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

async function main() {
  const startedAt = Date.now();
  const cases = buildEvalCases();
  console.log(`[eval-retrieval] ${cases.length} tasks do benchmark v5`);

  // Sinais computados uma vez por task (independem dos pesos) — reaproveitados em todo o grid.
  const signalsByKey = new Map<string, Awaited<ReturnType<typeof computeSignals>>>();
  for (const c of cases) {
    signalsByKey.set(c.key, await computeSignals(c.title, { excludeKeys: new Set([c.key]), excludePrs: c.excludePrs }));
  }
  console.log(`[eval-retrieval] sinais computados para ${signalsByKey.size} tasks em ${Date.now() - startedAt}ms`);

  const configResults: ConfigResult[] = [];
  for (const { name, weights } of GRID) {
    const perCase: CaseResult[] = [];
    for (const c of cases) {
      const signals = signalsByKey.get(c.key)!;
      const retrieved = combineSignals(signals, weights, 20).map((r) => r.path);
      perCase.push({
        key: c.key,
        goldCount: c.goldModules.length,
        recall5: recallAtK(retrieved, c.goldModules, 5),
        recall10: recallAtK(retrieved, c.goldModules, 10),
        recall20: recallAtK(retrieved, c.goldModules, 20),
        ap10: averagePrecisionAtK(retrieved, c.goldModules, 10),
      });
    }
    configResults.push({
      name,
      weights,
      meanRecall5: mean(perCase.map((p) => p.recall5)),
      meanRecall10: mean(perCase.map((p) => p.recall10)),
      meanRecall20: mean(perCase.map((p) => p.recall20)),
      meanAp10: mean(perCase.map((p) => p.ap10)),
      perCase,
    });
  }

  configResults.sort((a, b) => b.meanRecall10 - a.meanRecall10);
  const best = configResults[0]!;

  console.log("\n[eval-retrieval] Tabela de recall por configuração:");
  console.log("config".padEnd(32), "R@5".padStart(7), "R@10".padStart(7), "R@20".padStart(7), "MAP@10".padStart(8));
  for (const r of configResults) {
    console.log(
      r.name.padEnd(32),
      (r.meanRecall5 * 100).toFixed(1).padStart(6) + "%",
      (r.meanRecall10 * 100).toFixed(1).padStart(6) + "%",
      (r.meanRecall20 * 100).toFixed(1).padStart(6) + "%",
      (r.meanAp10 * 100).toFixed(1).padStart(7) + "%"
    );
  }

  const goalMet = best.meanRecall10 >= 0.8;
  console.log(
    `\n[eval-retrieval] Melhor config: "${best.name}" — Recall@10 = ${(best.meanRecall10 * 100).toFixed(1)}% ` +
      `(meta >= 80%: ${goalMet ? "ATINGIDA" : "NÃO atingida"})`
  );

  const output = {
    generatedAt: new Date().toISOString(),
    benchmarkSource: BENCHMARK_PATH,
    tasksTotal: cases.length,
    defaultConfig: CONFIG,
    grid: configResults,
    best: { name: best.name, weights: best.weights, meanRecall10: best.meanRecall10 },
    goal: { metric: "recall@10", threshold: 0.8, met: goalMet },
    elapsedMs: Date.now() - startedAt,
  };
  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));
  console.log(`[eval-retrieval] salvo em ${OUT_PATH}`);
}

// Guard necessário: benchmark-v7.ts importa hitAtK/averagePrecisionAtK deste módulo — sem o
// guard, o main() rodava no import e sobrescrevia v7-retrieval-eval.json com o argv do caller.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
