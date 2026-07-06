import type { Store } from "../../lambda/store.ts";
import { runCall1, runCall2 } from "./codex-analysis.ts";
import type { ModuleWithSummary } from "./codex-analysis.ts";
import { computeHybridDifficulty } from "./difficulty-hybrid.ts";
import { fetchFilesAtMain } from "./github-content.ts";
import {
  condenseProjectMapMarkdown,
  loadProjectMap,
  loadProjectMapMarkdown,
  moduleByPath,
} from "./project-map.ts";
import { loadTaskIndex, rankSimilarTasks } from "./task-index.ts";
import type { SimilarTaskRef } from "./types.ts";
import type { PipelineResult, PipelineUsage, ProjectModule, TaskIndexEntry, TaskInput } from "./types.ts";

const SIMILAR_TASKS_TOP_N = 15;
const SIMILAR_TASKS_FALLBACK_FOR_CALL2 = 3;

export interface PipelineDeps {
  projectMap: ProjectModule[];
  projectMapMarkdown: string;
  taskIndex: TaskIndexEntry[];
}

export function loadPipelineDeps(): PipelineDeps {
  return {
    projectMap: loadProjectMap().modules,
    projectMapMarkdown: loadProjectMapMarkdown(),
    taskIndex: loadTaskIndex(),
  };
}

export interface AnalyzeTaskOptions {
  excludeKeys?: Set<string>;
  excludePrs?: Set<number>;
  fetchCode?: boolean;
}

function pickSimilarTasksForCall2(
  similarTasksUsed: SimilarTaskRef[],
  flaggedKeys: Array<string | null>
): SimilarTaskRef[] {
  const flagged = new Set(flaggedKeys.filter((k): k is string => typeof k === "string" && k.trim() !== ""));
  const relevant = similarTasksUsed.filter((s) => s.key && flagged.has(s.key));
  return relevant.length > 0 ? relevant : similarTasksUsed.slice(0, SIMILAR_TASKS_FALLBACK_FOR_CALL2);
}

function sumUsage(a: PipelineUsage, b: PipelineUsage): PipelineUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    calls: a.calls + b.calls,
  };
}

export async function analyzeTask(
  store: Store,
  task: TaskInput,
  deps: PipelineDeps,
  options: AnalyzeTaskOptions = {}
): Promise<PipelineResult> {
  const similarTasksUsed = rankSimilarTasks(task.title, deps.taskIndex, deps.projectMap, {
    excludeKeys: options.excludeKeys,
    excludePrs: options.excludePrs,
    topN: SIMILAR_TASKS_TOP_N,
  }).filter((s) => s.score > 0);

  const { result: call1, usage: usage1 } = await runCall1(store, {
    task,
    projectMapMarkdown: condenseProjectMapMarkdown(deps.projectMapMarkdown),
    similarTasks: similarTasksUsed,
  });

  const shouldFetchCode = options.fetchCode ?? true;
  const codeSnippets = shouldFetchCode ? await fetchFilesAtMain(call1.needsCode) : [];

  const candidateModules: ModuleWithSummary[] = call1.candidateModules.map((c) => ({
    path: c.path,
    reason: c.reason,
    summary: moduleByPath(c.path, deps.projectMap)?.summary ?? "",
  }));

  const similarTasksForCall2 = pickSimilarTasksForCall2(similarTasksUsed, call1.similarTasks);

  const { result: rawAnalysis, usage: usage2 } = await runCall2(store, {
    task,
    candidateModules,
    codeSnippets,
    similarTasks: similarTasksForCall2,
  });

  // Dificuldade FINAL (v4): calculada mecanicamente pela mediana de linhas dos PRs das
  // top-5 tasks similares (excluindo a própria key, para não vazar dado do gabarito no
  // benchmark). O palpite do modelo (rawAnalysis.difficulty) só decide quando não há
  // similares suficientes, ou amortece divergências extremas (P vs G) para M.
  const excludeKeysForDifficulty = new Set(options.excludeKeys ?? []);
  if (task.key) excludeKeysForDifficulty.add(task.key);
  const hybrid = computeHybridDifficulty(
    task.title,
    deps.taskIndex,
    rawAnalysis.difficulty,
    excludeKeysForDifficulty
  );
  const analysis = { ...rawAnalysis, difficulty: hybrid.difficulty };

  return {
    task,
    similarTasksUsed,
    call1,
    codeSnippets,
    analysis,
    usage: sumUsage(usage1, usage2),
    difficultySource: hybrid.source,
    difficultyMedianLines: hybrid.medianLines,
    difficultySimilarCount: hybrid.similarCount,
  };
}
