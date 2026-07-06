import type { RadarResult, CodexResult } from "./types.ts";
import type { GabiReviewResult } from "../reviewer/types.ts";
import type { ReviewCostSummary } from "../services/review-cost.ts";
import type { ReviewComment } from "./github.ts";
import { commentableLines } from "./patch.ts";

const ROUTE_EMOJI = { SHIP: "🟢", SHOW: "🟡", ASK: "🔴" } as const;
const ROUTE_PT = { SHIP: "LIBERAR", SHOW: "AVISAR", ASK: "SEGURAR" } as const;
const ROUTE_DESC: Record<string, string> = {
  SHIP: "elegível a auto-merge",
  SHOW: "integra mas pede revisão assíncrona",
  ASK: "revisão humana obrigatória",
};
const ACTIONABLE_TAGS = new Set(["issue", "suggestion", "question"]);
const TAG_LINE: Record<string, string> = {
  issue: "🔴",
  suggestion: "💡",
  nitpick: "🔍",
  question: "❓",
  note: "📝",
  praise: "👍",
};
const RISK_EMOJI: Record<string, string> = {
  low: "🟢",
  medium: "🟡",
  high: "🔴",
};

export function ciLabel(state: string, failing: string[]): string {
  if (state === "success") return "✅ CI verde";
  if (state === "failure") return `🔴 CI falhou${failing.length ? " (" + failing.slice(0, 2).join(", ") + ")" : ""}`;
  if (state === "pending") return "⏳ CI rodando";
  return "⚪ sem CI";
}

function gate0Label(eligible: boolean, reasons: string[]): string {
  if (eligible) return "✅ Apto pra análise automática (sem paths críticos, não-draft)";
  const short = reasons[0]?.replace("toca path crítico", "path crítico").replace("→ revisão humana obrigatória", "") ?? "bloqueado";
  return `🔴 ${short.trim()} → exige revisão humana`;
}

const RISK_PT: Record<string, string> = { low: "Baixo", medium: "Médio", high: "Alto" };

function riskLabel(risk: string, score: number): string {
  const emoji = RISK_EMOJI[risk] ?? "⚪";
  const pt = RISK_PT[risk] ?? risk;
  return `${emoji} **${pt}** (${score}/100)`;
}

function iaLabel(
  codex: CodexResult,
  review: GabiReviewResult | null,
  findings: Array<{ blocking: boolean }>
): string {
  if (codex.ran && codex.skipped === "erro") {
    return `⚠️ Indisponível — ${codex.summary || "falha técnica"}`;
  }
  const gabiRan = review?.ran ?? false;
  if (!codex.ran && !gabiRan) {
    return `⚪ Não rodou${codex.skipped ? " — " + codex.skipped : ""}`;
  }
  const issues = findings.filter((f) => f.blocking).length;
  const suggestions = findings.length - issues;
  if (issues > 0) {
    const extra = suggestions > 0 ? ` + ${suggestions} sugestão(ões)` : "";
    return `🔴 ${issues} problema${issues > 1 ? "s" : ""}${extra}`;
  }
  if (suggestions > 0) return `🟡 ${suggestions} sugestão(ões)`;
  return `✅ Sem apontamentos`;
}

function isChangedFile(radar: RadarResult | null, file: string | undefined | null): boolean {
  if (!file) return true;
  if (!radar) return true;
  const normalized = file.replace(/^\/+/, "");
  return radar.pr.files.some(
    (f) => f.filename === normalized || f.filename.endsWith(`/${normalized}`) || normalized.endsWith(`/${f.filename}`)
  );
}

function allFindings(radar: RadarResult | null, review: GabiReviewResult | null): Array<{ emoji: string; loc: string; body: string; blocking: boolean }> {
  const out: Array<{ emoji: string; loc: string; body: string; blocking: boolean }> = [];
  if (radar?.codex.ran) {
    for (const f of radar.codex.findings) {
      if (!isChangedFile(radar, f.file)) continue;
      const loc = f.file ? `\`${f.file}${f.line ? ":" + f.line : ""}\`` : "";
      if (!ACTIONABLE_TAGS.has(f.tag)) continue;
      out.push({ emoji: TAG_LINE[f.tag] ?? "📝", loc, body: f.body, blocking: f.tag === "issue" });
    }
  }
  if (review?.ran) {
    for (const f of review.findings) {
      if (!isChangedFile(radar, f.file)) continue;
      const loc = f.file ? `\`${f.file}${f.line ? ":" + f.line : ""}\`` : "";
      const emoji = f.severity === "Pedir mudança" ? "🔴" : f.severity === "Sugestão" ? "💡" : "❓";
      const alreadyListed = out.some((e) => e.loc === loc && e.body.slice(0, 30) === f.comment.slice(0, 30));
      if (!alreadyListed) {
        out.push({ emoji, loc, body: f.comment, blocking: f.severity === "Pedir mudança" });
      }
    }
  }
  return out;
}

