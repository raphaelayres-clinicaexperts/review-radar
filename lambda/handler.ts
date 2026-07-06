import { join } from "node:path";
import { storeMode } from "./env.ts";
import { handleWebhook } from "./webhook.ts";
import { createStore } from "./store.ts";
import { runWorker } from "./worker.ts";
import {
  extractJiraKey,
  isCiUpdateEvent,
  isRefreshArtifactsEvent,
  isTaskIndexUpdateEvent,
  isWorkerInvokeEvent,
} from "./types.ts";
import type { RefreshArtifactsStats } from "./refresh-artifacts.ts";
import { buildStats } from "./stats.ts";
import { fetchCI, fetchPR } from "../src/radar/github.ts";
import { ciLabel } from "../src/radar/report.ts";
import { isGeneratedFile, updateCiRow } from "./github-pr.ts";
import { appAuthConfigured, installationToken } from "./github-app-auth.ts";
import { ensureTaskRadarArtifacts } from "./task-radar-artifacts.ts";
import type {
  FunctionUrlEvent,
  FunctionUrlResult,
  LambdaEvent,
  TaskAnalysisEntry,
  TaskFeedbackEntry,
  TaskIndexEntry,
} from "./types.ts";
import type { TaskInput } from "../scripts/task-radar/types.ts";

const JSON_CORS_HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

const TASK_ANALYZE_MIN_CONFIDENCE = Number(process.env.TASK_ANALYZE_MIN_CONFIDENCE ?? "0.4");
const DUPLICATE_SUSPECT_THRESHOLD = 0.5;
const TASK_ANALYSES_LIST_LIMIT = 50;

function decodeBody(event: FunctionUrlEvent): string {
  if (!event.body) return "";
  return event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf-8") : event.body;
}

async function handleStats(event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  const key = new URLSearchParams(event.rawQueryString ?? "").get("key");
  if (!process.env.STATS_KEY || key !== process.env.STATS_KEY) {
    return { statusCode: 401, body: JSON.stringify({ error: "unauthorized" }) };
  }
  const stats = await buildStats(createStore(storeMode()));
  return {
    statusCode: 200,
    body: JSON.stringify(stats),
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  };
}

