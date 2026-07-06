import { difficultyFromLines, sumChangedLines } from "./metrics.ts";
import { jaccardSimilarity, tokenize } from "./text.ts";
import type { Difficulty, DifficultySource, TaskIndexEntry } from "./types.ts";

const TOP_N_SIMILAR = 5;
const MIN_SIMILAR_WITH_SCORE = 2;
const CLASS_RANK: Record<Difficulty, number> = { P: 0, M: 1, G: 2 };

export interface HybridDifficultyResult {
  difficulty: Difficulty;
  source: DifficultySource;
  medianLines: number | null;
  similarCount: number;
}

interface KeyCandidate {
  key: string;
  lines: number;
  score: number;
}

function representativeOf(entries: TaskIndexEntry[]): TaskIndexEntry {
  return [...entries].sort((a, b) => new Date(b.mergedAt).getTime() - new Date(a.mergedAt).getTime())[0]!;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// Agrega o task-index por key (uma task pode ter múltiplos PRs) e calcula, para cada key
// candidata, sua similaridade de título com a task avaliada e o total de linhas alteradas
// somando add+del de todos os PRs daquela key.
function buildCandidates(
  taskTitle: string,
  taskIndex: TaskIndexEntry[],
  excludeKeys: Set<string>
): KeyCandidate[] {
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
    const representative = representativeOf(entries);
    const score = jaccardSimilarity(targetTokens, tokenize(representative.jiraTitle ?? representative.title));
    const lines = sumChangedLines(entries.flatMap((e) => e.files));
    candidates.push({ key, lines, score });
  }
  return candidates;
}

// Dificuldade híbrida: a régua mecânica (mediana de linhas das top-5 tasks similares por
// título, excluindo a própria key) manda. O palpite do modelo só entra como fallback quando
// não há similares suficientes, ou como amortecedor quando a régua e o modelo discordam
// muito (P vs G) — nesse caso caímos para a classe do meio (M) em vez de confiar cegamente
// em qualquer um dos dois lados.
export function computeHybridDifficulty(
  taskTitle: string,
  taskIndex: TaskIndexEntry[],
  modelGuess: Difficulty,
  excludeKeys: Set<string>
): HybridDifficultyResult {
  const candidates = buildCandidates(taskTitle, taskIndex, excludeKeys);
  const withTitleScore = candidates.filter((c) => c.score > 0).sort((a, b) => b.score - a.score);

  if (withTitleScore.length < MIN_SIMILAR_WITH_SCORE) {
    return { difficulty: modelGuess, source: "model", medianLines: null, similarCount: withTitleScore.length };
  }

  const top5 = withTitleScore.slice(0, TOP_N_SIMILAR);
  const medianLines = median(top5.map((c) => c.lines));
  const mechanicalDifficulty = difficultyFromLines(medianLines);

  const diverges2Classes = Math.abs(CLASS_RANK[mechanicalDifficulty] - CLASS_RANK[modelGuess]) >= 2;
  if (diverges2Classes) {
    return { difficulty: "M", source: "middle", medianLines, similarCount: top5.length };
  }

  return { difficulty: mechanicalDifficulty, source: "mechanical", medianLines, similarCount: top5.length };
}
