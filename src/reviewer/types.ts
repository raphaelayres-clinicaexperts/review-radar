export type GabiSeverity = "Pedir mudança" | "Sugestão" | "Dúvida";

export interface GabiFinding {
  severity: GabiSeverity;
  file: string;
  line?: number;
  theme: string;
  change: string;
  comment: string;
}

export interface GabiReviewResult {
  ran: boolean;
  summary: string;
  findings: GabiFinding[];
  commentReady: string;
  tokensIn: number;
  tokensOut: number;
  skipped?: string;
}
