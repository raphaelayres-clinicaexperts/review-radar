import { createHmac } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { capDiff, hasSkipLabel, isBotLogin, isGeneratedFile } from "../lambda/github-pr.ts";
import { parseWebhookJob, verifySignature } from "../lambda/webhook.ts";
import type { PR } from "../src/radar/types.ts";

const secret = "test-secret";

function signedBody(body: string): { rawBody: string; signature: string } {
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return { rawBody: body, signature };
}

const samplePr = (overrides: Partial<PR> = {}): PR => ({
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
  files: [],
  ...overrides,
});

describe("webhook signature verification", () => {
  it("accepts a valid HMAC signature", () => {
    const { rawBody, signature } = signedBody('{"hello":"world"}');
    expect(verifySignature(rawBody, signature, secret)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const { signature } = signedBody('{"hello":"world"}');
    expect(verifySignature('{"hello":"tampered"}', signature, secret)).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(verifySignature('{"hello":"world"}', undefined, secret)).toBe(false);
  });
});

describe("parseWebhookJob", () => {
  it("builds a job for an opened non-draft pull_request", () => {
    const payload = JSON.stringify({
      action: "opened",
      pull_request: { number: 42, draft: false, user: { login: "dev", type: "User" } },
      repository: { owner: { login: "org" }, name: "app" },
    });
    const job = parseWebhookJob("pull_request", payload);
    expect(job).toEqual({ owner: "org", repo: "app", number: 42, forceReeval: false });
  });

  it("ignores draft pull requests", () => {
    const payload = JSON.stringify({
      action: "opened",
      pull_request: { number: 42, draft: true, user: { login: "dev", type: "User" } },
      repository: { owner: { login: "org" }, name: "app" },
    });
    expect(parseWebhookJob("pull_request", payload)).toBeNull();
  });

  it("ignores pull requests opened by bots", () => {
    const payload = JSON.stringify({
      action: "opened",
      pull_request: { number: 42, draft: false, user: { login: "dependabot[bot]", type: "Bot" } },
      repository: { owner: { login: "org" }, name: "app" },
    });
    expect(parseWebhookJob("pull_request", payload)).toBeNull();
  });

  it("builds a forced reeval job when a comment says @radar reavaliar on a PR", () => {
    const payload = JSON.stringify({
      action: "created",
      issue: { number: 7, pull_request: {} },
      comment: { body: "@radar reavaliar por favor", user: { login: "dev", type: "User" } },
      repository: { owner: { login: "org" }, name: "app" },
    });
    const job = parseWebhookJob("issue_comment", payload);
    expect(job).toEqual({ owner: "org", repo: "app", number: 7, forceReeval: true });
  });

  it("ignores issue comments without the trigger phrase", () => {
    const payload = JSON.stringify({
      action: "created",
      issue: { number: 7, pull_request: {} },
      comment: { body: "nice work", user: { login: "dev", type: "User" } },
      repository: { owner: { login: "org" }, name: "app" },
    });
    expect(parseWebhookJob("issue_comment", payload)).toBeNull();
  });

  it("ignores comments on issues that are not pull requests", () => {
    const payload = JSON.stringify({
      action: "created",
      issue: { number: 7 },
      comment: { body: "@radar reavaliar", user: { login: "dev", type: "User" } },
      repository: { owner: { login: "org" }, name: "app" },
    });
    expect(parseWebhookJob("issue_comment", payload)).toBeNull();
  });
});

describe("github-pr helpers", () => {
  it("detects bot logins", () => {
    expect(isBotLogin("dependabot[bot]")).toBe(true);
    expect(isBotLogin("raphael")).toBe(false);
  });

  it("detects the skip-radar label", () => {
    expect(hasSkipLabel(["skip-radar", "bug"])).toBe(true);
    expect(hasSkipLabel(["bug"])).toBe(false);
  });

  it("flags lockfiles as generated", () => {
    expect(isGeneratedFile("bun.lock")).toBe(true);
    expect(isGeneratedFile("package-lock.json")).toBe(true);
    expect(isGeneratedFile("src/index.ts")).toBe(false);
  });

  it("strips patches for generated files", () => {
    const pr = samplePr({ files: [{ filename: "bun.lock", status: "modified", additions: 500, deletions: 500, patch: "x".repeat(1000) }] });
    const result = capDiff(pr, 100_000);
    expect(result.pr.files[0]!.patch).toBeUndefined();
    expect(result.ignoredGenerated).toContain("bun.lock");
  });

  it("truncates diffs larger than the cap", () => {
    const pr = samplePr({
      files: [
        { filename: "a.ts", status: "modified", additions: 1, deletions: 0, patch: "a".repeat(60) },
        { filename: "b.ts", status: "modified", additions: 1, deletions: 0, patch: "b".repeat(60) },
      ],
    });
    const result = capDiff(pr, 100);
    expect(result.truncated).toBe(true);
    expect(result.pr.files[1]!.patch).toBeUndefined();
  });
});
