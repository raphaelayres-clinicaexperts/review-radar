import { pathsOverlap } from "./project-map.ts";
import type { Difficulty, TaskIndexFile } from "./types.ts";

export interface PrecisionRecall {
  precision: number;
  recall: number;
}

export function precisionRecall(predicted: string[], real: string[]): PrecisionRecall {
  if (predicted.length === 0 && real.length === 0) return { precision: 1, recall: 1 };

  const truePositivesPred = predicted.filter((p) => real.some((r) => pathsOverlap(p, r))).length;
  const precision = predicted.length === 0 ? (real.length === 0 ? 1 : 0) : truePositivesPred / predicted.length;

  const truePositivesReal = real.filter((r) => predicted.some((p) => pathsOverlap(p, r))).length;
  const recall = real.length === 0 ? 1 : truePositivesReal / real.length;

  return { precision, recall };
}

export function sumChangedLines(files: TaskIndexFile[]): number {
  return files.reduce((total, f) => total + f.add + f.del, 0);
}

export function difficultyFromLines(lines: number): Difficulty {
  if (lines < 150) return "P";
  if (lines <= 600) return "M";
  return "G";
}
