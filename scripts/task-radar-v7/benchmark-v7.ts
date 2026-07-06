// Task Radar v7 — benchmark completo (retrieve → rerank → effort) nas mesmas 20 tasks do
// benchmark v5/v6, com descrições reais do Jira (reaproveita o fetch do pipeline v1-v6).
//
// Sem vazamento: para cada key avaliada, todos os PRs daquela key são excluídos de TODOS os
// sinais (retrieve.ts: title similarity + co-change; effort.ts: k-NN de linhas).
//
// Estágios por task:
//   1. retrieve.ts   — candidatos top-20, SEM LLM (usa só o título, mesmo input com que o
//                       CONFIG foi calibrado em eval-retrieval.ts).
//   2. rerank.ts     — 1 chamada LLM listwise, com o texto completo da task (título+descrição),
//                       decide quais candidatos ficam, sem cap artificial.
//   3. effort.ts     — bucket P/M/G por k-NN puro (mediana de linhas), SEM LLM.
//
// Métricas:
//   - precision/recall/F1 dos módulos pós-rerank (comparável a v1-v6, com e sem corte de
//     confidence >= 0.5)
//   - Acc@5 (hit rate — pelo menos um módulo do gabarito no top-5 pós-rerank) e MAP@10 do
//     ranking pós-rerank (ordenado por confidence)
//   - acurácia do bucket de esforço vs proxy de linhas reais (sumChangedLines dos PRs da key);
//     "indefinido" conta como erro
//   - tokens (só o rerank tem LLM) e tempo
//
// Uso: bun run scripts/task-radar-v7/benchmark-v7.ts

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FsStore } from "../../lambda/store.ts";
import { resolveCodexModel } from "../../src/services/model-resolve.ts";
import { mapWithConcurrency } from "../task-radar/concurrency.ts";
import { JiraNotFoundError, fetchJiraTaskInput } from "../task-radar/jira-issue.ts";
import { difficultyFromLines, precisionRecall, sumChangedLines } from "../task-radar/metrics.ts";
import { deriveModulePaths, loadProjectMap } from "../task-radar/project-map.ts";
import { loadTaskIndex } from "../task-radar/task-index.ts";
import type { PipelineUsage, ProjectModule, TaskIndexEntry, TaskInput } from "../task-radar/types.ts";
import { estimateEffort, type EffortBucket } from "./effort.ts";
import { averagePrecisionAtK, hitAtK } from "./eval-retrieval.ts";
import { rerankModules } from "./rerank.ts";
import { retrieveModules } from "./retrieve.ts";

const REPO_ROOT = join(import.meta.dir, "../..");
const PROJECT_MAP_PATH = join(REPO_ROOT, "project-map.json");
const TASK_INDEX_PATH = join(REPO_ROOT, "task-index.json");

// --keys-file=<path> (ou --keys-file <path>) aponta pra um arquivo alternativo
// { rows: [{key,title}] } com as keys a avaliar — por padrão continua reaproveitando as
// mesmas 20 keys do benchmark v5. Permite rodar o mesmo pipeline (retrieve → rerank → effort)
// numa amostra maior/diferente sem duplicar o script (ex.: checar overfit dos pesos do
// retrieval numa amostra de validação).
function parseKeysFileArg(): string | null {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--keys-file") return args[i + 1] ?? null;
    if (arg.startsWith("--keys-file=")) return arg.slice("--keys-file=".length);
  }
  return null;
}

const KEYS_FILE_PATH =
  parseKeysFileArg() ?? (process.env.BENCHMARK_KEYS_FILE?.trim() || join(REPO_ROOT, "task-benchmark-v5.json"));
const OUT_FILE = process.env.BENCHMARK_OUT_FILE?.trim() || join(REPO_ROOT, "task-benchmark-v7.json");

const CONCURRENCY = Number(process.env.CONCURRENCY_BENCHMARK ?? 3);
const HIGH_CONFIDENCE_CUTOFF = 0.5;