interface TaskAnalyzeBody {
  text?: unknown;
  key?: unknown;
  title?: unknown;
  issueType?: unknown;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function handleTaskAnalyze(event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  const key = new URLSearchParams(event.rawQueryString ?? "").get("key");
  if (!process.env.STATS_KEY || key !== process.env.STATS_KEY) {
    return { statusCode: 401, body: JSON.stringify({ error: "unauthorized" }) };
  }
  if (event.requestContext.http.method !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "method_not_allowed" }), headers: JSON_CORS_HEADERS };
  }

  let text: string | undefined;
  let taskKey: string | null = null;
  let taskTitle: string | null = null;
  let taskIssueType: string | null = null;
  try {
    const raw = decodeBody(event);
    const parsed = raw ? (JSON.parse(raw) as TaskAnalyzeBody) : {};
    text = typeof parsed.text === "string" ? parsed.text.trim() : undefined;
    taskKey = optionalString(parsed.key);
    taskTitle = optionalString(parsed.title);
    taskIssueType = optionalString(parsed.issueType);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "invalid_json" }), headers: JSON_CORS_HEADERS };
  }

  if (taskKey) {
    try {
      const { fetchJiraTaskInput } = await import("../scripts/task-radar/jira-issue.ts");
      const jiraInput = await fetchJiraTaskInput(taskKey);
      text = jiraInput.description || text;
      taskTitle = jiraInput.title ?? taskTitle;
      taskIssueType = jiraInput.issueType ?? taskIssueType;
    } catch (err) {
      console.error(
        `[task-analyze] fetchJiraTaskInput(${taskKey}) falhou, usando fallback do payload:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  if (!text) {
    return { statusCode: 400, body: JSON.stringify({ error: "missing_text" }), headers: JSON_CORS_HEADERS };
  }

  try {
    const dataDir = await ensureTaskRadarArtifacts();

    const [{ retrieveModules }, { rerankModules }, { estimateEffort }, { loadTaskIndex, rankSimilarTasks }, { loadProjectMap }] =
      await Promise.all([
        import("../scripts/task-radar-v7/retrieve.ts"),
        import("../scripts/task-radar-v7/rerank.ts"),
        import("../scripts/task-radar-v7/effort.ts"),
        import("../scripts/task-radar/task-index.ts"),
        import("../scripts/task-radar/project-map.ts"),
      ]);

    const taskIndex = loadTaskIndex(join(dataDir, "task-index.json"));
    const projectMap = loadProjectMap(join(dataDir, "project-map.json"));

    const task: TaskInput = { key: taskKey, title: text, description: "", issueType: taskIssueType };
    const candidates = await retrieveModules(text);
    const store = createStore(storeMode());
    const rerankResult = await rerankModules(store, task, candidates);
    const similars = rankSimilarTasks(text, taskIndex, projectMap.modules, { topN: 10 }).filter((s) => s.score > 0);
    const effort = estimateEffort(text, taskIndex);
    const modules = rerankResult.modules.filter((m) => m.confidence >= TASK_ANALYZE_MIN_CONFIDENCE);

    const analysisEntry: TaskAnalysisEntry = {
      key: taskKey,
      title: (taskTitle ?? text).slice(0, 120),
      issueType: taskIssueType,
      analyzedAt: new Date().toISOString(),
      modules,
      technicalSummary: rerankResult.technicalSummary,
      similars: similars.slice(0, 3).map((s) => ({ key: s.key, pr: s.pr, score: s.score })),
      medianLines: effort.medianLines,
      duplicateSuspect: (similars[0]?.score ?? 0) >= DUPLICATE_SUSPECT_THRESHOLD,
      tokens: rerankResult.usage.promptTokens + rerankResult.usage.completionTokens,
    };
    await store.saveTaskAnalysis(analysisEntry);

    const body = {
      modules,
      technicalSummary: rerankResult.technicalSummary,
      similars,
      medianLines: effort.medianLines,
      effortBucket: effort.bucket,
    };
    return { statusCode: 200, body: JSON.stringify(body), headers: JSON_CORS_HEADERS };
  } catch (err) {
    const message = err instanceof Error ? err.message : "task_analyze_failed";
    console.error("[task-analyze] falhou:", message, err instanceof Error ? err.stack : "");
    return { statusCode: 500, body: JSON.stringify({ error: message }), headers: JSON_CORS_HEADERS };
  }
}

async function handleTaskAnalyses(event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  const key = new URLSearchParams(event.rawQueryString ?? "").get("key");
  if (!process.env.STATS_KEY || key !== process.env.STATS_KEY) {
    return { statusCode: 401, body: JSON.stringify({ error: "unauthorized" }) };
  }
  if (event.requestContext.http.method !== "GET") {
    return { statusCode: 405, body: JSON.stringify({ error: "method_not_allowed" }), headers: JSON_CORS_HEADERS };
  }

  try {
    const store = createStore(storeMode());
    const analyses = await store.listTaskAnalyses(TASK_ANALYSES_LIST_LIMIT);
    return { statusCode: 200, body: JSON.stringify({ analyses }), headers: JSON_CORS_HEADERS };
  } catch (err) {
    const message = err instanceof Error ? err.message : "task_analyses_failed";
    console.error("[task-analyses] falhou:", message, err instanceof Error ? err.stack : "");
    return { statusCode: 500, body: JSON.stringify({ error: message }), headers: JSON_CORS_HEADERS };
  }
}

interface TaskFeedbackBody {
  taskText?: unknown;
  modulePath?: unknown;
  verdict?: unknown;
  user?: unknown;
}

async function handleTaskFeedbackPost(event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  let raw: TaskFeedbackBody;
  try {
    const decoded = decodeBody(event);
    raw = decoded ? (JSON.parse(decoded) as TaskFeedbackBody) : {};
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "invalid_json" }), headers: JSON_CORS_HEADERS };
  }

  const taskText = typeof raw.taskText === "string" ? raw.taskText.slice(0, 200) : "";
  const modulePath = typeof raw.modulePath === "string" ? raw.modulePath.trim() : "";
  const verdict = raw.verdict === "up" || raw.verdict === "down" ? raw.verdict : undefined;
  const user = typeof raw.user === "string" ? raw.user.trim() : "";

  if (!modulePath || !verdict) {
    return { statusCode: 400, body: JSON.stringify({ error: "invalid_feedback" }), headers: JSON_CORS_HEADERS };
  }

  const entry: TaskFeedbackEntry = { taskText, modulePath, verdict, user, at: new Date().toISOString() };
  const store = createStore(storeMode());
  await store.saveTaskFeedback(entry);
  return { statusCode: 200, body: JSON.stringify({ ok: true }), headers: JSON_CORS_HEADERS };
}

async function handleTaskFeedbackGet(): Promise<FunctionUrlResult> {
  const store = createStore(storeMode());
  const entries = await store.listTaskFeedback();

  const byModule = new Map<string, { modulePath: string; ups: number; downs: number }>();
  for (const entry of entries) {
    const agg = byModule.get(entry.modulePath) ?? { modulePath: entry.modulePath, ups: 0, downs: 0 };
    if (entry.verdict === "up") agg.ups += 1;
    else agg.downs += 1;
    byModule.set(entry.modulePath, agg);
  }
  const aggregate = [...byModule.values()].sort((a, b) => b.ups + b.downs - (a.ups + a.downs));
  const recent = [...entries].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50);

  return {
    statusCode: 200,
    body: JSON.stringify({ aggregate, recent }),
    headers: JSON_CORS_HEADERS,
  };
}

async function handleTaskFeedback(event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  const key = new URLSearchParams(event.rawQueryString ?? "").get("key");
  if (!process.env.STATS_KEY || key !== process.env.STATS_KEY) {
    return { statusCode: 401, body: JSON.stringify({ error: "unauthorized" }) };
  }

  try {
    const method = event.requestContext.http.method;
    if (method === "POST") return await handleTaskFeedbackPost(event);
    if (method === "GET") return await handleTaskFeedbackGet();
    return { statusCode: 405, body: JSON.stringify({ error: "method_not_allowed" }), headers: JSON_CORS_HEADERS };
  } catch (err) {
    const message = err instanceof Error ? err.message : "task_feedback_failed";
    console.error("[task-feedback] falhou:", message, err instanceof Error ? err.stack : "");
    return { statusCode: 500, body: JSON.stringify({ error: message }), headers: JSON_CORS_HEADERS };
  }
}

export async function handler(
  event: LambdaEvent
): Promise<FunctionUrlResult | { ok: true } | { ok: true; stats: RefreshArtifactsStats }> {
  if (isRefreshArtifactsEvent(event)) {
    const { refreshArtifacts } = await import("./refresh-artifacts.ts");
    const stats = await refreshArtifacts();
    return { ok: true, stats };
  }

  if (isCiUpdateEvent(event)) {
    if (appAuthConfigured()) {
      process.env.GITHUB_TOKEN = await installationToken(event.owner, event.repo);
    }
    const pr = await fetchPR(event.owner, event.repo, event.number);
    const ci = await fetchCI(event.owner, event.repo, pr.headSha);
    const updated = await updateCiRow(event.owner, event.repo, event.number, ciLabel(ci.state, ci.failing));
    console.log(`[ci-update] ${event.owner}/${event.repo}#${event.number} → ${ci.state} (${updated ? "atualizado" : "sem bloco"})`);
    return { ok: true };
  }

  if (isTaskIndexUpdateEvent(event)) {
    if (appAuthConfigured()) {
      process.env.GITHUB_TOKEN = await installationToken(event.owner, event.repo);
    }
    const pr = await fetchPR(event.owner, event.repo, event.number);
    const files = pr.files
      .filter((f) => !isGeneratedFile(f.filename))
      .map((f) => ({ f: f.filename, add: f.additions, del: f.deletions }));
    const entry: TaskIndexEntry = {
      key: extractJiraKey(event.branch, event.title),
      pr: event.number,
      title: event.title,
      mergedAt: event.mergedAt,
      branch: event.branch,
      files,
    };
    const store = createStore(storeMode());
    await store.saveTaskIndexEntry(entry);
    console.log(`[task-index] ${event.owner}/${event.repo}#${event.number} indexado (key=${entry.key ?? "null"})`);
    return { ok: true };
  }

  if (isWorkerInvokeEvent(event)) {
    const store = createStore(storeMode());
    const result = await runWorker(
      {
        owner: event.owner,
        repo: event.repo,
        number: event.number,
        forceReeval: event.forceReeval,
        triggerCommentId: event.triggerCommentId,
      },
      store
    );
    console.log(`[worker] ${event.owner}/${event.repo}#${event.number}`, JSON.stringify(result));
    return { ok: true };
  }

  if (event.rawPath === "/stats" && event.requestContext.http.method === "GET") {
    return handleStats(event);
  }

  if (event.rawPath === "/task-analyze") {
    return handleTaskAnalyze(event);
  }

  if (event.rawPath === "/task-analyses") {
    return handleTaskAnalyses(event);
  }

  if (event.rawPath === "/task-feedback") {
    return handleTaskFeedback(event);
  }

  const rawBody = decodeBody(event);
  const result = await handleWebhook(rawBody, event.headers);
  return {
    statusCode: result.statusCode,
    body: result.body,
    headers: { "Content-Type": "application/json" },
  };
}
