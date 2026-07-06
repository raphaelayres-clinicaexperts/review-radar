import type { PR, Config, Gate0, DRS, Risk } from "./types.ts";

const lc = (s: string) => s.toLowerCase();
const isTestPath = (p: string) => /test|spec|__tests__/.test(p);

function matchPaths(pr: PR, terms: string[]): string[] {
  const hits: string[] = [];
  for (const f of pr.files) {
    const p = lc(f.filename);
    if (isTestPath(p)) continue;
    for (const term of terms) {
      if (p.includes(lc(term)) && !hits.includes(term)) hits.push(term);
    }
  }
  return hits;
}

export function gate0(pr: PR, cfg: Config): Gate0 {
  const reasons: string[] = [];
  const hit = matchPaths(pr, cfg.blocklistPaths);
  const softHits = matchPaths(pr, cfg.softFlagPaths ?? []);
  if (hit.length) {
    reasons.push(`toca path crítico (${hit.join(", ")}) → revisão humana obrigatória`);
  }
  if (pr.draft) reasons.push("PR em rascunho (draft)");
  const trustedBot =
    pr.authorType === "Bot" &&
    cfg.trustedBots.some((b) => lc(pr.author) === lc(b));
  return {
    eligible: hit.length === 0 && !pr.draft,
    reasons,
    blocklistHit: hit,
    softHits,
    trustedBot,
  };
}

export function computeDRS(pr: PR, cfg: Config): DRS {
  const factors: string[] = [];
  let score = 0;
  const lines = pr.additions + pr.deletions;
  if (lines > cfg.size.askMinLines) {
    score += 45;
    factors.push(`PR gigante (${lines} linhas)`);
  } else if (lines > cfg.size.showMaxLines) {
    score += 28;
    factors.push(`PR grande (${lines} linhas)`);
  } else if (lines > cfg.size.shipMaxLines) {
    score += 12;
    factors.push(`PR médio (${lines} linhas)`);
  } else {
    factors.push(`PR pequeno (${lines} linhas)`);
  }

  if (pr.changedFiles > 20) {
    score += 15;
    factors.push(`${pr.changedFiles} arquivos`);
  } else if (pr.changedFiles > 8) {
    score += 7;
    factors.push(`${pr.changedFiles} arquivos`);
  }

  const crit = new Set<string>();
  for (const f of pr.files) {
    for (const a of cfg.drs.criticalAreas) {
      if (lc(f.filename).includes(lc(a))) crit.add(a);
    }
  }
  if (crit.size) {
    score += 20;
    factors.push(`área crítica (${[...crit].join(", ")})`);
  }

  const touchesSrc = pr.files.some(
    (f) =>
      /\.(ts|tsx|js|jsx|py|go|rb|php|java|kt|cs)$/.test(f.filename) &&
      !/test|spec|__tests__/.test(f.filename)
  );
  const touchesTest = pr.files.some((f) => /test|spec|__tests__/.test(f.filename));
  if (touchesSrc && !touchesTest && lines > cfg.size.shipMaxLines) {
    score += 12;
    factors.push("código sem teste acompanhando");
  }

  if (pr.deletions > pr.additions * 1.5 && pr.deletions > 100) {
    score += 8;
    factors.push("muita remoção (refactor/risco)");
  }

  score = Math.min(100, score);
  const risk: Risk = score >= 45 ? "high" : score >= 20 ? "medium" : "low";
  return { risk, score, factors };
}