interface Deps {
  projectMap: ProjectModule[];
  taskIndex: TaskIndexEntry[];
}

function loadDeps(): Deps {
  return {
    projectMap: loadProjectMap(PROJECT_MAP_PATH).modules,
    taskIndex: loadTaskIndex(TASK_INDEX_PATH),
  };
}

interface V5BenchmarkRow {
  key: string;
  title: string;
}

interface V5BenchmarkFile {
  rows: V5BenchmarkRow[];
}

interface EvalTask {
  key: string;
  fallbackTitle: string;
  allEntries: TaskIndexEntry[];
}

// Por padrão, mesmas 20 keys do benchmark v5 (não reseleciona — reaproveita a amostra já usada
// em v1-v6 pra manter os números comparáveis). Com --keys-file, usa as keys de outro arquivo
// no mesmo formato { rows: [{key,title}] } (ex.: amostra de validação maior).
function loadEvalTasks(taskIndex: TaskIndexEntry[]): EvalTask[] {
  const v5 = JSON.parse(readFileSync(KEYS_FILE_PATH, "utf-8")) as V5BenchmarkFile;

  const byKey = new Map<string, TaskIndexEntry[]>();
  for (const entry of taskIndex) {
    if (!entry.key) continue;
    const bucket = byKey.get(entry.key) ?? [];
    bucket.push(entry);
    byKey.set(entry.key, bucket);
  }

  return v5.rows.map((row) => ({
    key: row.key,
    fallbackTitle: row.title,
    allEntries: byKey.get(row.key) ?? [],
  }));
}

async function resolveTaskInput(task: EvalTask): Promise<{ input: TaskInput; fallback: boolean }> {
  try {
    const input = await fetchJiraTaskInput(task.key);
    return { input, fallback: false };
  } catch (err) {
    if (!(err instanceof JiraNotFoundError)) {
      console.warn(`[benchmark-v7] ${task.key}: Jira falhou (${String(err).slice(0, 120)}), usando título do PR`);
    }
    const input: TaskInput = { key: task.key, title: task.fallbackTitle, description: "", issueType: null };
    return { input, fallback: true };
  }
}

