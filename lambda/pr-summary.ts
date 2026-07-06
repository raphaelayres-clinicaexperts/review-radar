import type { PR } from "../src/radar/types.ts";
import { directChatCompletion } from "./codex-client.ts";
import type { Store } from "./store.ts";

const SUMMARY_SYSTEM = `Você resume pull requests para o time de engenharia.
Responda APENAS markdown neste formato:
**Objetivo:** 1 frase direta do que o PR entrega.
- No máximo 2 bullets: só o essencial — o que muda e, se houver risco real, o risco. Omita o bullet de risco quando o risco for trivial.
Regras: pt-BR, técnico, objetivo, sem preâmbulo, sem repetir o título, sem elogio, máximo 40 palavras no total.`;

const DIFF_BUDGET_BYTES = 40_000;

function compactDiff(pr: PR): string {
  const parts: string[] = [];
  let used = 0;
  for (const file of pr.files) {
    const patch = file.patch ?? "";
    const entry = `--- ${file.filename} (+${file.additions}/-${file.deletions})\n${patch}`;
    if (used + entry.length > DIFF_BUDGET_BYTES) {
      parts.push(`--- ${file.filename} (+${file.additions}/-${file.deletions}) [patch omitido]`);
      continue;
    }
    parts.push(entry);
    used += entry.length;
  }
  return parts.join("\n");
}

export async function generatePrSummary(store: Store, pr: PR): Promise<string> {
  const user = `Título: ${pr.title}\nBranch base: ${pr.baseRef}\nArquivos: ${pr.changedFiles} (+${pr.additions}/-${pr.deletions})\n\nDiff:\n${compactDiff(pr)}`;
  const result = await directChatCompletion(store, { system: SUMMARY_SYSTEM, user });
  return result.content.trim();
}
