#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { runReviewPipeline, type ReviewMode } from "../services/review-pipeline.ts";
import { reportText, formatReviewText, commentMarkdown, buildReview, type FullReportInput } from "../radar/report.ts";
import { postComment, createReview, parseRef } from "../radar/github.ts";
import { formatCostPt } from "../services/review-cost.ts";
import { isGithubWriteEnabled } from "../services/review-config.ts";

function loadEnvFile(path = ".env"): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvFile();

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const prRef = args.find((a) => !a.startsWith("--"));

if (!prRef) {
  console.error(
    "uso: bun run review <owner/repo#123> [--radar-only] [--gabi-only] [--no-codex] [--comment] [--review] [--json]"
  );
  process.exit(1);
}

if (!process.env.GITHUB_TOKEN) {
  console.error("Faltando GITHUB_TOKEN (.env ou ambiente).");
  process.exit(1);
}

const mode: ReviewMode = flags.has("--gabi-only")
  ? "gabi-only"
  : flags.has("--radar-only")
    ? "radar-only"
    : "full";

const result = await runReviewPipeline(prRef, mode, {
  skipCodex: flags.has("--no-codex"),
});

if (flags.has("--json")) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

if (result.radar) console.log(reportText(result.radar));
if (result.review) {
  if (result.radar) console.log("");
  console.log(formatReviewText(result.review));
}
console.log("");
console.log(formatCostPt(result.cost));

if (flags.has("--comment") || flags.has("--review")) {
  if (!isGithubWriteEnabled()) {
    console.error(
      "\n⛔ Escrita no GitHub bloqueada (REVIEW_GITHUB_WRITE=false). Saída só no terminal."
    );
    process.exit(0);
  }
  const { owner, repo, number } = parseRef(prRef);
  const prUrl = result.radar?.pr.url ?? `https://github.com/${owner}/${repo}/pull/${number}`;
  const reportInput: FullReportInput = { radar: result.radar, review: result.review, cost: result.cost };

  if (flags.has("--review") && result.radar) {
    const { body, comments } = buildReview(reportInput);
    await createReview(owner, repo, number, body, comments);
    console.log(`\nReview inline postado em ${prUrl}`);
  } else {
    const body = commentMarkdown(reportInput);
    await postComment(owner, repo, number, body);
    console.log(`\nComentário postado em ${prUrl}`);
  }
}
