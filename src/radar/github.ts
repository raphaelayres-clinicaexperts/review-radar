import type { PR, PRFile, CI } from "./types.ts";

const GH = "https://api.github.com";
const H = () => ({
  Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "codex-proxy-radar",
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function gh(path: string): Promise<any> {
  for (let a = 0; ; a++) {
    const res = await fetch(`${GH}${path}`, { headers: H() });
    if ((res.status === 403 || res.status === 429) && a < 5) {
      const reset = Number(res.headers.get("x-ratelimit-reset") ?? 0) * 1000;
      await sleep(Math.min(Math.max(2000, reset - Date.now() + 1000), 30000));
      continue;
    }
    if (!res.ok) {
      throw new Error(`GitHub ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    return res.json();
  }
}

async function ghPaged(path: string): Promise<any[]> {
  const out: any[] = [];
  for (let p = 1; ; p++) {
    const sep = path.includes("?") ? "&" : "?";
    const items = await gh(`${path}${sep}per_page=100&page=${p}`);
    out.push(...items);
    if (items.length < 100) break;
  }
  return out;
}

export function parseRef(ref: string): { owner: string; repo: string; number: number } {
  const m = ref.match(/(?:github\.com\/)?([^/\s]+)\/([^/#\s]+)(?:\/pull\/|#)(\d+)/);
  if (!m) throw new Error(`PR inválido: "${ref}" (use owner/repo#123 ou a URL do PR)`);
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
}

export async function fetchPR(owner: string, repo: string, number: number): Promise<PR> {
  const p = await gh(`/repos/${owner}/${repo}/pulls/${number}`);
  const rawFiles = await ghPaged(`/repos/${owner}/${repo}/pulls/${number}/files`);
  const files: PRFile[] = rawFiles.map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch,
  }));
  return {
    owner,
    repo,
    number,
    title: p.title,
    url: p.html_url,
    author: p.user?.login ?? "?",
    authorType: p.user?.type === "Bot" ? "Bot" : "User",
    additions: p.additions,
    deletions: p.deletions,
    changedFiles: p.changed_files,
    draft: p.draft ?? false,
    baseRef: p.base?.ref ?? "main",
    headRef: p.head?.ref ?? "",
    headSha: p.head?.sha ?? "",
    files,
  };
}

export async function fetchCI(owner: string, repo: string, sha: string): Promise<CI> {
  if (!sha) return { state: "none", total: 0, failing: [] };
  const runs = await gh(`/repos/${owner}/${repo}/commits/${sha}/check-runs`).catch((err) => {
    console.warn(`[ci] check-runs falhou: ${String(err).slice(0, 150)}`);
    return { check_runs: [] };
  });
  const status = await gh(`/repos/${owner}/${repo}/commits/${sha}/status`).catch((err) => {
    console.warn(`[ci] status falhou: ${String(err).slice(0, 150)}`);
    return { statuses: [], state: "none" };
  });
  const failing: string[] = [];
  let total = 0;
  for (const r of runs.check_runs ?? []) {
    total++;
    if (r.conclusion && !["success", "neutral", "skipped"].includes(r.conclusion)) {
      failing.push(r.name);
    }
  }
  for (const s of status.statuses ?? []) {
    total++;
    if (s.state === "failure" || s.state === "error") failing.push(s.context);
  }
  const anyPending =
    (runs.check_runs ?? []).some((r: any) => r.status !== "completed") ||
    ((status.statuses ?? []).length > 0 && status.state === "pending");
  const state =
    total === 0 ? "none" : failing.length ? "failure" : anyPending ? "pending" : "success";
  return { state, total, failing };
}

export async function postComment(
  owner: string,
  repo: string,
  number: number,
  body: string
): Promise<void> {
  const res = await fetch(`${GH}/repos/${owner}/${repo}/issues/${number}/comments`, {
    method: "POST",
    headers: { ...H(), "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    throw new Error(`comentar → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

export interface ReviewComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
}

export async function createReview(
  owner: string,
  repo: string,
  number: number,
  body: string,
  comments: ReviewComment[]
): Promise<void> {
  const post = (payload: unknown) =>
    fetch(`${GH}/repos/${owner}/${repo}/pulls/${number}/reviews`, {
      method: "POST",
      headers: { ...H(), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  let res = await post({ body, event: "COMMENT", comments });
  if (!res.ok && comments.length) {
    res = await post({ body, event: "COMMENT" });
  }
  if (!res.ok) {
    throw new Error(`review → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

export async function approveAndMerge(
  owner: string,
  repo: string,
  number: number,
  sha: string
): Promise<void> {
  const a = await fetch(`${GH}/repos/${owner}/${repo}/pulls/${number}/reviews`, {
    method: "POST",
    headers: { ...H(), "Content-Type": "application/json" },
    body: JSON.stringify({
      event: "APPROVE",
      body: "✅ RADAR SHIP — auto-aprovado (baixo risco, CI verde, Codex confiante).",
    }),
  });
  if (!a.ok) throw new Error(`approve → ${a.status}`);
  const m = await fetch(`${GH}/repos/${owner}/${repo}/pulls/${number}/merge`, {
    method: "PUT",
    headers: { ...H(), "Content-Type": "application/json" },
    body: JSON.stringify({ merge_method: "squash", sha }),
  });
  if (!m.ok) throw new Error(`merge → ${m.status}: ${(await m.text()).slice(0, 200)}`);
}