export interface FullReportInput {
  radar: RadarResult | null;
  review: GabiReviewResult | null;
  cost: ReviewCostSummary;
}

export interface CommentMarkdownOptions {
  findings?: boolean;
}

export function suggestionsMarkdown(input: FullReportInput): string {
  const blocking = allFindings(input.radar, input.review).filter((f) => f.blocking);
  if (!blocking.length) return "";
  const L: string[] = [];
  L.push(`### 🔴 **Review Radar Bot** · apontamentos`);
  L.push("");
  for (const f of blocking) {
    L.push(`- ${f.emoji} ${f.loc} — ${f.body}`);
  }
  return L.join("\n");
}

export function commentMarkdown(input: FullReportInput, opts: CommentMarkdownOptions = {}): string {
  const includeFindings = opts.findings ?? true;
  const { radar, review, cost } = input;
  const route = radar?.route ?? "ASK";
  const routeEmoji = ROUTE_EMOJI[route] ?? "🔴";
  const routePt = ROUTE_PT[route] ?? "SEGURAR";
  const routeDesc = ROUTE_DESC[route] ?? "";

  const findings = allFindings(radar, review);
  const issues = findings.filter((f) => f.blocking).length;

  let rationale = radar?.rationale ?? "";
  if (issues > 0 && !rationale) {
    rationale = `${issues} issue${issues > 1 ? "s" : ""} de lógica travam o merge. Resolve os apontamentos inline e re-roda, ou aprova manual pra liberar.`;
  }

  const L: string[] = [];

  L.push(`### 🛡️ **Review Radar Bot** · \`v1 shadow\``);
  L.push(`> **${routeEmoji} ${routePt} — ${routeDesc}**<br>`);
  L.push(`> ${rationale}`);
  L.push("");

  if (radar) {
    L.push("| Check | Resultado |");
    L.push("|:--|:--|");
    L.push(`| **Auto-análise** | ${gate0Label(radar.gate0.eligible, radar.gate0.reasons)} |`);
    L.push(`| **CI** | ${ciLabel(radar.ci.state, radar.ci.failing)} |`);
    L.push(`| **Risco do diff** | ${riskLabel(radar.drs.risk, radar.drs.score)} |`);
    L.push(`| **Revisão IA** | ${iaLabel(radar.codex, review, findings)} |`);
    L.push("");

    if (includeFindings) {
      const nonBlocking = findings.filter((f) => !f.blocking);
      if (nonBlocking.length) {
        const word = nonBlocking.length > 1 ? "sugestões" : "sugestão";
        L.push(`<details><summary>💡 ${nonBlocking.length} ${word}</summary>`);
        L.push("");
        for (const f of nonBlocking) {
          L.push(`- ${f.emoji} ${f.loc} — ${f.body}`);
        }
        L.push("");
        L.push(`</details>`);
        L.push("");
      }
    }

    if (radar.drs.factors.length) {
      L.push(`> **Por que risco ${RISK_PT[radar.drs.risk] ?? radar.drs.risk}?** ${radar.drs.factors.join(" · ")}`);
      L.push("");
    }
  }

  if (includeFindings) {
    const blocking = findings.filter((f) => f.blocking);
    if (blocking.length) {
      L.push("**Apontamentos** · detalhe inline no diff");
      for (const f of blocking) {
        L.push(`- ${f.emoji} ${f.loc} — ${f.body}`);
      }
      L.push("");
    }
  }

  L.push(`<details><summary>⚙️ telemetria</summary>`);
  L.push("");
  const passes = radar?.codex.passes ?? 1;
  const passLabel = passes > 1 ? `${passes} passes` : `${passes} passe`;
  L.push(
    `\`RADAR v1 (shadow)\` · Codex ${passLabel} · ${cost.totalTokens.toLocaleString("pt-BR")} tokens · $${cost.estimatedUSD} · decisão final humana`
  );
  L.push(`</details>`);

  return L.join("\n");
}

