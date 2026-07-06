import { fetchCI, fetchPR } from "../src/radar/github.ts";
import { aggregateCost, lineCost, resolveBillingMode } from "../src/services/review-cost.ts";
import { commentMarkdown, suggestionsMarkdown } from "../src/radar/report.ts";
import type { Config, RadarResult } from "../src/radar/types.ts";
import type { GabiReviewResult } from "../src/reviewer/types.ts";
import radarConfigJson from "../radar.config.json" with { type: "json" };
import { startCodexShim } from "./codex-shim.ts";
import {
  capDiff,
  deleteRadarComment,
  fetchPrLabels,
  hasSkipLabel,
  isBotLogin,
  patchPrBody,
  prBodyHasSummary,
  reactToComment,
  upsertComment,
} from "./github-pr.ts";
import { diffCapBytes } from "./env.ts";
import { appAuthConfigured, installationToken } from "./github-app-auth.ts";
import { generatePrSummary } from "./pr-summary.ts";
import { buildRelatedContext } from "./review-context.ts";
import { buildBusinessRulesContext } from "./business-rules.ts";
import type { Store } from "./store.ts";
import { extractJiraKey } from "./types.ts";
import type { StoredReview, WorkerJob } from "./types.ts";

const radarConfig = radarConfigJson as unknown as Config;

export interface RunWorkerOptions {
  dryRun?: boolean;
}

export interface RunWorkerResult {
  status: "skipped" | "done" | "error";
  reason?: string;
  markdown?: string;
}

function truncationNote(diffTruncated: boolean, ignoredGenerated: string[]): string {
  const parts: string[] = [];
  if (diffTruncated) {
    parts.push("⚠️ Diff maior que o limite configurado — review parcial (nem todos os arquivos foram analisados).");
  }
  if (ignoredGenerated.length) {
    parts.push(`ℹ️ Arquivos gerados/lockfiles ignorados: ${ignoredGenerated.join(", ")}.`);
  }
  return parts.join("\n");
}

async function buildTicketContext(pr: { title: string; headRef: string }): Promise<string> {
  if (process.env.TICKET_CONTEXT === "off") return "";
  const key = extractJiraKey(pr.headRef, pr.title);
  if (!key) return "";
  const { fetchJiraTaskInput } = await import("../scripts/task-radar/jira-issue.ts");
  const issue = await fetchJiraTaskInput(key);
  if (!issue?.description) return "";
  return `### Contexto do ticket (Jira ${key})\n${issue.description.slice(0, 4000)}`;
}

function jiraLineFor(pr: { title: string; headRef: string }): string {
  const base = process.env.JIRA_BASE_URL?.replace(/\/$/, "");
  if (!base) return "";
  const key = extractJiraKey(pr.headRef, pr.title);
  if (!key) return "";
  return `🔗 **Jira:** [${key}](${base}/browse/${key})`;
}

function errorMarkdown(message: string): string {
  return [
    "### 🛡️ **Review Radar Bot** · `v1 shadow`",
    "> 🔴 **Falha ao rodar o review automático.**",
    `> ${message}`,
  ].join("\n");
}

