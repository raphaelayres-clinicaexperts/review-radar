import { createHmac, timingSafeEqual } from "node:crypto";
import { selfFunctionName, webhookSecret } from "./env.ts";
import { isBotLogin } from "./github-pr.ts";
import type { TaskIndexUpdateEvent, WorkerJob } from "./types.ts";

export interface WebhookHandleResult {
  statusCode: number;
  body: string;
}

interface GithubUser {
  login: string;
  type: string;
}

interface PullRequestPayload {
  action: string;
  pull_request: {
    number: number;
    draft: boolean;
    user: GithubUser;
    merged: boolean;
    merged_at: string | null;
    title: string;
    head: { ref: string };
  };
  repository: { owner: { login: string }; name: string };
}

interface IssueCommentPayload {
  action: string;
  issue: { number: number; pull_request?: unknown };
  comment: { id: number; body: string; user: GithubUser };
  repository: { owner: { login: string }; name: string };
}

const REAVALIAR_TRIGGER = "@radar reavaliar";
const HANDLED_PR_ACTIONS = new Set(["opened", "synchronize", "reopened"]);

export function verifySignature(rawBody: string, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expectedHex = createHmac("sha256", secret).update(rawBody).digest("hex");
  const expected = Buffer.from(`sha256=${expectedHex}`, "utf-8");
  const received = Buffer.from(signatureHeader, "utf-8");
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}

function jobFromPullRequest(payload: PullRequestPayload): WorkerJob | null {
  if (!HANDLED_PR_ACTIONS.has(payload.action)) return null;
  if (payload.pull_request.draft) return null;
  if (isBotLogin(payload.pull_request.user.login)) return null;
  return {
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    number: payload.pull_request.number,
    forceReeval: false,
  };
}

function jobFromIssueComment(payload: IssueCommentPayload): WorkerJob | null {
  if (payload.action !== "created") return null;
  if (!payload.issue.pull_request) return null;
  if (isBotLogin(payload.comment.user.login)) return null;
  if (!payload.comment.body.toLowerCase().includes(REAVALIAR_TRIGGER)) return null;
  return {
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    number: payload.issue.number,
    forceReeval: true,
    triggerCommentId: payload.comment.id,
  };
}

export function parseWebhookJob(eventName: string | undefined, rawBody: string): WorkerJob | null {
  if (!eventName) return null;
  const payload = JSON.parse(rawBody) as Record<string, unknown>;
  if (eventName === "pull_request") return jobFromPullRequest(payload as unknown as PullRequestPayload);
  if (eventName === "issue_comment") return jobFromIssueComment(payload as unknown as IssueCommentPayload);
  return null;
}

interface CheckSuitePayload {
  action: string;
  check_suite: { pull_requests: Array<{ number: number }> };
  repository: { owner: { login: string }; name: string };
}

export function taskIndexEventFromPullRequest(
  eventName: string | undefined,
  rawBody: string
): TaskIndexUpdateEvent | null {
  if (eventName !== "pull_request") return null;
  const payload = JSON.parse(rawBody) as unknown as PullRequestPayload;
  if (payload.action !== "closed" || !payload.pull_request.merged) return null;
  return {
    mode: "task-index",
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    number: payload.pull_request.number,
    title: payload.pull_request.title,
    branch: payload.pull_request.head.ref,
    mergedAt: payload.pull_request.merged_at ?? new Date().toISOString(),
  };
}

export function ciUpdatesFromCheckSuite(
  eventName: string | undefined,
  rawBody: string
): Array<{ owner: string; repo: string; number: number }> {
  if (eventName !== "check_suite") return [];
  const payload = JSON.parse(rawBody) as unknown as CheckSuitePayload;
  if (payload.action !== "completed") return [];
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  return (payload.check_suite.pull_requests ?? []).map((pr) => ({ owner, repo, number: pr.number }));
}

async function selfInvoke(payload: Record<string, unknown>): Promise<void> {
  const functionName = selfFunctionName();
  if (!functionName) {
    const { handler } = await import("./handler.ts");
    await handler(payload as never).catch((err) =>
      console.error("[webhook] execução inline falhou:", err)
    );
    return;
  }
  const { LambdaClient, InvokeCommand } = await import("@aws-sdk/client-lambda");
  const client = new LambdaClient({});
  await client.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify(payload)),
    })
  );
}

async function selfInvokeWorker(job: WorkerJob): Promise<void> {
  await selfInvoke({ mode: "worker", ...job });
}

export async function handleWebhook(
  rawBody: string,
  headers: Record<string, string | undefined>
): Promise<WebhookHandleResult> {
  const signature = headers["x-hub-signature-256"] ?? headers["X-Hub-Signature-256"];
  if (!verifySignature(rawBody, signature, webhookSecret())) {
    return { statusCode: 401, body: JSON.stringify({ error: "assinatura inválida" }) };
  }

  const eventName = headers["x-github-event"] ?? headers["X-GitHub-Event"];

  let job: WorkerJob | null;
  let ciUpdates: Array<{ owner: string; repo: string; number: number }>;
  let taskIndexEvent: TaskIndexUpdateEvent | null;
  try {
    job = parseWebhookJob(eventName, rawBody);
    ciUpdates = ciUpdatesFromCheckSuite(eventName, rawBody);
    taskIndexEvent = taskIndexEventFromPullRequest(eventName, rawBody);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "payload inválido" }) };
  }

  if (ciUpdates.length) {
    for (const update of ciUpdates) {
      await selfInvoke({ mode: "ci-update", ...update }).catch((err) =>
        console.warn("[webhook] ci-update invoke falhou:", String(err).slice(0, 150))
      );
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, ciUpdates: ciUpdates.length }) };
  }

  if (taskIndexEvent) {
    await selfInvoke({ ...taskIndexEvent }).catch((err) =>
      console.warn("[webhook] task-index invoke falhou:", String(err).slice(0, 150))
    );
    return { statusCode: 200, body: JSON.stringify({ ok: true, taskIndexed: true }) };
  }

  if (!job) return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: true }) };

  await selfInvokeWorker(job);

  if (job.triggerCommentId) {
    await acknowledgeTrigger(job, job.triggerCommentId).catch((err) =>
      console.warn("[webhook] reação 👀 falhou:", String(err).slice(0, 150))
    );
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, queued: job }) };
}

async function acknowledgeTrigger(job: WorkerJob, commentId: number): Promise<void> {
  const { appAuthConfigured, installationToken } = await import("./github-app-auth.ts");
  if (appAuthConfigured()) {
    process.env.GITHUB_TOKEN = await installationToken(job.owner, job.repo);
  }
  const { reactToComment } = await import("./github-pr.ts");
  await reactToComment(job.owner, job.repo, commentId, "eyes");
}
