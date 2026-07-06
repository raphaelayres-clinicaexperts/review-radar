import type { PipelineResult } from "./types.ts";

export function toMarkdown(result: PipelineResult): string {
  const { task, analysis } = result;
  const lines: string[] = [];

  lines.push(`# Pré-análise — ${task.key ?? "(nova task)"}`);
  lines.push("");
  lines.push(`**Título:** ${task.title}`);
  lines.push(`**Dificuldade:** ${analysis.difficulty} · **Score:** ${analysis.score}/10`);
  lines.push(`**Rationale:** ${analysis.rationale}`);
  lines.push("");

  lines.push("## Módulos afetados");
  if (analysis.modules.length === 0) {
    lines.push("- (nenhum módulo identificado com confiança)");
  } else {
    for (const m of analysis.modules) {
      lines.push(`- \`${m.path}\` (confiança ${(m.confidence * 100).toFixed(0)}%) — ${m.what}`);
    }
  }
  lines.push("");

  lines.push("## Riscos");
  if (analysis.risks.length === 0) {
    lines.push("- (nenhum risco relevante apontado)");
  } else {
    for (const r of analysis.risks) lines.push(`- ${r}`);
  }
  lines.push("");

  if (analysis.split) {
    lines.push("## Split sugerido");
    for (const s of analysis.split) lines.push(`- ${s}`);
    lines.push("");
  }

  lines.push("## Tasks similares");
  if (analysis.similar.length === 0) {
    lines.push("- (nenhuma task histórica relevante)");
  } else {
    for (const s of analysis.similar) {
      lines.push(`- [${s.key ?? "sem-chave"}] PR #${s.pr} — ${s.note}`);
    }
  }
  lines.push("");

  lines.push("## Possível duplicidade");
  lines.push(
    analysis.duplicateFlag.suspected
      ? `⚠️ Suspeita: ${analysis.duplicateFlag.why}`
      : "Nenhuma suspeita de duplicidade."
  );
  lines.push("");

  lines.push(
    `_Uso Codex: ${result.usage.calls} chamadas, ${result.usage.promptTokens} tokens in, ${result.usage.completionTokens} tokens out._`
  );

  return lines.join("\n");
}
