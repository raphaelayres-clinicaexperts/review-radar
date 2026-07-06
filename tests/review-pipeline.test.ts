import { describe, expect, it } from "bun:test";
import {
  aggregateCost,
  estimateUsd,
  lineCost,
  resolveBillingMode,
} from "../src/services/review-cost.ts";
import { isGithubWriteEnabled } from "../src/services/review-config.ts";
import { gate0, computeDRS } from "../src/radar/gates.ts";
import type { PR, Config } from "../src/radar/types.ts";

const baseCfg: Config = {
  blocklistPaths: ["auth", "payment", "migration"],
  size: { shipMaxLines: 80, showMaxLines: 400, askMinLines: 800 },
  drs: { appetite: "P25", criticalAreas: ["payment", "auth"] },
  codex: {
    enabled: true,
    model: "gpt-5.4-mini",
    reasoningEffort: "high",
    shipConcordance: 2,
    maxLinesForCodex: 600,
    minConfidenceToShip: 8,
    runOnlyWhenRiskBetween: ["low", "medium"],
  },
  trustedBots: ["dependabot[bot]"],
  autoMerge: {
    enabled: false,
    minConfidence: 9,
    maxLines: 60,
    allowAuthors: ["dependabot[bot]"],
  },
};

const samplePR = (overrides: Partial<PR> = {}): PR => ({
  owner: "org",
  repo: "app",
  number: 1,
  title: "fix",
  url: "https://github.com/org/app/pull/1",
  author: "dev",
  authorType: "User",
  additions: 10,
  deletions: 5,
  changedFiles: 1,
  draft: false,
  baseRef: "main",
  headSha: "abc",
  files: [{ filename: "src/foo.ts", status: "modified", additions: 10, deletions: 5 }],
  ...overrides,
});

describe("review-cost", () => {
  it("returns zero USD in quota billing mode", () => {
    expect(estimateUsd("gpt-5.4-mini", 5000, 2000, "quota")).toBe(0);
  });

  it("estimates USD in api billing mode", () => {
    const usd = estimateUsd("gpt-5.4-mini", 1_000_000, 1_000_000, "api");
    expect(usd).toBeGreaterThan(0);
  });

  it("aggregates multiple cost lines", () => {
    const summary = aggregateCost(
      "gpt-5.4-mini",
      [
        lineCost("radar", "gpt-5.4-mini", 1000, 500, "api"),
        lineCost("gabi", "gpt-5.4-mini", 4000, 1500, "api"),
      ],
      "api"
    );
    expect(summary.tokensIn).toBe(5000);
    expect(summary.tokensOut).toBe(2000);
    expect(summary.lines.length).toBe(2);
    expect(summary.estimatedUSD).toBeGreaterThan(0);
  });

  it("defaults billing mode to quota", () => {
    const prev = process.env.REVIEW_BILLING_MODE;
    delete process.env.REVIEW_BILLING_MODE;
    expect(resolveBillingMode()).toBe("quota");
    if (prev) process.env.REVIEW_BILLING_MODE = prev;
  });

  it("defaults github write to disabled", () => {
    const prev = process.env.REVIEW_GITHUB_WRITE;
    delete process.env.REVIEW_GITHUB_WRITE;
    expect(isGithubWriteEnabled()).toBe(false);
    if (prev) process.env.REVIEW_GITHUB_WRITE = prev;
  });
});

describe("radar gates", () => {
  it("blocks PR touching payment path", () => {
    const g = gate0(
      samplePR({
        files: [{ filename: "app/Services/PaymentService.php", status: "modified", additions: 5, deletions: 1 }],
      }),
      baseCfg
    );
    expect(g.eligible).toBe(false);
    expect(g.blocklistHit).toContain("payment");
  });

  it("marks small PR as low risk", () => {
    const drs = computeDRS(samplePR(), baseCfg);
    expect(drs.risk).toBe("low");
    expect(drs.score).toBeLessThan(20);
  });

  it("marks large PR as high risk", () => {
    const drs = computeDRS(
      samplePR({ additions: 900, deletions: 100, changedFiles: 25 }),
      baseCfg
    );
    expect(drs.risk).toBe("high");
  });
});
