import { readFileSync, writeFileSync } from "node:fs";
import { mapWithConcurrency } from "./task-radar/concurrency.ts";
import type { TaskIndexEntry } from "./task-radar/types.ts";

const INDEX_PATH = "task-index.json";
const CONCURRENCY = 8;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface JiraIssueLite {
  key: string;
  fields: {
    summary: string;
    issuetype?: { name: string };
  };
}

interface EnrichResult {
  key: string;
  jiraTitle: string | null;
  issueType: string | null;
  found: boolean;
}

function jiraAuthHeader(): string {
  const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_TOKEN}`).toString("base64");
  return `Basic ${auth}`;
}

async function fetchIssueLite(key: string, attempts = 3): Promise<EnrichResult> {
  const base = (process.env.JIRA_BASE_URL ?? "").replace(/\/$/, "");
  const url = `${base}/rest/api/3/issue/${key}?fields=summary,issuetype`;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(800 * attempt);

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: jiraAuthHeader(), Accept: "application/json" },
      });
    } catch (err) {
      if (attempt === attempts - 1) {
        console.warn(`[enrich] ${key}: falha de rede — ${String(err).slice(0, 150)}`);
        return { key, jiraTitle: null, issueType: null, found: false };
      }
      continue;
    }

    if (res.status === 404) {
      return { key, jiraTitle: null, issueType: null, found: false };
    }

    if (RETRYABLE_STATUS.has(res.status) && attempt < attempts - 1) {
      console.warn(`[enrich] ${key}: HTTP ${res.status}, tentando de novo (${attempt + 1}/${attempts})`);
      continue;
    }

    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      console.warn(`[enrich] ${key}: HTTP ${res.status} — ${body}`);
      return { key, jiraTitle: null, issueType: null, found: false };
    }

    const data = (await res.json()) as JiraIssueLite;
    return {
      key,
      jiraTitle: data.fields.summary ?? null,
      issueType: data.fields.issuetype?.name ?? null,
      found: true,
    };
  }

  return { key, jiraTitle: null, issueType: null, found: false };
}

async function main(): Promise<void> {
  const entries = JSON.parse(readFileSync(INDEX_PATH, "utf-8")) as TaskIndexEntry[];
  const uniqueKeys = [...new Set(entries.filter((e) => e.key).map((e) => e.key as string))];

  console.log(`[enrich] ${uniqueKeys.length} keys únicas de ${entries.length} entries (concorrência ${CONCURRENCY})`);

  let done = 0;
  const results = await mapWithConcurrency(uniqueKeys, CONCURRENCY, async (key) => {
    const result = await fetchIssueLite(key);
    done++;
    if (done % 25 === 0 || done === uniqueKeys.length) {
      console.log(`[enrich] ${done}/${uniqueKeys.length}`);
    }
    return result;
  });

  const byKey = new Map(results.map((r) => [r.key, r]));
  let enrichedEntries = 0;
  for (const entry of entries) {
    if (!entry.key) continue;
    const result = byKey.get(entry.key);
    if (!result || !result.found) continue;
    entry.jiraTitle = result.jiraTitle;
    entry.issueType = result.issueType;
    enrichedEntries++;
  }

  writeFileSync(INDEX_PATH, JSON.stringify(entries, null, 2));

  const foundKeys = results.filter((r) => r.found).length;
  const notFoundKeys = results.filter((r) => !r.found).length;
  const pctKeys = uniqueKeys.length ? ((foundKeys / uniqueKeys.length) * 100).toFixed(1) : "0.0";
  const pctEntries = entries.length ? ((enrichedEntries / entries.length) * 100).toFixed(1) : "0.0";

  console.log(`[enrich] keys enriquecidas: ${foundKeys}/${uniqueKeys.length} (${pctKeys}%) — ${notFoundKeys} não encontradas (404/erro)`);
  console.log(`[enrich] entries enriquecidas: ${enrichedEntries}/${entries.length} (${pctEntries}%)`);
  console.log(`[enrich] gravado em ${INDEX_PATH}`);
}

main().catch((err) => {
  console.error("[enrich] falhou:", err);
  process.exit(1);
});
