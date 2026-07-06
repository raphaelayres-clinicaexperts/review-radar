import { difficultyFromLines, sumChangedLines } from "./metrics.ts";
import type { Difficulty, TaskIndexEntry } from "./types.ts";

export interface DifficultyExample {
  key: string | null;
  title: string;
  lines: number;
  difficulty: Difficulty;
}

export interface DifficultyExampleOptions {
  excludeKeys?: Set<string>;
  perBucket?: number;
}

const BUCKET_ORDER: Difficulty[] = ["P", "M", "G"];

export function buildDifficultyExamples(
  taskIndex: TaskIndexEntry[],
  options: DifficultyExampleOptions = {}
): DifficultyExample[] {
  const perBucket = options.perBucket ?? 4;

  const byKey = new Map<string, TaskIndexEntry[]>();
  for (const entry of taskIndex) {
    if (!entry.key) continue;
    if (options.excludeKeys?.has(entry.key)) continue;
    const bucket = byKey.get(entry.key) ?? [];
    bucket.push(entry);
    byKey.set(entry.key, bucket);
  }

  const candidates: DifficultyExample[] = [];
  for (const entries of byKey.values()) {
    const representative = [...entries].sort(
      (a, b) => new Date(b.mergedAt).getTime() - new Date(a.mergedAt).getTime()
    )[0]!;
    if (representative.files.length < 3) continue;

    const lines = sumChangedLines(entries.flatMap((e) => e.files));
    if (lines <= 0) continue;

    candidates.push({
      key: representative.key,
      title: representative.title,
      lines,
      difficulty: difficultyFromLines(lines),
    });
  }

  const buckets: Record<Difficulty, DifficultyExample[]> = { P: [], M: [], G: [] };
  for (const c of candidates) buckets[c.difficulty].push(c);

  const picked: DifficultyExample[] = [];
  for (const d of BUCKET_ORDER) {
    picked.push(...pickRepresentative(buckets[d], perBucket));
  }
  return picked;
}

// O título em TaskIndexEntry é o título do branch/PR (ex.: "hotfix/CE-12751"), sem valor
// semântico para calibrar dificuldade. Troca pelo título real da issue quando possível,
// mantendo o título do branch como fallback se a busca falhar.
export async function resolveDifficultyExampleTitles(
  examples: DifficultyExample[],
  fetchTitle: (key: string) => Promise<string>
): Promise<DifficultyExample[]> {
  return Promise.all(
    examples.map(async (example) => {
      if (!example.key) return example;
      try {
        const title = await fetchTitle(example.key);
        return { ...example, title };
      } catch {
        return example;
      }
    })
  );
}

// Pega exemplos espalhados ao longo da faixa de linhas do bucket (não os extremos, não os
// primeiros por ordem alfabética) para evitar ancorar o modelo em outliers.
function pickRepresentative(bucket: DifficultyExample[], count: number): DifficultyExample[] {
  if (bucket.length <= count) return bucket;

  const sorted = [...bucket].sort((a, b) => a.lines - b.lines);
  const picked: DifficultyExample[] = [];
  for (let i = 0; i < count; i++) {
    const fraction = (i + 1) / (count + 1);
    const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
    picked.push(sorted[index]!);
  }
  return picked;
}
