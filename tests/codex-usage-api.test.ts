import { describe, expect, test } from "bun:test";
import {
  buildUsageResumoPt,
  formatDurationPt,
  summarizeCodexUsageBody,
} from "../src/services/codex-usage-api";

describe("summarizeCodexUsageBody", () => {
  test("derives remaining percent from rate windows", () => {
    const s = summarizeCodexUsageBody({
      plan_type: "plus",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 10, reset_after_seconds: 100 },
        secondary_window: { used_percent: 42, reset_after_seconds: 200 },
      },
      code_review_rate_limit: {
        allowed: true,
        primary_window: { used_percent: 5 },
        secondary_window: null,
      },
      credits: { has_credits: false },
    });
    expect(s).not.toBeNull();
    expect(s!.planType).toBe("plus");
    expect(s!.windows?.primary?.usedPercent).toBe(10);
    expect(s!.windows?.primary?.approxRemainingPercent).toBe(90);
    expect(s!.windows?.secondary?.approxRemainingPercent).toBe(58);
    expect(s!.codeReview?.primary?.approxRemainingPercent).toBe(95);
  });

  test("returns null for non-object", () => {
    expect(summarizeCodexUsageBody(null)).toBeNull();
    expect(summarizeCodexUsageBody("x")).toBeNull();
  });
});

describe("formatDurationPt", () => {
  test("formats hours and minutes", () => {
    expect(formatDurationPt(17211)).toContain("4h");
    expect(formatDurationPt(17211)).toContain("46");
  });

  test("formats days", () => {
    expect(formatDurationPt(90000)).toContain("1d");
  });
});

describe("buildUsageResumoPt", () => {
  test("builds sessao semanal and linhas", () => {
    const r = buildUsageResumoPt({
      plan_type: "plus",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 9,
          limit_window_seconds: 18000,
          reset_after_seconds: 3600,
          reset_at: 1000000000,
        },
        secondary_window: {
          used_percent: 42,
          limit_window_seconds: 604800,
          reset_after_seconds: 86400,
          reset_at: 1000000000,
        },
      },
      code_review_rate_limit: {
        allowed: true,
        primary_window: { used_percent: 0, reset_after_seconds: 100 },
        secondary_window: null,
      },
      credits: {},
    });
    expect(r).not.toBeNull();
    expect(r!.plano).toBe("ChatGPT Plus");
    expect((r!.sessao as { restamPercent: number }).restamPercent).toBe(91);
    expect((r!.semanal as { restamPercent: number }).restamPercent).toBe(58);
    expect(Array.isArray(r!.linhas)).toBe(true);
    expect((r!.linhas as string[]).some((l) => l.includes("Sessão"))).toBe(true);
  });
});
