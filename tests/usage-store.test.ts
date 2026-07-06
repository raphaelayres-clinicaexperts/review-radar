import { describe, expect, test } from "bun:test";
import {
  extractUsageFromCodexPayload,
  parseQuotaFromHeaders,
} from "../src/services/usage-store";

describe("parseQuotaFromHeaders", () => {
  test("computes percent from OpenAI-style token headers", () => {
    const q = parseQuotaFromHeaders({
      "x-ratelimit-remaining-tokens": "50000",
      "x-ratelimit-limit-tokens": "200000",
    });
    expect(q).not.toBeNull();
    expect(q!.percentTokensRemaining).toBeCloseTo(25, 5);
    expect(q!.remainingTokens).toBe("50000");
    expect(q!.limitTokens).toBe("200000");
  });

  test("returns null when no quota headers", () => {
    expect(parseQuotaFromHeaders({ "content-type": "application/json" })).toBe(
      null
    );
  });
});

describe("extractUsageFromCodexPayload", () => {
  test("reads nested usage object", () => {
    const u = extractUsageFromCodexPayload({
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    });
    expect(u).toEqual({
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
    });
  });

  test("reads top-level token fields", () => {
    const u = extractUsageFromCodexPayload({
      input_tokens: 5,
      output_tokens: 7,
    });
    expect(u?.promptTokens).toBe(5);
    expect(u?.completionTokens).toBe(7);
  });
});
