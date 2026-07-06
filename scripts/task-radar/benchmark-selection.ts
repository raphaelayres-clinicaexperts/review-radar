import type { TaskIndexEntry } from "./types.ts";

export interface BenchmarkTask {
  key: string;
  representativeEntry: TaskIndexEntry;
  allEntries: TaskIndexEntry[];
}

export function selectBenchmarkTasks(entries: TaskIndexEntry[], count = 20): BenchmarkTask[] {
  const byKey = new Map<string, TaskIndexEntry[]>();
  for (const entry of entries) {
    if (!entry.key) continue;
    const bucket = byKey.get(entry.key) ?? [];
    bucket.push(entry);
    byKey.set(entry.key, bucket);
  }

  const candidates: BenchmarkTask[] = [];
  for (const [key, allEntries] of byKey) {
    const representativeEntry = [...allEntries].sort(
      (a, b) => new Date(b.mergedAt).getTime() - new Date(a.mergedAt).getTime()
    )[0]!;
    if (representativeEntry.files.length < 3) continue;
    candidates.push({ key, representativeEntry, allEntries });
  }

  candidates.sort(
    (a, b) =>
      new Date(b.representativeEntry.mergedAt).getTime() -
      new Date(a.representativeEntry.mergedAt).getTime()
  );

  return candidates.slice(0, count);
}
