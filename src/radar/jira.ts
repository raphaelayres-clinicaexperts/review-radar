const JIRA_BASE = () => process.env.JIRA_BASE_URL?.replace(/\/$/, "") ?? "";
const JIRA_AUTH = () =>
  Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_TOKEN}`).toString("base64");

const headers = () => ({
  Authorization: `Basic ${JIRA_AUTH()}`,
  Accept: "application/json",
  "Content-Type": "application/json",
});

async function jiraGet<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${JIRA_BASE()}${path}`, { headers: headers() });
  if (!res.ok) {
    throw new Error(`Jira ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  assignee: string | null;
  issueType: string;
  priority: string;
  updated: string;
  url: string;
  prRefs: string[];
  labels: string[];
  components: string[];
  epic: { key: string; summary: string } | null;
  parent: { key: string; summary: string; type: string } | null;
  sprint: string | null;
}

interface JiraRawFields {
  summary: string;
  status: { name: string };
  assignee?: { displayName: string } | null;
  issuetype: { name: string };
  priority?: { name: string } | null;
  updated: string;
  description?: unknown;
  comment?: { comments?: Array<{ body?: unknown }> };
  labels?: string[];
  components?: Array<{ name: string }>;
  parent?: {
    key: string;
    fields?: { summary?: string; issuetype?: { name: string } };
  } | null;
  customfield_10014?: string | null;
  customfield_10020?: Array<{ name: string; state: string }> | null;
  [key: string]: unknown;
}

interface JiraSearchResponse {
  issues: Array<{
    id: string;
    key: string;
    fields: JiraRawFields;
  }>;
  total: number;
}

interface DevStatusResponse {
  detail?: Array<{
    pullRequests?: Array<{
      url: string;
      name: string;
      status: string;
      source?: { url?: string };
    }>;
  }>;
}

const PR_URL_RE = /https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/g;

function extractPrRefsFromText(text: string): string[] {
  const matches = [...text.matchAll(PR_URL_RE)];
  return matches.map((m) => `${m[1]}/${m[2]}#${m[3]}`);
}

function flattenAdfToText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as Record<string, unknown>;
  if (n.type === "text" && typeof n.text === "string") return n.text;
  if (Array.isArray(n.content)) return n.content.map(flattenAdfToText).join("");
  return "";
}

async function fetchDevStatusPrs(issueId: string): Promise<string[]> {
  try {
    const data = await jiraGet<DevStatusResponse>(
      `/rest/dev-status/latest/issue/detail?issueId=${issueId}&applicationType=GitHub&dataType=pullrequest`
    );
    const urls: string[] = [];
    for (const detail of data.detail ?? []) {
      for (const pr of detail.pullRequests ?? []) {
        if (pr.url) urls.push(...extractPrRefsFromText(pr.url));
      }
    }
    return urls;
  } catch {
    return [];
  }
}

export async function fetchJiraIssuesWithPrs(
  jql?: string,
  maxResults = 50
): Promise<JiraIssue[]> {
  const project = process.env.JIRA_PROJECT;
  const statuses = process.env.JIRA_PR_STATUSES ?? "Em revisão,Code Review,In Review,Review,Em Homologação";
  const windowDays = Number(process.env.WINDOW_DAYS ?? "90");

  const statusList = statuses.split(",").map((s) => '"' + s.trim() + '"').join(",");
  const tail = `AND updated >= -${windowDays}d ORDER BY updated DESC`;
  const defaultJql = project
    ? `project = "${project}" AND status in (${statusList}) ${tail}`
    : `status in (${statusList}) ${tail}`;

  const query = jql ?? defaultJql;
  const encoded = encodeURIComponent(query);

  const fields = [
    "summary", "status", "assignee", "issuetype", "priority", "updated",
    "description", "comment", "labels", "components", "parent",
    "customfield_10014", "customfield_10020",
  ].join(",");

  const data = await jiraGet<JiraSearchResponse>(
    `/rest/api/3/search/jql?jql=${encoded}&maxResults=${maxResults}&fields=${fields}`
  );

  const issues: JiraIssue[] = [];

  for (const raw of data.issues) {
    const prRefs = new Set<string>();

    const descText = flattenAdfToText(raw.fields.description);
    for (const ref of extractPrRefsFromText(descText)) prRefs.add(ref);

    for (const c of raw.fields.comment?.comments ?? []) {
      const commentText = flattenAdfToText(c.body);
      for (const ref of extractPrRefsFromText(commentText)) prRefs.add(ref);
    }

    const devRefs = await fetchDevStatusPrs(raw.id);
    for (const ref of devRefs) prRefs.add(ref);

    const parentRaw = raw.fields.parent;
    const parentType = parentRaw?.fields?.issuetype?.name ?? "";
    const isEpic = parentType.toLowerCase() === "epic";

    const sprints = raw.fields.customfield_10020 ?? [];
    const activeSprint = sprints.find((s) => s.state === "active");
    const sprintName = activeSprint?.name ?? sprints[0]?.name ?? null;

    issues.push({
      key: raw.key,
      summary: raw.fields.summary,
      status: raw.fields.status.name,
      assignee: raw.fields.assignee?.displayName ?? null,
      issueType: raw.fields.issuetype.name,
      priority: raw.fields.priority?.name ?? "Medium",
      updated: raw.fields.updated,
      url: `${JIRA_BASE()}/browse/${raw.key}`,
      prRefs: [...prRefs],
      labels: raw.fields.labels ?? [],
      components: (raw.fields.components ?? []).map((c) => c.name),
      epic: isEpic && parentRaw
        ? { key: parentRaw.key, summary: parentRaw.fields?.summary ?? "" }
        : null,
      parent: parentRaw
        ? { key: parentRaw.key, summary: parentRaw.fields?.summary ?? "", type: parentType }
        : null,
      sprint: sprintName,
    });
  }

  return issues;
}

export async function searchJiraIssues(jql: string, maxResults = 50): Promise<JiraIssue[]> {
  return fetchJiraIssuesWithPrs(jql, maxResults);
}