export async function runWorker(
  job: WorkerJob,
  store: Store,
  opts: RunWorkerOptions = {}
): Promise<RunWorkerResult> {
  const { owner, repo, number, forceReeval } = job;
  const dryRun = opts.dryRun ?? false;
  const startedAt = Date.now();

  if (appAuthConfigured()) {
    try {
      process.env.GITHUB_TOKEN = await installationToken(owner, repo);
    } catch (err) {
      console.warn("[worker] GitHub App sem instalação aprovada — usando PAT:", String(err));
    }
  }

  const pr = await fetchPR(owner, repo, number);

  if (pr.draft) return { status: "skipped", reason: "PR em rascunho (draft)" };
  if (isBotLogin(pr.author)) return { status: "skipped", reason: `autor bot (${pr.author})` };

  const labels = await fetchPrLabels(owner, repo, number);
  if (hasSkipLabel(labels)) return { status: "skipped", reason: "label skip-radar" };

  if (!forceReeval) {
    const isNew = await store.tryDedup(owner, repo, number, pr.headSha);
    if (!isNew) return { status: "skipped", reason: `SHA ${pr.headSha} já processado` };
  }

  const shim = await startCodexShim(store);
  process.env.CODEX_PROXY_URL = shim.baseUrl;

  try {
    const { radar } = await import("../src/radar/engine.ts");
    const { reviewAsGabi } = await import("../src/reviewer/gabi.ts");

    const model = radarConfig.codex.model || process.env.CODEX_REVIEW_MODEL || "gpt-5.4-mini";
    const billingMode = resolveBillingMode();
    const costLines: ReturnType<typeof lineCost>[] = [];

    const capped = capDiff(pr, diffCapBytes());
    const diffTruncated = capped.truncated;
    const ignoredGenerated = capped.ignoredGenerated;

    const needsSummary = !(await prBodyHasSummary(owner, repo, number).catch(() => true));
    const summaryPromise: Promise<string> = needsSummary
      ? generatePrSummary(store, capped.pr).catch((err: unknown) => {
          console.warn("[worker] resumo do PR falhou:", String(err).slice(0, 150));
          return "";
        })
      : Promise.resolve("");

    // Contexto do grafo de código (vizinhos dos arquivos alterados) e as regras de negócio de
    // domínio (business-rules/registry.json no S3) rodam em paralelo com o resumo e a Gabi —
    // nunca lançam (ambas tratam as próprias falhas e devolvem ""). Os dois blocos são
    // concatenados e seguem pro mesmo contexto usado pela Gabi e pelo gate 3.
    const contextPromise: Promise<string> = Promise.all([
      buildRelatedContext(capped.pr).catch(() => ""),
      buildBusinessRulesContext(capped.pr).catch(() => ""),
      buildTicketContext(pr).catch(() => ""),
    ])
      .then((blocks) => blocks.filter(Boolean).join("\n\n"))
      .catch(() => "");

    const gabiPromise: Promise<GabiReviewResult> = contextPromise
      .then((relatedContext) => reviewAsGabi(capped.pr, model, relatedContext))
      .catch(
        (err: unknown): GabiReviewResult => ({
          ran: false,
          summary: "",
          findings: [],
          commentReady: "",
          tokensIn: 0,
          tokensOut: 0,
          skipped: err instanceof Error ? err.message : String(err),
        })
      );

    let radarResult: RadarResult;
    try {
      const relatedContext = await contextPromise;
      radarResult = await radar(owner, repo, number, radarConfig, relatedContext);
    } catch (err) {
      await gabiPromise;
      const message = err instanceof Error ? err.message : String(err);
      await postFailure(owner, repo, number, message, dryRun);
      return { status: "error", reason: message };
    }

    if (radarResult.codex.ran) {
      costLines.push(
        lineCost(
          radarResult.codex.passes === 2 ? "radar-gate3-x2" : "radar-gate3",
          model,
          radarResult.codex.tokensIn,
          radarResult.codex.tokensOut,
          billingMode
        )
      );
    }

    const freshCi = await fetchCI(owner, repo, pr.headSha).catch(() => radarResult.ci);
    radarResult = { ...radarResult, ci: freshCi };
    if (freshCi.state === "failure" && radarResult.route !== "ASK") {
      radarResult = {
        ...radarResult,
        route: "ASK",
        rationale: "CI vermelho — base inegociável falhou. Corrija antes.",
      };
    }

    const gabiSettled = await gabiPromise;
    const gabiResult: GabiReviewResult | null = radarResult.route !== "SHIP" ? gabiSettled : null;
    if (gabiResult?.ran) {
      costLines.push(
        lineCost("gabi-reviewer", model, gabiResult.tokensIn, gabiResult.tokensOut, billingMode)
      );
    }

    const cost = aggregateCost(model, costLines, billingMode);
    const note = truncationNote(diffTruncated, ignoredGenerated);
    const reportInput = { radar: radarResult, review: gabiResult, cost };
    const evaluation = commentMarkdown(reportInput, { findings: true });
    const markdown = note ? `${evaluation}\n\n${note}` : evaluation;
    const blockingComment = suggestionsMarkdown(reportInput);

    const summary = await summaryPromise;

    const jiraLine = jiraLineFor(pr);

    if (dryRun) {
      console.log(`--- dry-run: jira ---`);
      console.log(jiraLine || "(sem chave Jira no branch/título)");
      console.log(`--- dry-run: resumo do PR (primeira execução) ---`);
      console.log(summary || "(não gerado — já existe ou falhou)");
      console.log(`--- dry-run: body que seria escrito em ${owner}/${repo}#${number} ---`);
      console.log(markdown);
      console.log(`--- dry-run: comentário de issues bloqueantes ---`);
      console.log(blockingComment || "(sem issues bloqueantes — comentário seria removido)");
    } else {
      await patchPrBody(owner, repo, number, markdown, summary, jiraLine);
      if (blockingComment) {
        await upsertComment(owner, repo, number, blockingComment);
      } else {
        await deleteRadarComment(owner, repo, number);
      }
      if (job.triggerCommentId) {
        await reactToComment(owner, repo, job.triggerCommentId, "+1").catch((err) =>
          console.warn("[worker] reação 👍 falhou:", String(err).slice(0, 150))
        );
      }
    }

    const stored: StoredReview = {
      pr: `${owner}/${repo}#${number}`,
      headSha: pr.headSha,
      route: radarResult.route,
      savedAt: new Date().toISOString(),
      radar: radarResult,
      review: gabiResult,
      cost,
    };
    await store.saveReview(owner, repo, number, stored);
    const apiCost = aggregateCost(
      model,
      cost.lines.map((l) => lineCost(l.component, model, l.tokensIn, l.tokensOut, "api")),
      "api"
    );
    await store.saveRun({
      pr: stored.pr,
      title: pr.title,
      route: radarResult.route,
      suggestions:
        (radarResult.codex.findings?.length ?? 0) + (gabiResult?.findings.length ?? 0),
      tokens: cost.totalTokens,
      aiOk: radarResult.codex.skipped !== "erro",
      at: stored.savedAt,
      durationMs: Date.now() - startedAt,
      costUSD: apiCost.estimatedUSD,
    });

    return { status: "done", markdown };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await postFailure(owner, repo, number, message, dryRun);
    return { status: "error", reason: message };
  } finally {
    shim.close();
  }
}

async function postFailure(
  owner: string,
  repo: string,
  number: number,
  message: string,
  dryRun: boolean
): Promise<void> {
  const markdown = errorMarkdown(message);
  if (dryRun) {
    console.log(`--- dry-run: comentário de falha para ${owner}/${repo}#${number} ---`);
    console.log(markdown);
    return;
  }
  await upsertComment(owner, repo, number, markdown).catch((commentErr) => {
    console.error("[worker] falha ao postar comentário de erro:", commentErr);
  });
}
