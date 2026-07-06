import { readFileSync, existsSync } from "node:fs";
import { radar } from "../radar/engine.ts";
import { parseRef, fetchPR } from "../radar/github.ts";
import { reviewAsGabi } from "../reviewer/gabi.ts";
import {
  aggregateCost,
  lineCost,
  persistReviewCost,
  resolveBillingMode,
  type ReviewCostSummary,
} from "./review-cost.ts";
import type { Config, RadarResult } from "../radar/types.ts";
import type { GabiReviewResult } from "../reviewer/types.ts";

export type ReviewMode = "full" | "radar-only" | "gabi-only";

export interface PipelineResult {
  pr: string;
  mode: ReviewMode;
  radar: RadarResult | null;
  review: GabiReviewResult | null;
  cost: ReviewCostSummary;
}

const CONFIG_PATH = process.env.RADAR_CONFIG_PATH || "./radar.config.json";

export function loadRadarConfig(): Config {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Config não encontrada: ${CONFIG_PATH}`);
  }
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Config;
}

export async function runReviewPipeline(
  prRef: string,
  mode: ReviewMode = "full",
  opts?: { skipCodex?: boolean; persistCost?: boolean }
): Promise<PipelineResult> {
  const { owner, repo, number } = parseRef(prRef);
  const cfg = loadRadarConfig();
  if (opts?.skipCodex) cfg.codex.enabled = false;

  const billingMode = resolveBillingMode();
  const model = cfg.codex.model || process.env.CODEX_REVIEW_MODEL || "gpt-5.4-mini";
  const costLines: ReturnType<typeof lineCost>[] = [];

  let radarResult: RadarResult | null = null;
  let gabiResult: GabiReviewResult | null = null;

  if (mode === "full" || mode === "radar-only") {
    radarResult = await radar(owner, repo, number, cfg);
    if (radarResult.codex.ran) {
      costLines.push(
        lineCost(
          radarResult.codex.passes === 2 ? "radar-gate3-x2" : "radar-gate3",
          model,
          radarResult.codex.tokensIn,
          radarResult.codex.tokensOut,
          billingMode
        )
      );
    }
  }

  const shouldRunGabi =
    mode === "gabi-only" ||
    (mode === "full" && radarResult && radarResult.route !== "SHIP");

  if (shouldRunGabi) {
    const pr = radarResult?.pr ?? (await fetchPR(owner, repo, number));
    gabiResult = await reviewAsGabi(pr, model);
    if (gabiResult.ran) {
      costLines.push(
        lineCost("gabi-reviewer", model, gabiResult.tokensIn, gabiResult.tokensOut, billingMode)
      );
    }
  }

  const cost = aggregateCost(model, costLines, billingMode);
  if (opts?.persistCost !== false) persistReviewCost(cost);

  return {
    pr: `${owner}/${repo}#${number}`,
    mode,
    radar: radarResult,
    review: gabiResult,
    cost,
  };
}
