export interface ProjectModule {
  name: string;
  path: string;
  files: number;
  classes: string[];
  summary: string;
}

export interface ProjectMap {
  generatedAt: string;
  commit: string;
  modules: ProjectModule[];
}

export interface TaskIndexFile {
  f: string;
  add: number;
  del: number;
}

export interface TaskIndexEntry {
  key: string | null;
  pr: number;
  title: string;
  mergedAt: string;
  branch: string;
  files: TaskIndexFile[];
  // Preenchidos por scripts/enrich-task-index.ts a partir do Jira. `title` continua sendo o
  // nome da branch (sem semântica) — jiraTitle é o summary real da issue, quando disponível.
  jiraTitle?: string | null;
  issueType?: string | null;
}

export interface SimilarTaskRef {
  key: string | null;
  pr: number;
  title: string;
  modules: string[];
  score: number;
}

export interface TaskInput {
  key: string | null;
  title: string;
  description: string;
  issueType: string | null;
}

export interface CandidateModule {
  path: string;
  reason: string;
}

export interface Call1Result {
  candidateModules: CandidateModule[];
  similarTasks: Array<string | null>;
  needsCode: string[];
}

export interface ModuleAssessment {
  path: string;
  confidence: number;
  what: string;
}

export type Difficulty = "P" | "M" | "G";

// Fonte que decidiu a dificuldade FINAL de uma task (v4): "mechanical" quando a mediana de
// linhas dos similares manda, "model" quando não há similares suficientes (fallback pro
// palpite do modelo), "middle" quando modelo e mediana divergem 2 classes (P vs G) e caímos
// pro M como meio-termo.
export type DifficultySource = "mechanical" | "model" | "middle";

export interface SimilarNote {
  key: string | null;
  pr: number;
  note: string;
}

export interface DuplicateFlag {
  suspected: boolean;
  why: string;
}

export interface TaskAnalysis {
  estimatedLines: number;
  difficulty: Difficulty;
  score: number;
  rationale: string;
  modules: ModuleAssessment[];
  risks: string[];
  split: string[] | null;
  similar: SimilarNote[];
  duplicateFlag: DuplicateFlag;
}

export interface PipelineUsage {
  promptTokens: number;
  completionTokens: number;
  calls: number;
}

export interface CodeSnippet {
  path: string;
  content: string;
  truncated: boolean;
}

export interface PipelineResult {
  task: TaskInput;
  similarTasksUsed: SimilarTaskRef[];
  call1: Call1Result;
  codeSnippets: CodeSnippet[];
  analysis: TaskAnalysis;
  usage: PipelineUsage;
  difficultySource: DifficultySource;
  difficultyMedianLines: number | null;
  difficultySimilarCount: number;
}