export function buildReview(input: FullReportInput): { body: string; comments: ReviewComment[] } {
  const { radar, review } = input;
  if (!radar) return { body: commentMarkdown(input), comments: [] };

  const lineSets = new Map<string, Set<number>>();
  for (const f of radar.pr.files) lineSets.set(f.filename, commentableLines(f.patch));

  const comments: ReviewComment[] = [];
  const usedLocs = new Set<string>();

  for (const f of radar.codex.findings) {
    const set = f.file ? lineSets.get(f.file) : undefined;
    if (f.file && f.line && set && set.has(f.line)) {
      const fix = f.fix ? `\n\n**💡 fix sugerido:**\n${f.fix}` : "";
      comments.push({
        path: f.file,
        line: f.line,
        side: "RIGHT",
        body: `${TAG_LINE[f.tag] ?? "📝"} **[${f.tag}:]** ${f.body}${fix}`,
      });
      usedLocs.add(`${f.file}:${f.line}`);
    }
  }

  if (review?.ran) {
    for (const f of review.findings) {
      const locKey = f.line ? `${f.file}:${f.line}` : f.file;
      if (usedLocs.has(locKey)) continue;
      const set = f.file ? lineSets.get(f.file) : undefined;
      const line = f.line ?? 0;
      if (f.file && line && set && set.has(line)) {
        const emoji = f.severity === "Pedir mudança" ? "🔴" : f.severity === "Sugestão" ? "💡" : "❓";
        comments.push({
          path: f.file,
          line,
          side: "RIGHT",
          body: `${emoji} **[${f.severity.toLowerCase()}:]** ${f.comment}`,
        });
        usedLocs.add(locKey);
      }
    }
  }

  return { body: commentMarkdown(input), comments };
}

export function reportText(r: RadarResult): string {
  const L: string[] = [];
  const route = r.route;
  L.push(
    `${ROUTE_EMOJI[route]} RADAR · ${r.pr.owner}/${r.pr.repo}#${r.pr.number} → ${ROUTE_PT[route]}`
  );
  L.push(
    `   ${r.pr.title}  (@${r.pr.author}${r.pr.authorType === "Bot" ? " 🤖" : ""}, +${r.pr.additions}/-${r.pr.deletions}, ${r.pr.changedFiles} arq)`
  );
  L.push(`   rota: ${r.rationale}`);
  L.push(
    `   Gate0 elegível=${r.gate0.eligible}${r.gate0.blocklistHit.length ? ` (block: ${r.gate0.blocklistHit.join(",")})` : ""} · CI=${r.ci.state}${r.ci.failing.length ? ` (falha: ${r.ci.failing.slice(0, 3).join(",")})` : ""}`
  );
  L.push(`   DRS=${r.drs.risk} (${r.drs.score}/100): ${r.drs.factors.join(" · ")}`);
  if (r.codex.ran) {
    L.push(
      `   Codex: confiança ${r.codex.confidence}/10 · verdict ${r.codex.verdict} · ${r.codex.passes ?? 1} pass(es) · ~${r.codex.tokensIn} in / ~${r.codex.tokensOut} out tokens`
    );
    if (r.codex.summary) L.push(`     resumo: ${r.codex.summary}`);
    for (const f of r.codex.findings) {
      L.push(
        `     ${TAG_LINE[f.tag] ?? ""} [${f.tag}:]${f.file ? " " + f.file + (f.line ? ":" + f.line : "") : ""} ${f.body}${f.fix ? `  (fix: ${f.fix})` : ""}`
      );
    }
  } else {
    L.push(`   Codex: NÃO rodou — ${r.codex.skipped ?? "—"}`);
  }
  return L.join("\n");
}

export function formatReviewText(review: GabiReviewResult): string {
  const lines: string[] = [];
  lines.push("=== Review Profunda ===");
  lines.push(review.summary);
  if (review.findings.length) {
    lines.push("");
    lines.push("Severidade | arquivo:linha | tema | o que mudar");
    for (const f of review.findings) {
      const loc = `${f.file}${f.line ? ":" + f.line : ""}`;
      lines.push(`${f.severity} | ${loc} | ${f.theme} | ${f.change}`);
    }
  }
  if (review.skipped) lines.push(`\n(skipped: ${review.skipped})`);
  return lines.join("\n");
}
