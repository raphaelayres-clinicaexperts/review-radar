import { mkdirSync, writeFileSync } from "node:fs";
import { FsStore } from "../lambda/store.ts";
import { fetchJiraTaskInput } from "./task-radar/jira-issue.ts";
import { loadPipelineDeps, analyzeTask } from "./task-radar/pipeline.ts";
import { toMarkdown } from "./task-radar/report.ts";
import type { TaskInput } from "./task-radar/types.ts";

const OUT_DIR = "task-analyses";

interface CliArgs {
  key?: string;
  title?: string;
  desc?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--key") args.key = argv[++i];
    if (argv[i] === "--title") args.title = argv[++i];
    if (argv[i] === "--desc") args.desc = argv[++i];
  }
  return args;
}

async function resolveTask(args: CliArgs): Promise<TaskInput> {
  if (args.key) return fetchJiraTaskInput(args.key);
  if (args.title) {
    return { key: null, title: args.title, description: args.desc ?? "", issueType: null };
  }
  throw new Error("Uso: bun run scripts/analyze-task.ts --key CE-XXXX | --title \"...\" --desc \"...\"");
}

function slugFor(task: TaskInput): string {
  if (task.key) return task.key;
  return task.title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60) || "task-sem-titulo";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const task = await resolveTask(args);

  console.log(`[analyze-task] analisando ${task.key ?? "(sem chave)"} — "${task.title}"...`);

  const deps = loadPipelineDeps();
  const store = new FsStore();
  const result = await analyzeTask(store, task, deps);

  mkdirSync(OUT_DIR, { recursive: true });
  const slug = slugFor(task);
  const outPath = `${OUT_DIR}/${slug}.json`;
  writeFileSync(outPath, JSON.stringify(result, null, 2));

  console.log(`[analyze-task] gravado em ${outPath}`);
  console.log("");
  console.log(toMarkdown(result));
}

main().catch((err) => {
  console.error("[analyze-task] falhou:", err);
  process.exit(1);
});
