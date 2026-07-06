export type Risk = "low" | "medium" | "high";
export type Route = "SHIP" | "SHOW" | "ASK";
export type CommentTag = "issue" | "suggestion" | "nitpick" | "question" | "note" | "praise";

export interface PRFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface PR {
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  authorType: "User" | "Bot";
  additions: number;
  deletions: number;
  changedFiles: number;
  draft: boolean;
  baseRef: string;
  headRef: string;
  headSha: string;
  files: PRFile[];
}

export interface CI {
  state: "success" | "failure" | "pending" | "none";
  total: number;
  failing: string[];
}

export interface Finding {
  tag: CommentTag;
  file?: string;
  line?: number;
  body: string;
  fix?: string;
}

export interface CodexResult {
  ran: boolean;
  confidence: number;
  verdict: "approve" | "comment" | "block";
  summary: string;
  findings: Finding[];
  tokensIn: number;
  tokensOut: number;
  skipped?: string;
  passes?: number;
}

export interface Gate0 {
  eligible: boolean;
  reasons: string[];
  blocklistHit: string[];
  softHits?: string[];
  trustedBot: boolean;
}

export interface DRS {
  risk: Risk;
  score: number;
  factors: string[];
}

export interface RadarResult {
  pr: PR;
  ci: CI;
  gate0: Gate0;
  drs: DRS;
  codex: CodexResult;
  route: Route;
  rationale: string;
  findings: Finding[];
}

export interface Config {
  blocklistPaths: string[];
  softFlagPaths?: string[];
  size: { shipMaxLines: number; showMaxLines: number; askMinLines: number };
  drs: { appetite: string; criticalAreas: string[] };
  codex: {
    enabled: boolean;
    model: string;
    reasoningEffort: string;
    shipConcordance: number;
    maxLinesForCodex: number;
    minConfidenceToShip: number;
    minConfidenceToBlock?: number;
    runOnlyWhenRiskBetween: Risk[];
  };
  trustedBots: string[];
  autoMerge: {
    enabled: boolean;
    minConfidence: number;
    maxLines: number;
    allowAuthors: string[];
  };
}
