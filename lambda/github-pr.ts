import type { PR } from "../src/radar/types.ts";
import { githubToken } from "./env.ts";

const GH = "https://api.github.com";

function ghHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${githubToken()}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "codex-integration-radar-lambda",
  };
}

async function ghJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${GH}${path}`, { ...init, headers: { ...ghHeaders(), ...(init?.headers ?? {}) } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub ${init?.method ?? "GET"} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const BODY_MARKER_START = "<!-- radar:start -->";
export const BODY_MARKER_END = "<!-- radar:end -->";
export const COMMENT_MARKER = "<!-- radar:comment -->";
export const SUMMARY_MARKER_START = "<!-- radar:summary:start -->";
export const SUMMARY_MARKER_END = "<!-- radar:summary:end -->";
export const JIRA_MARKER = "<!-- radar:jira -->";

export async function fetchPrLabels(owner: string, repo: string, number: number): Promise<string[]> {
  const pr = await ghJson<{ labels?: Array<{ name: string }> }>(
    `/repos/${owner}/${repo}/pulls/${number}`
  );
  return (pr.labels ?? []).map((l) => l.name);
}

export function isBotLogin(login: string): boolean {
  return login.toLowerCase().includes("[bot]");
}

export function hasSkipLabel(labels: string[]): boolean {
  return labels.some((l) => l.toLowerCase() === "skip-radar");
}

function replaceMarkedSection(body: string, section: string): string {
  const start = body.indexOf(BODY_MARKER_START);
  const end = body.indexOf(BODY_MARKER_END);
  const block = `${BODY_MARKER_START}\n${section}\n${BODY_MARKER_END}`;
  if (start === -1 || end === -1 || end < start) {
    const separator = body.trim().length ? "\n\n" : "";
    return `${body}${separator}${block}`;
  }
  const before = body.slice(0, start);
  const after = body.slice(end + BODY_MARKER_END.length);
  return `${before}${block}${after}`;
}

function prependBlock(body: string, block: string): string {
  const rest = body.trim().length ? `\n\n${body}` : "";
  return `${block}${rest}`;
}

function insertSummarySection(body: string, summary: string): string {
  if (!summary || body.includes(SUMMARY_MARKER_START)) return body;
  const block = `${SUMMARY_MARKER_START}\n### 📝 Resumo\n${summary}\n${SUMMARY_MARKER_END}`;
  return prependBlock(body, block);
}

function insertJiraLine(body: string, jiraLine: string): string {
  if (!jiraLine || body.includes(JIRA_MARKER)) return body;
  return prependBlock(body, `${JIRA_MARKER}\n${jiraLine}`);
}

export async function patchPrBody(
  owner: string,
  repo: string,
  number: number,
  section: string,
  summary = "",
  jiraLine = ""
): Promise<void> {
  const attempt = async (): Promise<void> => {
    const pr = await ghJson<{ body: string | null }>(`/repos/${owner}/${repo}/pulls/${number}`);
    const withSummary = insertSummarySection(pr.body ?? "", summary);
    const withJira = insertJiraLine(withSummary, jiraLine);
    const nextBody = replaceMarkedSection(withJira, section);
    await ghJson(`/repos/${owner}/${repo}/pulls/${number}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: nextBody }),
    });
  };

  try {
    await attempt();
  } catch (err) {
    await attempt().catch(() => {
      throw err;
    });
  }
}

interface IssueComment {
  id: number;
  body: string;
}

async function findExistingComment(
  owner: string,
  repo: string,
  number: number
): Promise<IssueComment | null> {
  for (let page = 1; ; page++) {
    const comments = await ghJson<IssueComment[]>(
      `/repos/${owner}/${repo}/issues/${number}/comments?per_page=100&page=${page}`
    );
    const found = comments.find((c) => c.body.includes(COMMENT_MARKER));
    if (found) return found;
    if (comments.length < 100) return null;
  }
}

export async function prBodyHasSummary(owner: string, repo: string, number: number): Promise<boolean> {
  const pr = await ghJson<{ body: string | null }>(`/repos/${owner}/${repo}/pulls/${number}`);
  return (pr.body ?? "").includes(SUMMARY_MARKER_START);
}

export async function reactToComment(
  owner: string,
  repo: string,
  commentId: number,
  content: "eyes" | "+1"
): Promise<void> {
  await ghJson(`/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
}

export async function updateCiRow(
  owner: string,
  repo: string,
  number: number,
  label: string
): Promise<boolean> {
  const pr = await ghJson<{ body: string | null }>(`/repos/${owner}/${repo}/pulls/${number}`);
  const body = pr.body ?? "";
  if (!body.includes(BODY_MARKER_START)) return false;
  const nextBody = body.replace(/\| \*\*CI\*\* \| [^|\n]* \|/, `| **CI** | ${label} |`);
  if (nextBody === body) return false;
  await ghJson(`/repos/${owner}/${repo}/pulls/${number}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body: nextBody }),
  });
  return true;
}

export async function deleteRadarComment(
  owner: string,
  repo: string,
  number: number
): Promise<void> {
  const existing = await findExistingComment(owner, repo, number);
  if (!existing) return;
  await ghJson(`/repos/${owner}/${repo}/issues/comments/${existing.id}`, { method: "DELETE" });
}

export async function upsertComment(
  owner: string,
  repo: string,
  number: number,
  markdown: string
): Promise<void> {
  const body = `${COMMENT_MARKER}\n${markdown}`;
  const existing = await findExistingComment(owner, repo, number);
  if (existing) {
    await ghJson(`/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    return;
  }
  await ghJson(`/repos/${owner}/${repo}/issues/${number}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });
}

export interface DiffCapResult {
  pr: PR;
  truncated: boolean;
  ignoredGenerated: string[];
}

const GENERATED_FILE_PATTERNS = [
  /package-lock\.json$/,
  /bun\.lock(b)?$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /composer\.lock$/,
  /\.min\.(js|css)$/,
  /^dist\//,
  /^build\//,
];

export function isGeneratedFile(filename: string): boolean {
  return GENERATED_FILE_PATTERNS.some((pattern) => pattern.test(filename));
}

export function capDiff(pr: PR, capBytes: number): DiffCapResult {
  const ignoredGenerated: string[] = [];
  let total = 0;
  let truncated = false;

  const files = pr.files.map((f) => {
    if (isGeneratedFile(f.filename)) {
      if (f.patch) ignoredGenerated.push(f.filename);
      return { ...f, patch: undefined };
    }
    const size = f.patch?.length ?? 0;
    if (total >= capBytes) {
      truncated = truncated || size > 0;
      return { ...f, patch: undefined };
    }
    total += size;
    if (total > capBytes) {
      truncated = true;
      return { ...f, patch: undefined };
    }
    return f;
  });

  return { pr: { ...pr, files }, truncated, ignoredGenerated };
}
