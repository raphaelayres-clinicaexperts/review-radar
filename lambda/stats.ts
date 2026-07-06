import type { RunRecord } from "./types.ts";
import type { Store } from "./store.ts";

interface DayStats {
  date: string;
  runs: number;
  aiFailures: number;
  tokens: number;
}

export interface StatsResponse {
  totals: {
    runs: number;
    prs: number;
    withSuggestions: number;
    aiFailures: number;
    tokens: number;
    costUSD: number;
    avgDurationMs: number;
  };
  byRoute: Record<string, number>;
  byDay: DayStats[];
  recent: RunRecord[];
}

export async function buildStats(store: Store, days = 30): Promise<StatsResponse> {
  const runs = await store.listRuns(days);
  const prs = new Set(runs.map((r) => r.pr));
  const byRoute: Record<string, number> = { SHIP: 0, SHOW: 0, ASK: 0 };
  const dayMap = new Map<string, DayStats>();

  for (const run of runs) {
    byRoute[run.route] = (byRoute[run.route] ?? 0) + 1;
    const date = run.at.slice(0, 10);
    const day = dayMap.get(date) ?? { date, runs: 0, aiFailures: 0, tokens: 0 };
    day.runs += 1;
    day.tokens += run.tokens;
    if (!run.aiOk) day.aiFailures += 1;
    dayMap.set(date, day);
  }

  const timed = runs.filter((r) => (r.durationMs ?? 0) > 0);
  return {
    totals: {
      runs: runs.length,
      prs: prs.size,
      withSuggestions: runs.filter((r) => r.suggestions > 0).length,
      aiFailures: runs.filter((r) => !r.aiOk).length,
      tokens: runs.reduce((sum, r) => sum + r.tokens, 0),
      costUSD: Math.round(runs.reduce((sum, r) => sum + (r.costUSD ?? 0), 0) * 10_000) / 10_000,
      avgDurationMs: timed.length
        ? Math.round(timed.reduce((sum, r) => sum + (r.durationMs ?? 0), 0) / timed.length)
        : 0,
    },
    byRoute,
    byDay: [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
    recent: [...runs].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30),
  };
}
