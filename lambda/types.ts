import type { TokenData } from "../src/services/tokens.ts";
import type { RadarResult } from "../src/radar/types.ts";
import type { GabiReviewResult } from "../src/reviewer/types.ts";
import type { ReviewCostSummary } from "../src/services/review-cost.ts";

export type { TokenData };

export interface WorkerJob {
  owner: string;
  repo: string;
  number: number;
  forceReeval: boolean;
  triggerCommentId?: number;
}

export interface StoredReview {
  pr: string;
  headSha: string;
  route: string;
  savedAt: string;
  radar: RadarResult | null;
  review: GabiReviewResult | null;
  cost: ReviewCostSummary;
}

export interface TaskFeedbackEntry {
  taskText: string;
  modulePath: string;
  verdict: "up" | "down";
  user: string;
  at: string;
}

export interface TaskAnalysisModule {
  path: string;
  confidence: number;
  why: string;
}

export interface TaskAnalysisSimilarRef {
  key: string | null;
  pr: number;
  score: number;
}

export interface TaskAnalysisEntry {
  key: string | null;
  title: string;
  issueType: string | null;
  analyzedAt: string;
  modules: TaskAnalysisModule[];
  technicalSummary: string[];
  similars: TaskAnalysisSimilarRef[];
  medianLines: number | null;
  duplicateSuspect: boolean;
  tokens: number;
}

export interface RunRecord {
  pr: string;
  title: string;
  route: string;
  suggestions: number;
  tokens: number;
  aiOk: boolean;
  at: string;
  durationMs?: number;
  costUSD?: number;
}

export interface FunctionUrlEvent {
  version?: string;
  rawPath?: string;
  rawQueryString?: string;
  headers: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: {
    http: { method: string };
  };
}

export interface CiUpdateEvent {
  mode: "ci-update";
  owner: string;
  repo: string;
  number: number;
}

export interface WorkerInvokeEvent extends WorkerJob {
  mode: "worker";
}

export interface TaskIndexFile {
  f: string;
  add: number;
  del: number;
}

export interface TaskIndexEntry {
  key: string | null;
  pr: number;
  title: string;
  mergedAt: string;
  branch: string;
  files: TaskIndexFile[];
}

export const JIRA_KEY_PATTERN = /[A-Z][A-Z0-9]+-\d+/;

export function extractJiraKey(branch: string, title: string): string | null {
  return `${branch} ${title}`.match(JIRA_KEY_PATTERN)?.[0] ?? null;
}

export interface TaskIndexUpdateEvent {
  mode: "task-index";
  owner: string;
  repo: string;
  number: number;
  title: string;
  branch: string;
  mergedAt: string;
}

export interface RefreshArtifactsEvent {
  mode: "refresh-artifacts";
}

export type LambdaEvent =
  | FunctionUrlEvent
  | WorkerInvokeEvent
  | CiUpdateEvent
  | TaskIndexUpdateEvent
  | RefreshArtifactsEvent;

export function isCiUpdateEvent(event: LambdaEvent): event is CiUpdateEvent {
  return (event as CiUpdateEvent).mode === "ci-update";
}

export function isTaskIndexUpdateEvent(event: LambdaEvent): event is TaskIndexUpdateEvent {
  return (event as TaskIndexUpdateEvent).mode === "task-index";
}

export function isRefreshArtifactsEvent(event: LambdaEvent): event is RefreshArtifactsEvent {
  return (event as RefreshArtifactsEvent).mode === "refresh-artifacts";
}

export interface FunctionUrlResult {
  statusCode: number;
  body: string;
  headers?: Record<string, string>;
}

export function isWorkerInvokeEvent(event: LambdaEvent): event is WorkerInvokeEvent {
  return (event as WorkerInvokeEvent).mode === "worker";
}
