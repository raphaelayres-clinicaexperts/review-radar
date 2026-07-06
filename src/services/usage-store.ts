import { writeFileSync, readFileSync, existsSync } from "node:fs";

const PERSIST_FILE = "./usage-session.json";

type QuotaFromHeaders = {
  percentTokensRemaining: number | null;
  remainingTokens: string | null;
  limitTokens: string | null;
  percentRequestsRemaining: number | null;
  remainingRequests: string | null;
  limitRequests: string | null;
  resetTokens: string | null;
  resetRequests: string | null;
};

type ReportedUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
};

type SessionApprox = {
  requests: number;
  promptTokensEst: number;
  completionTokensEst: number;
  reportedPromptTotal: number;
  reportedCompletionTotal: number;
};

const state: {
  lastUpstreamHeaders: Record<string, string> | null;
  lastUpstreamAt: number | null;
  lastReportedUsage: ReportedUsage | null;
  session: SessionApprox;
} = {
  lastUpstreamHeaders: null,
  lastUpstreamAt: null,
  lastReportedUsage: null,
  session: {
    requests: 0,
    promptTokensEst: 0,
    completionTokensEst: 0,
    reportedPromptTotal: 0,
    reportedCompletionTotal: 0,
  },
};

function headerMap(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

function getHeader(
  headers: Record<string, string>,
  ...keys: string[]
): string | undefined {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
  );
  for (const k of keys) {
    const v = lower[k.toLowerCase()];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

function parseRatio(remaining: string, limit: string): number | null {
  const r = parseInt(remaining, 10);
  const l = parseInt(limit, 10);
  if (!Number.isFinite(r) || !Number.isFinite(l) || l <= 0) return null;
  return (r / l) * 100;
}

export function parseQuotaFromHeaders(
  headers: Record<string, string> | null
): QuotaFromHeaders | null {
  if (!headers || Object.keys(headers).length === 0) return null;
  const remTok = getHeader(
    headers,
    "x-ratelimit-remaining-tokens",
    "ratelimit-remaining-tokens"
  );
  const limTok = getHeader(
    headers,
    "x-ratelimit-limit-tokens",
    "ratelimit-limit-tokens"
  );
  const remReq = getHeader(
    headers,
    "x-ratelimit-remaining-requests",
    "ratelimit-remaining-requests"
  );
  const limReq = getHeader(
    headers,
    "x-ratelimit-limit-requests",
    "ratelimit-limit-requests"
  );
  const resetTok = getHeader(
    headers,
    "x-ratelimit-reset-tokens",
    "ratelimit-reset-tokens"
  );
  const resetReq = getHeader(
    headers,
    "x-ratelimit-reset-requests",
    "ratelimit-reset-requests"
  );
  const hasAny = remTok || limTok || remReq || limReq;
  if (!hasAny) return null;
  return {
    percentTokensRemaining:
      remTok && limTok ? parseRatio(remTok, limTok) : null,
    remainingTokens: remTok ?? null,
    limitTokens: limTok ?? null,
    percentRequestsRemaining:
      remReq && limReq ? parseRatio(remReq, limReq) : null,
    remainingRequests: remReq ?? null,
    limitRequests: limReq ?? null,
    resetTokens: resetTok ?? null,
    resetRequests: resetReq ?? null,
  };
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function extractUsageFromCodexPayload(
  obj: Record<string, unknown>
): ReportedUsage | null {
  const u = obj.usage;
  if (u && typeof u === "object") {
    const o = u as Record<string, unknown>;
    return {
      promptTokens: num(o.prompt_tokens ?? o.input_tokens),
      completionTokens: num(o.completion_tokens ?? o.output_tokens),
      totalTokens: num(o.total_tokens),
    };
  }
  const pt = num(obj.prompt_tokens ?? obj.input_tokens);
  const ct = num(obj.completion_tokens ?? obj.output_tokens);
  const tt = num(obj.total_tokens);
  if (pt !== null || ct !== null || tt !== null) {
    return {
      promptTokens: pt,
      completionTokens: ct,
      totalTokens: tt,
    };
  }
  const resp = obj.response;
  if (resp && typeof resp === "object") {
    return extractUsageFromCodexPayload(resp as Record<string, unknown>);
  }
  return null;
}

export function resetLastReportedUsage(): void {
  state.lastReportedUsage = null;
}

export function recordFromHttpResponse(response: Response): void {
  state.lastUpstreamHeaders = headerMap(response.headers);
  state.lastUpstreamAt = Date.now();
}

export function recordSseObject(obj: Record<string, unknown>): void {
  const u = extractUsageFromCodexPayload(obj);
  if (!u) return;
  state.lastReportedUsage = u;
  if (u.promptTokens !== null)
    state.session.reportedPromptTotal += u.promptTokens;
  if (u.completionTokens !== null)
    state.session.reportedCompletionTotal += u.completionTokens;
}

export function recordApproxCompletion(
  promptTextChars: number,
  completionTextChars: number
): void {
  state.session.requests += 1;
  state.session.promptTokensEst += Math.max(1, Math.ceil(promptTextChars / 4));
  state.session.completionTokensEst += Math.max(
    0,
    Math.ceil(completionTextChars / 4)
  );
}

export function messagesChars(
  messages: Array<{ role: string; content: string }>
): number {
  let n = 0;
  for (const m of messages) {
    n += (m.content || "").length;
  }
  return n;
}

export type UsageSummary = {
  lastUpstreamAt: string | null;
  upstreamHeaders: Record<string, string> | null;
  quotaFromHeaders: QuotaFromHeaders | null;
  lastReportedUsage: ReportedUsage | null;
  sessionApprox: SessionApprox;
  budgetEnv: {
    maxApproxTokensPerMonth: number | null;
    percentOfBudgetUsedThisSession: number | null;
  };
  notes: string[];
};

function loadBudgetEnv(): {
  maxApproxTokensPerMonth: number | null;
  percentOfBudgetUsedThisSession: number | null;
} {
  const raw = process.env.CODEX_PROXY_BUDGET_TOKENS_MONTHLY;
  if (!raw) {
    return { maxApproxTokensPerMonth: null, percentOfBudgetUsedThisSession: null };
  }
  const max = parseInt(raw.replace(/_/g, ""), 10);
  if (!Number.isFinite(max) || max <= 0) {
    return { maxApproxTokensPerMonth: null, percentOfBudgetUsedThisSession: null };
  }
  const used =
    state.session.promptTokensEst + state.session.completionTokensEst;
  return {
    maxApproxTokensPerMonth: max,
    percentOfBudgetUsedThisSession: (used / max) * 100,
  };
}

export function getUsageSummary(): UsageSummary {
  const notes: string[] = [];
  const quota = parseQuotaFromHeaders(state.lastUpstreamHeaders);
  if (!quota && state.lastUpstreamHeaders) {
    notes.push(
      "Nenhum header padrão x-ratelimit-* na última resposta; percentuais oficiais podem não existir neste endpoint."
    );
  }
  if (!state.lastReportedUsage) {
    notes.push(
      "Tokens por completion: estimativa ~4 caracteres/token até o backend enviar usage nos eventos."
    );
  }
  const budgetEnv = loadBudgetEnv();
  if (!budgetEnv.maxApproxTokensPerMonth) {
    notes.push(
      "Opcional: defina CODEX_PROXY_BUDGET_TOKENS_MONTHLY (ex.: 5000000) para ver % usado do teu teto mensal estimado."
    );
  }
  return {
    lastUpstreamAt: state.lastUpstreamAt
      ? new Date(state.lastUpstreamAt).toISOString()
      : null,
    upstreamHeaders: state.lastUpstreamHeaders,
    quotaFromHeaders: quota,
    lastReportedUsage: state.lastReportedUsage,
    sessionApprox: { ...state.session },
    budgetEnv,
    notes,
  };
}

export function persistSession(): void {
  try {
    writeFileSync(
      PERSIST_FILE,
      JSON.stringify(
        {
          session: state.session,
          lastReportedUsage: state.lastReportedUsage,
          savedAt: new Date().toISOString(),
        },
        null,
        2
      )
    );
  } catch {
    return;
  }
}

export function loadPersistedSession(): void {
  if (!existsSync(PERSIST_FILE)) return;
  try {
    const raw = JSON.parse(readFileSync(PERSIST_FILE, "utf-8")) as {
      session?: SessionApprox;
      lastReportedUsage?: ReportedUsage | null;
    };
    if (raw.session) {
      state.session = {
        requests: raw.session.requests ?? 0,
        promptTokensEst: raw.session.promptTokensEst ?? 0,
        completionTokensEst: raw.session.completionTokensEst ?? 0,
        reportedPromptTotal: raw.session.reportedPromptTotal ?? 0,
        reportedCompletionTotal: raw.session.reportedCompletionTotal ?? 0,
      };
    }
    if (raw.lastReportedUsage) state.lastReportedUsage = raw.lastReportedUsage;
  } catch {
    return;
  }
}
