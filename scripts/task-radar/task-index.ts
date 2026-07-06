import { readFileSync } from "node:fs";
import { jaccardSimilarity, tokenize } from "./text.ts";
import { deriveModulePaths } from "./project-map.ts";
import type { ProjectModule, SimilarTaskRef, TaskIndexEntry, TaskIndexFile } from "./types.ts";

// PRs de subida de pacote/versão (bump de dependência) não são trabalho real — não devem
// aparecer como "tasks parecidas" no retrieval/rerank do task-radar-v7. Critérios (qualquer um
// já basta pra excluir):
//   a) título (jiraTitle ?? title) ou branch batem com padrão de bump de dependência;
//   b) >=80% dos files da entry são arquivo de lockfile/manifest de pacote;
//   c) key nula E <=2 files, todos eles lockfile/manifest de pacote (PR anônimo, só config).
const BUMP_TITLE_PATTERN =
  /\b(bump|update|upgrade|atualiza)\b.*\b(package|pacote|composer|dependenc|versão|version)\b/i;
const BUMP_BRANCH_PATTERN = /(^|\/)(update|bump)-/i;
const PACKAGE_FILE_PATTERN = /(^|\/)(composer\.(json|lock)|package(-lock)?\.json|yarn\.lock)$/i;

function isPackageFile(file: TaskIndexFile): boolean {
  return PACKAGE_FILE_PATTERN.test(file.f);
}

export function isPackageBumpEntry(entry: TaskIndexEntry): boolean {
  const title = entry.jiraTitle ?? entry.title ?? "";
  if (BUMP_TITLE_PATTERN.test(title) || BUMP_BRANCH_PATTERN.test(entry.branch ?? "")) return true;

  const files = entry.files ?? [];
  if (files.length === 0) return false;

  const packageFilesCount = files.filter(isPackageFile).length;
  if (packageFilesCount / files.length >= 0.8) return true;

  if (entry.key === null && files.length <= 2 && files.every(isPackageFile)) return true;

  return false;
}

export function loadTaskIndex(path = "task-index.json"): TaskIndexEntry[] {
  const entries = JSON.parse(readFileSync(path, "utf-8")) as TaskIndexEntry[];
  return entries.filter((entry) => !isPackageBumpEntry(entry));
}

export interface RankSimilarOptions {
  excludeKeys?: Set<string>;
  excludePrs?: Set<number>;
  topN?: number;
}

export function rankSimilarTasks(
  title: string,
  entries: TaskIndexEntry[],
  modules: ProjectModule[],
  options: RankSimilarOptions = {}
): SimilarTaskRef[] {
  const topN = options.topN ?? 15;
  const targetTokens = tokenize(title);

  const scored = entries
    .filter((entry) => !options.excludeKeys || !entry.key || !options.excludeKeys.has(entry.key))
    .filter((entry) => !options.excludePrs || !options.excludePrs.has(entry.pr))
    .map((entry) => ({
      entry,
      score: jaccardSimilarity(targetTokens, tokenize(entry.jiraTitle ?? entry.title)),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);

  return scored.map(({ entry, score }) => ({
    key: entry.key,
    pr: entry.pr,
    title: entry.title,
    modules: deriveModulePaths(entry.files, modules),
    score,
  }));
}
