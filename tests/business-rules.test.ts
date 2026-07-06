import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { buildBusinessRulesContext, resetBusinessRulesCacheForTests } from "../lambda/business-rules.ts";
import type { PR } from "../src/radar/types.ts";

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

describe("buildBusinessRulesContext", () => {
  beforeEach(() => {
    resetBusinessRulesCacheForTests();
  });

  afterEach(() => {
    delete process.env.BUSINESS_RULES;
    resetBusinessRulesCacheForTests();
  });

  it("returns empty string when BUSINESS_RULES=off (kill switch)", async () => {
    process.env.BUSINESS_RULES = "off";
    const pr = samplePR({ files: [{ filename: "app/Services/PaymentService.php", status: "modified", additions: 1, deletions: 0 }] });
    const result = await buildBusinessRulesContext(pr);
    expect(result).toBe("");
  });

  it("never throws when S3/registry is unreachable — degrades to empty string", async () => {
    const pr = samplePR({ files: [{ filename: "app/Services/PaymentService.php", status: "modified", additions: 1, deletions: 0 }] });
    await expect(buildBusinessRulesContext(pr)).resolves.toEqual(expect.any(String));
  });

  it("returns empty string when no file matches any domain path pattern (no registry needed either way)", async () => {
    const pr = samplePR({ files: [{ filename: "src/unrelated/index.ts", status: "modified", additions: 1, deletions: 0 }] });
    const result = await buildBusinessRulesContext(pr);
    expect(result).toBe("");
  });
});
