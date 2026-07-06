import { CODEX_USAGE_URL } from "../config";
import { getValidAccessToken } from "./tokens";

export type CodexUsageFetchResult = {
  ok: boolean;
  status: number;
  body: unknown;
  error?: string;
};

export async function fetchCodexUsageFromRemote(): Promise<CodexUsageFetchResult> {
  const auth = await getValidAccessToken();
  if (!auth) {
    return {
      ok: false,
      status: 401,
      body: null,
      error: "not_authenticated",
    };
  }

  const response = await fetch(CODEX_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${auth.access_token}`,
      "Chatgpt-Account-Id": auth.account_id,
      Accept: "application/json",
    },
  });

  const text = await response.text();
  try {
    const body = JSON.parse(text) as unknown;
    return {
      ok: response.ok,
      status: response.status,
      body,
    };
  } catch {
    return {
      ok: false,
      status: response.status,
      body: text,
      error: "invalid_json",
    };
  }
}

type RateWindow = {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_after_seconds?: number;
  reset_at?: number;
};

function windowRemainingUsed(w: RateWindow | null | undefined) {
  if (!w || typeof w.used_percent !== "number") return null;
  return {
    usedPercent: w.used_percent,
    approxRemainingPercent: Math.max(0, 100 - w.used_percent),
    resetAfterSeconds: w.reset_after_seconds ?? null,
    resetAt: w.reset_at ?? null,
  };
}

export function summarizeCodexUsageBody(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  const rl = o.rate_limit as Record<string, unknown> | undefined;
  const primary = rl?.primary_window as RateWindow | undefined;
  const secondary = rl?.secondary_window as RateWindow | undefined;
  const cr = o.code_review_rate_limit as Record<string, unknown> | undefined;
  const crP = cr?.primary_window as RateWindow | undefined;
  const crS = cr?.secondary_window as RateWindow | undefined;
  return {
    planType: o.plan_type ?? null,
    rateLimitAllowed: rl?.allowed ?? null,
    rateLimitReached: rl?.limit_reached ?? null,
    windows: {
      primary: windowRemainingUsed(primary),
      secondary: windowRemainingUsed(secondary),
    },
    codeReview: {
      allowed: cr?.allowed ?? null,
      limitReached: cr?.limit_reached ?? null,
      primary: windowRemainingUsed(crP),
      secondary: windowRemainingUsed(crS),
    },
    credits: o.credits ?? null,
    promo: o.promo ?? null,
  };
}

export function formatDurationPt(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.floor(seconds);
  if (s === 0) return "agora";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}min`);
  if (parts.length === 0 && sec > 0) parts.push(`${sec}s`);
  if (parts.length === 0) parts.push("agora");
  return parts.join(" ");
}

function planLabelPt(planType: unknown): string {
  const p = String(planType || "").toLowerCase();
  const map: Record<string, string> = {
    plus: "ChatGPT Plus",
    pro: "ChatGPT Pro",
    free: "ChatGPT Free",
    business: "ChatGPT Business",
    enterprise: "ChatGPT Enterprise",
  };
  return map[p] || (planType ? String(planType) : "—");
}

function windowPeriodHint(limitWindowSeconds: number | undefined): string {
  if (!limitWindowSeconds || limitWindowSeconds <= 0) return "";
  if (limitWindowSeconds <= 21600) {
    const h = Math.round(limitWindowSeconds / 3600);
    return `~${h}h`;
  }
  if (limitWindowSeconds >= 86400) {
    const d = Math.round(limitWindowSeconds / 86400);
    return `~${d}d`;
  }
  return `~${Math.round(limitWindowSeconds / 3600)}h`;
}

function blockFromWindow(
  w: RateWindow | undefined,
  titulo: string,
  periodHint: string
): Record<string, unknown> | null {
  if (!w || typeof w.used_percent !== "number") return null;
  const used = w.used_percent;
  const left = Math.max(0, Math.min(100, 100 - used));
  const deficitPercent = used > 100 ? Math.round(used - 100) : null;
  const ra = w.reset_after_seconds;
  return {
    titulo,
    periodo: periodHint,
    restamPercent: Math.round(left),
    usadoPercent: Math.round(Math.min(used, 100)),
    barraUsadoPercent: Math.round(Math.min(used, 100)),
    deficitPercent,
    renovaEm: typeof ra === "number" ? formatDurationPt(ra) : "—",
    renovaEmSegundos: ra ?? null,
    renovaEmISO:
      typeof w.reset_at === "number"
        ? new Date(w.reset_at * 1000).toISOString()
        : null,
  };
}

export function buildUsageResumoPt(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  const rl = o.rate_limit as Record<string, unknown> | undefined;
  const primary = rl?.primary_window as RateWindow | undefined;
  const secondary = rl?.secondary_window as RateWindow | undefined;
  const cr = o.code_review_rate_limit as Record<string, unknown> | undefined;
  const crP = cr?.primary_window as RateWindow | undefined;
  const crS = cr?.secondary_window as RateWindow | undefined;

  const pSec = primary?.limit_window_seconds;
  const sSec = secondary?.limit_window_seconds;
  const sessao = blockFromWindow(primary, "Sessão", windowPeriodHint(pSec));
  const semanal = blockFromWindow(secondary, "Semanal", windowPeriodHint(sSec));
  const crPSec = crP?.limit_window_seconds;
  const codeReviewPri = blockFromWindow(
    crP,
    "Code review",
    windowPeriodHint(crPSec)
  );
  const codeReviewSec =
    crS && typeof crS.used_percent === "number"
      ? blockFromWindow(crS, "Code review (2ª janela)", "")
      : null;

  const allowed = rl?.allowed === true;
  const reached = rl?.limit_reached === true;
  const linhas: string[] = [
    `Plano: ${planLabelPt(o.plan_type)}`,
    `Codex: ${allowed && !reached ? "dentro do limite" : reached ? "limite atingido" : "indisponível"}`,
  ];
  if (sessao) {
    const d = sessao.deficitPercent
      ? ` · déficit ~${sessao.deficitPercent}%`
      : "";
    linhas.push(
      `Sessão: ~${sessao.restamPercent}% restantes · usado ${sessao.usadoPercent}% · renova em ${sessao.renovaEm}${d}`
    );
  }
  if (semanal) {
    const d = semanal.deficitPercent
      ? ` · déficit ~${semanal.deficitPercent}%`
      : "";
    linhas.push(
      `Semanal: ~${semanal.restamPercent}% restantes · usado ${semanal.usadoPercent}% · renova em ${semanal.renovaEm}${d}`
    );
  }
  if (codeReviewPri) {
    linhas.push(
      `Code review: ~${codeReviewPri.restamPercent}% restantes · renova em ${codeReviewPri.renovaEm}`
    );
  }

  return {
    plano: planLabelPt(o.plan_type),
    codexDentroDoLimite: allowed && !reached,
    limiteCodexAtingido: reached,
    creditos: o.credits ?? null,
    sessao,
    semanal,
    codeReview: {
      principal: codeReviewPri,
      secundaria: codeReviewSec,
    },
    linhas,
  };
}
