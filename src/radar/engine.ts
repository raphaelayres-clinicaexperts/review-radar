import { fetchPR, fetchCI } from "./github.ts";
import { gate0, computeDRS } from "./gates.ts";
import { shouldRunCodex, reviewSemantic } from "./codex.ts";
import type { Config, RadarResult, Route, CodexResult, Finding } from "./types.ts";

function route(ctx: {
  gate0Eligible: boolean;
  ci: string;
  drsRisk: string;
  codex: CodexResult;
  trustedBot: boolean;
  small: boolean;
  softHits: string[];
  minConfidenceToBlock: number;
}): { route: Route; rationale: string } {
  if (!ctx.gate0Eligible) {
    return {
      route: "ASK",
      rationale: "Gate 0: path crítico/blocklist ou draft → revisão humana obrigatória.",
    };
  }
  if (ctx.ci === "failure") {
    return { route: "ASK", rationale: "CI vermelho — base inegociável falhou. Corrija antes." };
  }
  if (ctx.drsRisk === "high") {
    return { route: "ASK", rationale: "Diff Risk Score alto — mudança arriscada, exige humano." };
  }
  if (ctx.codex.ran && ctx.codex.skipped === "erro") {
    return {
      route: "ASK",
      rationale: "Revisão IA indisponível (falha técnica) — revisão humana obrigatória.",
    };
  }
  const hasIssue =
    ctx.codex.findings.some((f) => f.tag === "issue") || ctx.codex.verdict === "block";
  if (ctx.codex.ran && hasIssue) {
    if (ctx.codex.confidence >= ctx.minConfidenceToBlock) {
      return {
        route: "ASK",
        rationale: `Revisão IA achou problema com confiança ${ctx.codex.confidence}/10 — bloqueia auto-merge.`,
      };
    }
    return {
      route: "SHOW",
      rationale: `Revisão IA achou possível problema (confiança baixa: ${ctx.codex.confidence}/10) — confira o apontamento.`,
    };
  }
  if (ctx.softHits.length) {
    return {
      route: "SHOW",
      rationale: `Toca área sensível (${ctx.softHits.join(", ")}) — integra mas pede revisão assíncrona.`,
    };
  }
  const codexClean =
    !ctx.codex.ran ||
    (ctx.codex.confidence >= 8 && ctx.codex.findings.length === 0);
  if (
    ctx.drsRisk === "low" &&
    ctx.ci !== "failure" &&
    codexClean &&
    (ctx.trustedBot || ctx.small)
  ) {
    return {
      route: "SHIP",
      rationale: "Baixo risco, CI ok, Codex confiante (≥8) e sem apontamentos — elegível a auto-merge.",
    };
  }
  return {
    route: "SHOW",
    rationale: "Risco médio/baixo sem bloqueio — integra mas notifica revisão assíncrona.",
  };
}

export async function radar(
  owner: string,
  repo: string,
  number: number,
  cfg: Config,
  relatedContext?: string
): Promise<RadarResult> {
  const pr = await fetchPR(owner, repo, number);
  const ci = await fetchCI(owner, repo, pr.headSha);
  const g0 = gate0(pr, cfg);
  const drs = computeDRS(pr, cfg);

  let codex: CodexResult = {
    ran: false,
    confidence: 0,
    verdict: "comment",
    summary: "",
    findings: [],
    tokensIn: 0,
    tokensOut: 0,
  };
  const decide = shouldRunCodex(drs, pr, cfg);
  if (g0.eligible && ci.state !== "failure" && decide.run) {
    codex = await reviewSemantic(pr, cfg, relatedContext);
  } else if (!decide.run) {
    codex.skipped = decide.reason;
  } else {
    codex.skipped = !g0.eligible ? "Gate 0 já mandou pra ASK" : "CI vermelho";
  }

  const small = pr.additions + pr.deletions <= cfg.size.shipMaxLines;
  const { route: r, rationale } = route({
    gate0Eligible: g0.eligible,
    ci: ci.state,
    drsRisk: drs.risk,
    codex,
    trustedBot: g0.trustedBot,
    small,
    softHits: g0.softHits ?? [],
    minConfidenceToBlock: cfg.codex.minConfidenceToBlock ?? 5,
  });
  const findings: Finding[] = codex.findings;
  return { pr, ci, gate0: g0, drs, codex, route: r, rationale, findings };
}

export function canAutoMerge(
  res: RadarResult,
  cfg: Config
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!cfg.autoMerge.enabled) reasons.push("auto-merge desligado na config");
  if (res.route !== "SHIP") reasons.push(`rota é ${res.route}, não SHIP`);
  if (res.ci.state !== "success") reasons.push(`CI não está verde (${res.ci.state})`);
  if (!res.gate0.eligible) reasons.push("Gate 0 não elegível");
  if (res.drs.risk !== "low") reasons.push(`risco ${res.drs.risk}`);
  if (res.codex.ran && res.codex.confidence < cfg.autoMerge.minConfidence) {
    reasons.push(`confiança ${res.codex.confidence} < ${cfg.autoMerge.minConfidence}`);
  }
  if (res.pr.additions + res.pr.deletions > cfg.autoMerge.maxLines) {
    reasons.push(`> ${cfg.autoMerge.maxLines} linhas`);
  }
  if (
    !cfg.autoMerge.allowAuthors
      .map((a) => a.toLowerCase())
      .includes(res.pr.author.toLowerCase())
  ) {
    reasons.push(`autor ${res.pr.author} fora da allowlist`);
  }
  return { ok: reasons.length === 0, reasons };
}
