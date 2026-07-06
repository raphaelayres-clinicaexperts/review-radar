// Task Radar v7 — bucket de esforço (P/M/G) por k-NN puro, SEM LLM e SEM palpite de modelo.
//
// Mesma régua mecânica do v4 (difficulty-hybrid.ts): mediana de linhas (add+del) dos top-5
// PRs históricos mais parecidos por título (jaccard sobre jiraTitle ?? title), excluindo a
// própria key. Diferença deliberada em relação ao v4: aqui não há fallback pro palpite do
// modelo. Se não houver pelo menos 2 similares com score > 0, o resultado é "indefinido" —
// honesto sobre a falta de dado em vez de arriscar um chute.
//
// Régua: <150 linhas = P, 150-600 = M, >600 = G.
//
// Uso: bun run scripts/task-radar-v7/effort.ts "Corrigir erro ao carregar usuários no admin"

import { join } from "node:path";
import { difficultyFromLines, sumChangedLines } from "../task-radar/metrics.ts";
import { loadTaskIndex } from "../task-radar/task-index.ts";
import { jaccardSimilarity, tokenize } from "../task-radar/text.ts";
import type { Difficulty, TaskIndexEntry } from "../task-radar/types.ts";

const TOP_N_SIMILAR = 5;
const MIN_SIMILAR_WITH_SCORE = 2;

export type EffortBucket = Difficulty | "indefinido";

export interface EffortResult {
  bucket: EffortBucket;
  medianLines: number | null;
  similarCount: number;
  similarKeys: string[];
}

interface KeyCandidate {
  key: string;
  lines: number;
  score: number;
}

function representativeTitle(entries: TaskIndexEntry[]): string {
  const representative = [...entries].sort(
    (a, b) => new Date(b.mergedAt).getTime() - new Date(a.mergedAt).getTime()
  )[0]!;
  return representative.jiraTitle ?? representative.title;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// Agrega o task-index por key (uma task pode ter múltiplos PRs — hotfix/follow-up) e calcula,
// para cada key candidata, sua similaridade de título com a task avaliada e o total de linhas
// alteradas somando add+del de todos os PRs daquela key.
function buildCandidates(taskTitle: string, taskIndex: TaskIndexEntry[], excludeKeys: Set<string>): KeyCandidate[] {
  const targetTokens = tokenize(taskTitle);

  const byKey = new Map<string, TaskIndexEntry[]>();
  for (const entry of taskIndex) {
    if (!entry.key) continue;
    if (excludeKeys.has(entry.key)) continue;
    const bucket = byKey.get(entry.key) ?? [];
    bucket.push(entry);
    byKey.set(entry.key, bucket);
  }

  const candidates: KeyCandidate[] = [];
  for (const [key, entries] of byKey) {
    const score = jaccardSimilarity(targetTokens, tokenize(representativeTitle(entries)));
    const lines = sumChangedLines(entries.flatMap((e) => e.files));
    candidates.push({ key, lines, score });
  }
  return candidates;
}

export function estimateEffort(
  taskTitle: string,
  taskIndex: TaskIndexEntry[],
  excludeKeys: Set<string> = new Set()
): EffortResult {
  const candidates = buildCandidates(taskTitle, taskIndex, excludeKeys);
  const withScore = candidates.filter((c) => c.score > 0).sort((a, b) => b.score - a.score);

  if (withScore.length < MIN_SIMILAR_WITH_SCORE) {
    return {
      bucket: "indefinido",
      medianLines: null,
      similarCount: withScore.length,
      similarKeys: withScore.map((c) => c.key),
    };
  }

  const top5 = withScore.slice(0, TOP_N_SIMILAR);
  const medianLines = median(top5.map((c) => c.lines));

  return {
    bucket: difficultyFromLines(medianLines),
    medianLines,
    similarCount: top5.length,
    similarKeys: top5.map((c) => c.key),
  };
}

if (import.meta.main) {
  // Caminho computado aqui dentro (não em const de topo de módulo): este bloco só roda via
  // `bun run` direto, onde import.meta.dir é garantido pelo runtime Bun. estimateEffort() em
  // si não depende disso — recebe taskIndex já carregado (ver lambda/handler.ts, que carrega
  // via loadTaskIndex(join(dataDir, "task-index.json")) com TASK_RADAR_DATA_DIR do S3).
  const taskIndexPath = join(import.meta.dir, "../../task-index.json");
  const taskIndex = loadTaskIndex(taskIndexPath);
  const sampleTitle = process.argv[2] ?? "Corrigir erro ao carregar usuários no admin";
  console.log(JSON.stringify(estimateEffort(sampleTitle, taskIndex), null, 2));
}
