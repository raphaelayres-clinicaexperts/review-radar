import { installationToken } from "../../lambda/github-app-auth.ts";
import type { CodeSnippet } from "./types.ts";

const OWNER = "clinicaexperts";
const REPO = "clinicaexperts_app";
const MAX_LINES = 300;

interface ContentsResponse {
  content: string;
  encoding: string;
}

export async function fetchFileAtMain(path: string): Promise<CodeSnippet | null> {
  const token = await installationToken(OWNER, REPO);
  const res = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURI(path)}?ref=main`,
    {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    }
  );

  if (res.status === 404) return null;
  if (!res.ok) {
    console.warn(`[github-content] ${path} → HTTP ${res.status}`);
    return null;
  }

  const data = (await res.json()) as ContentsResponse;
  if (data.encoding !== "base64") return null;

  const fullText = Buffer.from(data.content, "base64").toString("utf-8");
  const lines = fullText.split("\n");
  const truncated = lines.length > MAX_LINES;
  const content = lines.slice(0, MAX_LINES).join("\n");

  return { path, content, truncated };
}

export async function fetchFilesAtMain(paths: string[]): Promise<CodeSnippet[]> {
  const results: CodeSnippet[] = [];
  for (const path of paths) {
    try {
      const snippet = await fetchFileAtMain(path);
      if (snippet) results.push(snippet);
    } catch (err) {
      console.warn(`[github-content] falha ao buscar ${path}: ${String(err).slice(0, 150)}`);
    }
  }
  return results;
}
