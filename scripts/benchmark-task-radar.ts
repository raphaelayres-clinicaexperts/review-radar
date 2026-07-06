import { writeFileSync } from "node:fs";
import { FsStore } from "../lambda/store.ts";
import { selectBenchmarkTasks } from "./task-radar/benchmark-selection.ts";
import type { BenchmarkTask } from "./task-radar/benchmark-selection.ts";
import type { BenchmarkAggregate, BenchmarkTaskRow } from "./task-radar/benchmark-report.ts";
import { toMarkdownTable } from "./task-radar/benchmark-report.ts";
import { mapWithConcurrency } from "./task-radar/concurrency.ts";
import { JiraNotFoundError, fetchJiraTaskInput } from "./task-radar/jira-issue.ts";
import { difficultyFromLines, precisionRecall, sumChangedLines } from "./task-radar/metrics.ts";
import { deriveModulePaths } from "./task-radar/project-map.ts";
import { loadPipelineDeps, analyzeTask } from "./task-radar/pipeline.ts";
import type { PipelineDeps } from "./task-radar/pipeline.ts";
import { resolveCodexModel } from "../src/services/model-resolve.ts";
import type { PipelineUsage, TaskIndexFile, TaskInput } from "./task-radar/types.ts";

const CONCURRENCY = Number(process.env.CONCURRENCY_BENCHMARK ?? 3);
const TASK_COUNT = 20;
// Default preservado (v5). Passe BENCHMARK_OUT_FILE para gravar em outro arquivo (ex.: v6) sem
// sobrescrever os benchmarks anteriores.
const OUT_FILE = process.env.BENCHMARK_OUT_FILE?.trim() || "task-benchmark-v5.json";
const HIGH_CONFIDENCE_CUTOFF = 0.5;

interface TaskResult {
  row: BenchmarkTaskRow;
  usage: PipelineUsage;
}

function aggregatedFiles(task: BenchmarkTask): TaskIndexFile[] {
  return task.allEntries.flatMap((entry) => entry.files);
}

async function resolveTaskInput(task: BenchmarkTask): Promise<{ input: TaskInput; fallback: boolean }> {
  try {
    const input = await fetchJiraTaskInput(task.key);
    return { input, fallback: false };
  } catch (err) {
    if (!(err instanceof JiraNotFoundError)) {
      console.warn(`[benchmark] ${task.key}: Jira falhou (${String(err).slice(0, 120)}), usando título do PR`);
    }
    const input: TaskInput = {
      key: task.key,
      title: task.representativeEntry.title,
      description: "",
      issueType: null,
    };
    return { input, fallback: true };
  }
}

async function runOne(task: BenchmarkTask, deps: PipelineDeps): Promise<TaskResult> {
  const store = new FsStore();
  const { input, fallback } = await resolveTaskInput(task);

  const excludeKeys = new Set([task.key]);
  const excludePrs = new Set(task.allEntries.map((e) => e.pr));

  const result = await analyzeTask(store, input, deps, { excludeKeys, excludePrs });

  const files = aggregatedFiles(task);
  const realModules = deriveModulePaths(files, deps.projectMap);

  const predictedModulesAll = result.analysis.modules.map((m) => m.path);
  const { precision, recall } = precisionRecall(predictedModulesAll, realModules);

  const predictedModulesHighConf = result.analysis.modules
    .filter((m) => m.confidence >= HIGH_CONFIDENCE_CUTOFF)
    .map((m) => m.path);
  const { precision: precisionConf50, recall: recallConf50 } = precisionRecall(
    predictedModulesHighConf,
    realModules
  );

  const realDifficulty = difficultyFromLines(sumChangedLines(files));
  const predictedDifficulty = result.analysis.difficulty;

  const row: BenchmarkTaskRow = {
    key: task.key,
    title: input.title,
    jiraFallback: fallback,
    precision,
    recall,
    precisionConf50,
    recallConf50,
    predictedDifficulty,
    realDifficultyProxy: realDifficulty,
    difficultyMatch: predictedDifficulty === realDifficulty,
    difficultySource: result.difficultySource,
    similarCount: result.difficultySimilarCount,
  };

  return { row, usage: result.usage };
}

