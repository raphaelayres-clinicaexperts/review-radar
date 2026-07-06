import { proxyChatCompletion } from "../services/codex-proxy-client.ts";
import { GABI_SYSTEM } from "./references.ts";
import type { GabiReviewResult, GabiFinding } from "./types.ts";
import type { PR } from "../radar/types.ts";

type GabiPayload = {
  summary: string;
  findings: GabiFinding[];
  commentReady: string;
};

function buildDiff(pr: PR): string {
  let out = `PR #${pr.number} "${pr.title}" por @${pr.author}\n`;
  out += `Repo: ${pr.owner}/${pr.repo} · +${pr.additions}/-${pr.deletions} · ${pr.changedFiles} arquivos\n\n`;
  for (const f of pr.files) {
    out += `### ${f.filename} (+${f.additions}/-${f.deletions})\n`;
    out += f.patch ? f.patch + "\n\n" : "(sem patch)\n\n";
  }
  return out;
}

export async function reviewAsGabi(
  pr: PR,
  model?: string,
  relatedContext?: string
): Promise<GabiReviewResult> {
  const diff = relatedContext ? `${buildDiff(pr)}\n${relatedContext}\n` : buildDiff(pr);
  const tokensInEst = Math.round((GABI_SYSTEM.length + diff.length) / 4);
  try {
    const result = await proxyChatCompletion<GabiPayload>({
      system: GABI_SYSTEM,
      user: diff,
      model,
    });
    const p = result.data;
    const findings = (p.findings ?? []).slice(0, 5);
    const commentReady =
      p.commentReady ||
      findings
        .map((f) => `[${f.file}${f.line ? ":" + f.line : ""}]\n${f.comment}`)
        .join("\n\n");
    return {
      ran: true,
      summary: p.summary ?? (findings.length ? `${findings.length} achado(s)` : "LGTM"),
      findings,
      commentReady,
      tokensIn: result.usage.promptTokens || tokensInEst,
      tokensOut: result.usage.completionTokens,
    };
  } catch (e) {
    return {
      ran: false,
      summary: "",
      findings: [],
      commentReady: "",
      tokensIn: tokensInEst,
      tokensOut: 0,
      skipped: (e as Error).message,
    };
  }
}

export function formatGabiText(review: GabiReviewResult): string {
  const lines: string[] = [];
  lines.push("=== Gabi Reviewer ===");
  lines.push(review.summary);
  if (review.findings.length) {
    lines.push("");
    lines.push("Severidade | arquivo:linha | tema | o que mudar");
    for (const f of review.findings) {
      const loc = `${f.file}${f.line ? ":" + f.line : ""}`;
      lines.push(`${f.severity} | ${loc} | ${f.theme} | ${f.change}`);
    }
  }
  if (review.commentReady) {
    lines.push("");
    lines.push("--- Comentário pronto ---");
    lines.push(review.commentReady);
  }
  if (review.skipped) lines.push(`\n(skipped: ${review.skipped})`);
  return lines.join("\n");
}