function f1Score(precision: number, recall: number): number {
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

interface BenchmarkV7Row {
  key: string;
  title: string;
  jiraFallback: boolean;
  retrievedCount: number;
  rerankedCount: number;
  precision: number;
  recall: number;
  f1: number;
  precisionConf50: number;
  recallConf50: number;
  f1Conf50: number;
  acc5: number;
  ap10: number;
  effortBucket: EffortBucket;
  realEffortProxy: string;
  effortMatch: boolean;
  effortMedianLines: number | null;
  effortSimilarCount: number;
  elapsedMs: number;
  error?: string;
}

interface TaskResult {
  row: BenchmarkV7Row;
  usage: PipelineUsage | null;
}

async function runOne(task: EvalTask, deps: Deps): Promise<TaskResult> {
  const startedAt = Date.now();
  const store = new FsStore();
  const { input, fallback } = await resolveTaskInput(task);

  const excludeKeys = new Set([task.key]);
  const excludePrs = new Set(task.allEntries.map((e) => e.pr));

  // Estágio 1: retrieval sem LLM. Usa só o título — mesmo tipo de input com que o CONFIG
  // vencedor foi calibrado em eval-retrieval.ts (R@20 = 85.5%).
  const candidates = await retrieveModules(input.title, { excludeKeys, excludePrs });

  // Estágio 2: rerank listwise (1 chamada LLM), com o texto completo (título + descrição real
  // do Jira) — mais contexto do que o retrieval teve pra decidir o que de fato entra.
  const rerank = await rerankModules(store, input, candidates, { excludeKeys, excludePrs });

  // Estágio 3: esforço por k-NN puro, sem LLM e sem fallback pro modelo — "indefinido" quando
  // não há histórico suficiente.
  const effort = estimateEffort(input.title, deps.taskIndex, excludeKeys);

  const files = task.allEntries.flatMap((e) => e.files);
  const realModules = deriveModulePaths(files, deps.projectMap);
  const rerankedPaths = rerank.modules.map((m) => m.path);

  const { precision, recall } = precisionRecall(rerankedPaths, realModules);
  const rerankedConf50 = rerank.modules.filter((m) => m.confidence >= HIGH_CONFIDENCE_CUTOFF).map((m) => m.path);
  const { precision: precisionConf50, recall: recallConf50 } = precisionRecall(rerankedConf50, realModules);

  const realEffortProxy = difficultyFromLines(sumChangedLines(files));

  const row: BenchmarkV7Row = {
    key: task.key,
    title: input.title,
    jiraFallback: fallback,
    retrievedCount: candidates.length,
    rerankedCount: rerank.modules.length,
    precision,
    recall,
    f1: f1Score(precision, recall),
    precisionConf50,
    recallConf50,
    f1Conf50: f1Score(precisionConf50, recallConf50),
    acc5: hitAtK(rerankedPaths, realModules, 5),
    ap10: averagePrecisionAtK(rerankedPaths, realModules, 10),
    effortBucket: effort.bucket,
    realEffortProxy,
    effortMatch: effort.bucket === realEffortProxy,
    effortMedianLines: effort.medianLines,
    effortSimilarCount: effort.similarCount,
    elapsedMs: Date.now() - startedAt,
  };

  return { row, usage: rerank.usage };
}

interface BenchmarkV7Aggregate {
  tasksTotal: number;
  tasksOk: number;
  tasksFailed: number;
  meanPrecision: number;
  meanRecall: number;
  meanF1: number;
  meanPrecisionConf50: number;
  meanRecallConf50: number;
  meanF1Conf50: number;
  meanAcc5: number;
  meanAp10: number;
  effortAccuracyPct: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCalls: number;
  elapsedSeconds: number;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function computeAggregate(results: TaskResult[], elapsedSeconds: number): BenchmarkV7Aggregate {
  const ok = results.filter((r) => !r.row.error);
  const failed = results.length - ok.length;

  const totalPromptTokens = results.reduce((s, r) => s + (r.usage?.promptTokens ?? 0), 0);
  const totalCompletionTokens = results.reduce((s, r) => s + (r.usage?.completionTokens ?? 0), 0);
  const totalCalls = results.reduce((s, r) => s + (r.usage?.calls ?? 0), 0);

  const effortMatches = ok.filter((r) => r.row.effortMatch).length;

  return {
    tasksTotal: results.length,
    tasksOk: ok.length,
    tasksFailed: failed,
    meanPrecision: mean(ok.map((r) => r.row.precision)),
    meanRecall: mean(ok.map((r) => r.row.recall)),
    meanF1: mean(ok.map((r) => r.row.f1)),
    meanPrecisionConf50: mean(ok.map((r) => r.row.precisionConf50)),
    meanRecallConf50: mean(ok.map((r) => r.row.recallConf50)),
    meanF1Conf50: mean(ok.map((r) => r.row.f1Conf50)),
    meanAcc5: mean(ok.map((r) => r.row.acc5)),
    meanAp10: mean(ok.map((r) => r.row.ap10)),
    effortAccuracyPct: ok.length ? (effortMatches / ok.length) * 100 : 0,
    totalPromptTokens,
    totalCompletionTokens,
    totalCalls,
    elapsedSeconds,
  };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function toConsoleTable(rows: BenchmarkV7Row[], aggregate: BenchmarkV7Aggregate): string {
  const lines: string[] = [];
  lines.push(
    "Key".padEnd(11) +
      "P".padStart(6) +
      "R".padStart(6) +
      "F1".padStart(6) +
      "Acc@5".padStart(7) +
      "AP@10".padStart(7) +
      "  Esforço".padStart(10) +
      "  Real".padStart(7) +
      "  OK"
  );
  for (const row of rows) {
    if (row.error) {
      lines.push(`${row.key.padEnd(11)}ERRO: ${row.error}`);
      continue;
    }
    lines.push(
      row.key.padEnd(11) +
        pct(row.precision).padStart(6) +
        pct(row.recall).padStart(6) +
        pct(row.f1).padStart(6) +
        pct(row.acc5).padStart(7) +
        pct(row.ap10).padStart(7) +
        `  ${row.effortBucket}`.padStart(10) +
        `  ${row.realEffortProxy}`.padStart(7) +
        `  ${row.effortMatch ? "OK" : "X"}`
    );
  }
  lines.push("");
  lines.push(`Precisão média: ${pct(aggregate.meanPrecision)} | Recall médio: ${pct(aggregate.meanRecall)} | F1 médio: ${pct(aggregate.meanF1)}`);
  lines.push(
    `Precisão (conf>=0.5): ${pct(aggregate.meanPrecisionConf50)} | Recall (conf>=0.5): ${pct(aggregate.meanRecallConf50)} | F1 (conf>=0.5): ${pct(aggregate.meanF1Conf50)}`
  );
  lines.push(`Acc@5: ${pct(aggregate.meanAcc5)} | MAP@10: ${pct(aggregate.meanAp10)}`);
  lines.push(`Acurácia do esforço: ${aggregate.effortAccuracyPct.toFixed(1)}%`);
  lines.push(
    `Tokens: ${aggregate.totalPromptTokens} in / ${aggregate.totalCompletionTokens} out (${aggregate.totalCalls} chamadas LLM)`
  );
  lines.push(`Tempo total: ${aggregate.elapsedSeconds.toFixed(1)}s`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const deps = loadDeps();
  const tasks = loadEvalTasks(deps.taskIndex);

  const model = resolveCodexModel(process.env.TASK_RADAR_MODEL);
  console.log(
    `[benchmark-v7] ${tasks.length} tasks (${KEYS_FILE_PATH}), concorrência ${CONCURRENCY}, modelo ${model}`
  );

  let done = 0;
  const results = await mapWithConcurrency(tasks, CONCURRENCY, async (task) => {
    try {
      const result = await runOne(task, deps);
      done++;
      console.log(`[benchmark-v7] ${done}/${tasks.length} concluído: ${task.key}`);
      return result;
    } catch (err) {
      done++;
      const message = String(err instanceof Error ? err.message : err).slice(0, 200);
      console.warn(`[benchmark-v7] ${done}/${tasks.length} FALHOU: ${task.key} — ${message}`);
      const row: BenchmarkV7Row = {
        key: task.key,
        title: task.fallbackTitle,
        jiraFallback: false,
        retrievedCount: 0,
        rerankedCount: 0,
        precision: 0,
        recall: 0,
        f1: 0,
        precisionConf50: 0,
        recallConf50: 0,
        f1Conf50: 0,
        acc5: 0,
        ap10: 0,
        effortBucket: "indefinido",
        realEffortProxy: "-",
        effortMatch: false,
        effortMedianLines: null,
        effortSimilarCount: 0,
        elapsedMs: 0,
        error: message,
      };
      return { row, usage: null };
    }
  });

  const elapsedSeconds = (Date.now() - startedAt) / 1000;
  const aggregate = computeAggregate(results, elapsedSeconds);

  writeFileSync(
    OUT_FILE,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), model, concurrency: CONCURRENCY, rows: results.map((r) => r.row), aggregate },
      null,
      2
    )
  );

  console.log("");
  console.log(toConsoleTable(results.map((r) => r.row), aggregate));
  console.log("");
  console.log(`[benchmark-v7] gravado em ${OUT_FILE}`);
}

main().catch((err) => {
  console.error("[benchmark-v7] falhou:", err);
  process.exit(1);
});