function computeAggregate(
  results: Array<TaskResult | { row: BenchmarkTaskRow; usage: null }>,
  elapsedSeconds: number
): BenchmarkAggregate {
  const ok = results.filter((r) => !r.row.error);
  const failed = results.length - ok.length;

  const meanPrecision = ok.length ? ok.reduce((s, r) => s + r.row.precision, 0) / ok.length : 0;
  const meanRecall = ok.length ? ok.reduce((s, r) => s + r.row.recall, 0) / ok.length : 0;
  const meanPrecisionConf50 = ok.length
    ? ok.reduce((s, r) => s + (r.row.precisionConf50 ?? 0), 0) / ok.length
    : 0;
  const meanRecallConf50 = ok.length
    ? ok.reduce((s, r) => s + (r.row.recallConf50 ?? 0), 0) / ok.length
    : 0;
  const difficultyMatches = ok.filter((r) => r.row.difficultyMatch).length;
  const difficultyAccuracyPct = ok.length ? (difficultyMatches / ok.length) * 100 : 0;

  const difficultySourceCounts: Record<string, number> = {};
  for (const r of ok) {
    const source = r.row.difficultySource ?? "unknown";
    difficultySourceCounts[source] = (difficultySourceCounts[source] ?? 0) + 1;
  }

  const tasksWithSufficientSimilars = ok.filter((r) => (r.row.similarCount ?? 0) >= 2).length;

  const totalPromptTokens = results.reduce((s, r) => s + (r.usage?.promptTokens ?? 0), 0);
  const totalCompletionTokens = results.reduce((s, r) => s + (r.usage?.completionTokens ?? 0), 0);
  const totalCalls = results.reduce((s, r) => s + (r.usage?.calls ?? 0), 0);

  return {
    tasksTotal: results.length,
    tasksOk: ok.length,
    tasksFailed: failed,
    meanPrecision,
    meanRecall,
    meanPrecisionConf50,
    meanRecallConf50,
    difficultyAccuracyPct,
    difficultySourceCounts,
    tasksWithSufficientSimilars,
    totalPromptTokens,
    totalCompletionTokens,
    totalCalls,
    elapsedSeconds,
  };
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const deps = loadPipelineDeps();
  const tasks = selectBenchmarkTasks(deps.taskIndex, TASK_COUNT);

  const model = resolveCodexModel(process.env.TASK_RADAR_MODEL);
  console.log(
    `[benchmark] ${tasks.length} tasks selecionadas, concorrência ${CONCURRENCY}, modelo ${model}`
  );

  let done = 0;
  const results = await mapWithConcurrency(tasks, CONCURRENCY, async (task) => {
    try {
      const result = await runOne(task, deps);
      done++;
      console.log(`[benchmark] ${done}/${tasks.length} concluído: ${task.key}`);
      return result;
    } catch (err) {
      done++;
      const message = String(err instanceof Error ? err.message : err).slice(0, 200);
      console.warn(`[benchmark] ${done}/${tasks.length} FALHOU: ${task.key} — ${message}`);
      const row: BenchmarkTaskRow = {
        key: task.key,
        title: task.representativeEntry.title,
        jiraFallback: false,
        precision: 0,
        recall: 0,
        precisionConf50: 0,
        recallConf50: 0,
        predictedDifficulty: "-",
        realDifficultyProxy: "-",
        difficultyMatch: false,
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
      { generatedAt: new Date().toISOString(), model, rows: results.map((r) => r.row), aggregate },
      null,
      2
    )
  );

  console.log("");
  console.log(toMarkdownTable(results.map((r) => r.row), aggregate));
  console.log("");
  console.log(`[benchmark] gravado em ${OUT_FILE}`);
}

main().catch((err) => {
  console.error("[benchmark] falhou:", err);
  process.exit(1);
});
