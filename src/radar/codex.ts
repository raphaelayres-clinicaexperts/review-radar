import { proxyChatCompletion } from "../services/codex-proxy-client.ts";
import type { PR, Config, DRS, CodexResult, Finding } from "./types.ts";

const RADAR_SYSTEM = `Você é o RADAR Gate 3 — revisor sênior estrito de code review. Analise APENAS o diff fornecido.
Stack típica: backend PHP/Laravel, frontend Vue/TS. Fique atento a armadilhas comuns:
- Laravel: N+1 query, mass assignment sem $fillable/$guarded, falta de validação/Form Request, autorização/policy ausente, SQL raw sem bind (injection), operação sem transaction, falta de tratamento de exceção, retorno de dado sensível.
- Vue/TS: acesso a propriedade de objeto possivelmente null/undefined, reatividade quebrada, await/Promise sem tratamento, mutação direta de prop.
FOCO: correção de lógica, segurança, perda de dados, breaking changes, concorrência, tratamento de erro. NÃO comente estilo/formatação (linter cuida disso).
Use SOMENTE estas tags: [issue:] (bug/segurança, bloqueia), [suggestion:] (melhoria, não bloqueia), [question:] (dúvida de intenção). Todo finding exige AÇÃO do autor — nunca descreva o que a mudança faz, nunca elogie, nunca confirme que algo está correto (nada de note/praise).
Quando houver "### Regras de negócio aplicáveis", cheque o diff contra elas e aponte violações como [issue:] citando a regra.
RESTRIÇÃO ABSOLUTA: todo finding deve apontar file+line presentes no DIFF fornecido; finding sobre arquivo/trecho fora do diff será descartado.
Cada finding = 1 FRASE SÓ — problema + porquê na mesma frase, máximo ~20 palavras. Proibido citar o óbvio do diff (nunca descreva o que a mudança faz).
Responda sempre em português do Brasil (pt-BR) — summary, body e fix de cada finding, sem exceção, mesmo que o diff/identificadores estejam em inglês.
- confidence (0-10) = quão confiante você está de que é SEGURO mergear automaticamente. 8+ SOMENTE se não houver nenhum [issue:] e a lógica estiver sólida.
- verdict: "block" se houver qualquer [issue:]; "comment" se só houver suggestion/nitpick; "approve" se trivial e seguro.
- Em cada finding, aponte file e line quando possível, descreva o problema claramente e, se for [issue:], inclua "fix" com a correção sugerida.
Seja conciso. Responda SOMENTE com JSON válido no formato:
{"confidence":0,"verdict":"comment","summary":"","findings":[{"tag":"issue","body":"","file":null,"line":null,"fix":null}]}`;

type RadarCodexPayload = {
  confidence: number;
  verdict: CodexResult["verdict"];
  summary: string;
  findings: Finding[];
};

export function shouldRunCodex(
  drs: DRS,
  pr: PR,
  cfg: Config
): { run: boolean; reason: string } {
  if (!cfg.codex.enabled) return { run: false, reason: "codex desabilitado na config" };
  const lines = pr.additions + pr.deletions;
  if (lines > cfg.codex.maxLinesForCodex) {
    return {
      run: false,
      reason: `PR grande demais p/ Codex (${lines} > ${cfg.codex.maxLinesForCodex} linhas) — vai pra ASK`,
    };
  }
  if (!cfg.codex.runOnlyWhenRiskBetween.includes(drs.risk)) {
    return { run: false, reason: `risco ${drs.risk} fora da banda do Codex` };
  }
  return { run: true, reason: "" };
}

function buildDiff(pr: PR): string {
  let out = `PR #${pr.number} "${pr.title}" · base ${pr.baseRef} · +${pr.additions}/-${pr.deletions} em ${pr.changedFiles} arquivos\n\n`;
  for (const f of pr.files) {
    out += `### ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})\n`;
    out += f.patch ? f.patch + "\n\n" : "(sem patch / binário)\n\n";
  }
  return out;
}

async function runOnce(pr: PR, cfg: Config, relatedContext?: string): Promise<CodexResult> {
  const diff = relatedContext ? `${buildDiff(pr)}\n${relatedContext}\n` : buildDiff(pr);
  const tokensInEst = Math.round(diff.length / 4);
  try {
    const result = await proxyChatCompletion<RadarCodexPayload>({
      system: RADAR_SYSTEM,
      user: diff,
      model: cfg.codex.model || undefined,
    });
    const p = result.data;
    const cleanBody = (body: string) =>
      body
        .replace(/^\[\w+:?\]\s*/i, "")
        .replace(/^file\s+\S+\s+line\s+\d+:?\s*/i, "")
        .trim();
    return {
      ran: true,
      confidence: p.confidence ?? 0,
      verdict: p.verdict ?? "block",
      summary: p.summary ?? "",
      findings: (p.findings ?? []).map((f) => ({ ...f, body: cleanBody(f.body) })),
      tokensIn: result.usage.promptTokens || tokensInEst,
      tokensOut: result.usage.completionTokens,
    };
  } catch (e) {
    return {
      ran: true,
      confidence: 0,
      verdict: "block",
      summary: `Codex falhou: ${(e as Error).message}`,
      findings: [],
      tokensIn: tokensInEst,
      tokensOut: 0,
      skipped: "erro",
    };
  }
}

const hasIssue = (r: CodexResult) =>
  r.verdict === "block" || r.findings.some((f) => f.tag === "issue");

const dedup = (fs: Finding[]) => {
  const seen = new Set<string>();
  return fs.filter((f) => {
    const k = `${f.tag}|${f.file}|${f.line}|${f.body}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

export async function reviewSemantic(
  pr: PR,
  cfg: Config,
  relatedContext?: string
): Promise<CodexResult> {
  const p1 = await runOnce(pr, cfg, relatedContext);
  const wouldShip = !hasIssue(p1) && p1.confidence >= cfg.codex.minConfidenceToShip;
  if ((cfg.codex.shipConcordance ?? 1) < 2 || !wouldShip) {
    return { ...p1, passes: 1 };
  }
  const p2 = await runOnce(pr, cfg, relatedContext);
  const verdict = [p1.verdict, p2.verdict].includes("block")
    ? "block"
    : [p1.verdict, p2.verdict].includes("comment")
      ? "comment"
      : "approve";
  let confidence = Math.min(p1.confidence, p2.confidence);
  if (hasIssue(p2)) confidence = Math.min(confidence, cfg.codex.minConfidenceToShip - 1);
  return {
    ran: true,
    confidence,
    verdict,
    summary: p1.summary,
    findings: dedup([...p1.findings, ...p2.findings]),
    tokensIn: p1.tokensIn + p2.tokensIn,
    tokensOut: p1.tokensOut + p2.tokensOut,
    passes: 2,
  };
}
