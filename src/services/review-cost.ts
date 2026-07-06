import { readFileSync, writeFileSync, existsSync } from "node:fs";

export type BillingMode = "quota" | "api";

export interface CostLine {
  component: string;
  tokensIn: number;
  tokensOut: number;
  estimatedUSD: number;
}

export interface ReviewCostSummary {
  tokensIn: number;
  tokensOut: number;
  totalTokens: number;
  estimatedUSD: number;
  billingMode: BillingMode;
  model: string;
  lines: CostLine[];
}

const PRICING_PER_MILLION: Record<string, { input: number; output: number }> = {
  "gpt-5.4-mini": { input: 0.4, output: 1.6 },
  "gpt-5.4": { input: 2.5, output: 10 },
  "gpt-5.3-codex": { input: 2, output: 8 },
  "gpt-5-codex": { input: 2, output: 8 },
  "gpt-5-codex-mini": { input: 0.4, output: 1.6 },
};

const REVIEW_COST_FILE = "./review-cost-session.json";

export function resolveBillingMode(): BillingMode {
  return process.env.REVIEW_BILLING_MODE === "api" ? "api" : "quota";
}

export function estimateUsd(
  model: string,
  tokensIn: number,
  tokensOut: number,
  billingMode: BillingMode = resolveBillingMode()
): number {
  if (billingMode === "quota") return 0;
  const pricing = PRICING_PER_MILLION[model] ?? PRICING_PER_MILLION["gpt-5.4-mini"]!;
  const inputCost = (tokensIn / 1_000_000) * pricing.input;
  const outputCost = (tokensOut / 1_000_000) * pricing.output;
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000;
}

export function aggregateCost(
  model: string,
  lines: CostLine[],
  billingMode: BillingMode = resolveBillingMode()
): ReviewCostSummary {
  const tokensIn = lines.reduce((s, l) => s + l.tokensIn, 0);
  const tokensOut = lines.reduce((s, l) => s + l.tokensOut, 0);
  const estimatedUSD =
    billingMode === "quota"
      ? 0
      : lines.reduce((s, l) => s + l.estimatedUSD, 0);
  return {
    tokensIn,
    tokensOut,
    totalTokens: tokensIn + tokensOut,
    estimatedUSD: Math.round(estimatedUSD * 1_000_000) / 1_000_000,
    billingMode,
    model,
    lines,
  };
}

export function lineCost(
  component: string,
  model: string,
  tokensIn: number,
  tokensOut: number,
  billingMode: BillingMode = resolveBillingMode()
): CostLine {
  return {
    component,
    tokensIn,
    tokensOut,
    estimatedUSD: estimateUsd(model, tokensIn, tokensOut, billingMode),
  };
}

type PersistedReviewCost = {
  reviews: number;
  tokensIn: number;
  tokensOut: number;
  estimatedUSD: number;
  savedAt: string;
};

export function persistReviewCost(summary: ReviewCostSummary): void {
  const prev: PersistedReviewCost = existsSync(REVIEW_COST_FILE)
    ? (JSON.parse(readFileSync(REVIEW_COST_FILE, "utf-8")) as PersistedReviewCost)
    : { reviews: 0, tokensIn: 0, tokensOut: 0, estimatedUSD: 0, savedAt: "" };
  const next: PersistedReviewCost = {
    reviews: prev.reviews + 1,
    tokensIn: prev.tokensIn + summary.tokensIn,
    tokensOut: prev.tokensOut + summary.tokensOut,
    estimatedUSD: Math.round((prev.estimatedUSD + summary.estimatedUSD) * 1_000_000) / 1_000_000,
    savedAt: new Date().toISOString(),
  };
  writeFileSync(REVIEW_COST_FILE, JSON.stringify(next, null, 2));
}

export function loadReviewCostSession(): PersistedReviewCost | null {
  if (!existsSync(REVIEW_COST_FILE)) return null;
  try {
    return JSON.parse(readFileSync(REVIEW_COST_FILE, "utf-8")) as PersistedReviewCost;
  } catch {
    return null;
  }
}

export function formatCostPt(summary: ReviewCostSummary): string {
  const usd =
    summary.billingMode === "quota"
      ? "$0 (cota ChatGPT Pro)"
      : `$${summary.estimatedUSD.toFixed(6)} USD`;
  const parts = summary.lines
    .map(
      (l) =>
        `  ${l.component}: ${l.tokensIn} in / ${l.tokensOut} out · $${l.estimatedUSD.toFixed(6)}`
    )
    .join("\n");
  return `Custo: ${summary.tokensIn} in / ${summary.tokensOut} out · total ${summary.totalTokens} tokens · ${usd}\n${parts}`;
}
