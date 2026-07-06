const JQL = "project = CE ORDER BY created DESC";
const MAX_RESULTS = 10;
const DEFAULT_FUNCTION_URL = "https://u2u67lir55.execute-api.us-east-1.amazonaws.com";

const FUNCTION_URL = (process.env.RADAR_FUNCTION_URL ?? DEFAULT_FUNCTION_URL).replace(/\/$/, "");
const STATS_KEY = process.env.STATS_KEY;

interface JiraIssueFields {
  summary: string;
  issuetype?: { name: string };
}

interface JiraIssue {
  key: string;
  fields: JiraIssueFields;
}

interface JiraSearchResponse {
  issues?: JiraIssue[];
}

function jiraAuthHeader(): string {
  const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_TOKEN}`).toString("base64");
  return `Basic ${auth}`;
}

async function searchJiraIssuesLegacy(base: string, jql: string, maxResults: number): Promise<JiraIssue[]> {
  const url = `${base}/rest/api/3/search?jql=${encodeURIComponent(jql)}&fields=summary,issuetype&maxResults=${maxResults}`;
  const res = await fetch(url, { headers: { Authorization: jiraAuthHeader(), Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`Jira search (legacy) → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as JiraSearchResponse;
  return data.issues ?? [];
}

async function searchLatestJiraIssues(jql: string, maxResults: number): Promise<JiraIssue[]> {
  const base = (process.env.JIRA_BASE_URL ?? "").replace(/\/$/, "");
  if (!base) throw new Error("JIRA_BASE_URL não configurado");

  const url = `${base}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=summary,issuetype&maxResults=${maxResults}`;
  const res = await fetch(url, { headers: { Authorization: jiraAuthHeader(), Accept: "application/json" } });
  if (res.status === 404 || res.status === 410) {
    console.log("[analyze-latest-tasks] /rest/api/3/search/jql indisponível, caindo para /rest/api/3/search");
    return searchJiraIssuesLegacy(base, jql, maxResults);
  }
  if (!res.ok) {
    throw new Error(`Jira search/jql → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as JiraSearchResponse;
  return data.issues ?? [];
}

interface TaskAnalyzeModule {
  path: string;
  confidence: number;
  why: string;
}

interface TaskAnalyzeResponse {
  modules: TaskAnalyzeModule[];
  technicalSummary: string[];
  similars: unknown[];
  medianLines: number | null;
  effortBucket: string;
}

async function analyzeInProduction(
  key: string,
  title: string,
  issueType: string | null
): Promise<TaskAnalyzeResponse> {
  const url = `${FUNCTION_URL}/task-analyze?key=${encodeURIComponent(STATS_KEY ?? "")}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, title, issueType }),
  });
  if (!res.ok) {
    throw new Error(`task-analyze ${key} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()) as TaskAnalyzeResponse;
}

async function main(): Promise<void> {
  if (!STATS_KEY) throw new Error("STATS_KEY não configurado (.env)");

  console.log(`[analyze-latest-tasks] buscando as ${MAX_RESULTS} issues mais recentes (${JQL})...`);
  const issues = await searchLatestJiraIssues(JQL, MAX_RESULTS);
  console.log(`[analyze-latest-tasks] ${issues.length} issues encontradas`);

  for (const issue of issues) {
    const issueType = issue.fields.issuetype?.name ?? null;

    console.log(`[analyze-latest-tasks] analisando ${issue.key} — "${issue.fields.summary}"...`);
    try {
      const result = await analyzeInProduction(issue.key, issue.fields.summary, issueType);
      const topModule = result.modules[0];
      const topModuleLabel = topModule ? `${topModule.path} (confidence=${topModule.confidence.toFixed(2)})` : "(nenhum módulo acima do corte)";
      console.log(`  ok — top módulo: ${topModuleLabel}`);
      if (result.technicalSummary?.length) {
        for (const bullet of result.technicalSummary) console.log(`    - ${bullet}`);
      }
    } catch (err) {
      console.error(`  falhou: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

main().catch((err) => {
  console.error("[analyze-latest-tasks] falhou:", err);
  process.exit(1);
});
