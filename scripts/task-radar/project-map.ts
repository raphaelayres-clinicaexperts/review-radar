import { readFileSync } from "node:fs";
import type { ProjectMap, ProjectModule, TaskIndexFile } from "./types.ts";

export function loadProjectMap(path = "project-map.json"): ProjectMap {
  return JSON.parse(readFileSync(path, "utf-8")) as ProjectMap;
}

export function loadProjectMapMarkdown(path = "project-map.md"): string {
  return readFileSync(path, "utf-8");
}

export function condenseProjectMapMarkdown(markdown: string): string {
  return markdown
    .split("\n")
    .filter((line) => !line.startsWith("Classes:"))
    .join("\n");
}

export function matchModuleForFile(
  filePath: string,
  modules: ProjectModule[]
): ProjectModule | null {
  let best: ProjectModule | null = null;
  for (const module of modules) {
    const isMatch = filePath === module.path || filePath.startsWith(`${module.path}/`);
    if (!isMatch) continue;
    if (!best || module.path.length > best.path.length) best = module;
  }
  return best;
}

export function deriveModulePaths(
  files: TaskIndexFile[],
  modules: ProjectModule[]
): string[] {
  const paths = new Set<string>();
  for (const file of files) {
    const module = matchModuleForFile(file.f, modules);
    if (module) paths.add(module.path);
  }
  return [...paths];
}

export function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function moduleByPath(path: string, modules: ProjectModule[]): ProjectModule | null {
  return modules.find((m) => m.path === path) ?? null;
}
