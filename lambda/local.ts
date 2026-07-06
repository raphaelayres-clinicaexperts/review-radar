import { parseRef } from "../src/radar/github.ts";
import { FsStore } from "./store.ts";
import { runWorker } from "./worker.ts";

function parseArgs(argv: string[]): { pr: string; dryRun: boolean } {
  let pr = "";
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--pr") {
      pr = argv[i + 1] ?? "";
      i++;
    } else if (argv[i] === "--dry-run") {
      dryRun = true;
    }
  }
  if (!pr) throw new Error("Uso: bun lambda/local.ts --pr owner/repo#123 [--dry-run]");
  return { pr, dryRun };
}

async function main(): Promise<void> {
  process.env.STORE = "fs";
  const { pr, dryRun } = parseArgs(process.argv.slice(2));
  const { owner, repo, number } = parseRef(pr);

  if (!process.env.GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN não configurado no ambiente/.env");
  }

  const store = new FsStore();
  const result = await runWorker(
    { owner, repo, number, forceReeval: true },
    store,
    { dryRun }
  );

  console.log(`\nstatus: ${result.status}${result.reason ? ` (${result.reason})` : ""}`);
  process.exit(result.status === "error" ? 1 : 0);
}

main().catch((err) => {
  console.error("[local] falhou:", err instanceof Error ? err.message : err);
  process.exit(1);
});
