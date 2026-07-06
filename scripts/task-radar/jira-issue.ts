import type { TaskInput } from "./types.ts";

interface JiraParentFields {
  summary?: string;
}

interface JiraParent {
  fields?: JiraParentFields;
}

interface JiraFields {
  summary: string;
  description?: unknown;
  issuetype?: { name: string };
  parent?: JiraParent;
  labels?: string[];
}

interface JiraIssueResponse {
  key: string;
  fields: JiraFields;
}

interface JiraCommentAuthor {
  displayName?: string;
}

interface JiraComment {
  author?: JiraCommentAuthor;
  body?: unknown;
  created?: string;
}

interface JiraCommentsResponse {
  comments?: JiraComment[];
}

const MAX_COMMENTS = 8;
const MAX_ENRICHED_TEXT_LENGTH = 6000;

export function flattenAdfToText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const record = node as Record<string, unknown>;
  if (record.type === "text" && typeof record.text === "string") return record.text;
  if (Array.isArray(record.content)) {
    const parts = record.content.map(flattenAdfToText).filter(Boolean);
    const isBlock = ["paragraph", "heading", "listItem", "bulletList", "orderedList"].includes(
      String(record.type)
    );
    return parts.join(isBlock ? "\n" : "");
  }
  return "";
}

export class JiraNotFoundError extends Error {
  constructor(key: string) {
    super(`Issue ${key} não encontrada no Jira (404)`);
    this.name = "JiraNotFoundError";
  }
}

function jiraAuthHeader(): string {
  const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_TOKEN}`).toString(
    "base64"
  );
  return `Basic ${auth}`;
}

async function fetchJiraComments(base: string, key: string): Promise<JiraComment[]> {
  const url = `${base}/rest/api/3/issue/${key}/comment?orderBy=-created&maxResults=${MAX_COMMENTS}`;
  const res = await fetch(url, {
    headers: { Authorization: jiraAuthHeader(), Accept: "application/json" },
  });
  if (!res.ok) return [];
  const data = (await res.json()) as JiraCommentsResponse;
  return data.comments ?? [];
}

export function composeEnrichedText(data: JiraIssueResponse, comments: JiraComment[]): string {
  const sections: string[] = [`Task: ${data.fields.summary}`];

  const epicSummary = data.fields.parent?.fields?.summary;
  if (epicSummary) sections.push(`Épico: ${epicSummary}`);

  const labels = (data.fields.labels ?? []).filter(Boolean);
  if (labels.length) sections.push(`Labels: ${labels.join(", ")}`);

  const description = flattenAdfToText(data.fields.description).trim();
  if (description) sections.push(`Descrição: ${description}`);

  const commentLines = comments
    .slice(0, MAX_COMMENTS)
    .map((c) => {
      const author = c.author?.displayName ?? "desconhecido";
      const text = flattenAdfToText(c.body).trim();
      return text ? `- ${author}: ${text}` : null;
    })
    .filter((line): line is string => Boolean(line));
  if (commentLines.length) sections.push(`Comentários:\n${commentLines.join("\n")}`);

  const fullText = sections.join("\n\n");
  return fullText.length > MAX_ENRICHED_TEXT_LENGTH
    ? fullText.slice(0, MAX_ENRICHED_TEXT_LENGTH)
    : fullText;
}

export async function fetchJiraTaskInput(key: string): Promise<TaskInput> {
  const base = (process.env.JIRA_BASE_URL ?? "").replace(/\/$/, "");

  const res = await fetch(
    `${base}/rest/api/3/issue/${key}?fields=summary,description,issuetype,parent,labels`,
    { headers: { Authorization: jiraAuthHeader(), Accept: "application/json" } }
  );

  if (res.status === 404) throw new JiraNotFoundError(key);
  if (!res.ok) {
    throw new Error(`Jira ${key} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const data = (await res.json()) as JiraIssueResponse;

  let comments: JiraComment[] = [];
  try {
    comments = await fetchJiraComments(base, key);
  } catch {
    comments = [];
  }

  return {
    key: data.key,
    title: data.fields.summary,
    description: composeEnrichedText(data, comments),
    issueType: data.fields.issuetype?.name ?? null,
  };
}
