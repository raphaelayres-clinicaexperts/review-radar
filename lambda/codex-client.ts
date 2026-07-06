import { CODEX_API_URL } from "../src/config.ts";
import { resolveCodexModel } from "../src/services/model-resolve.ts";
import { extractAccountId, refreshAccessToken } from "../src/services/tokens.ts";
import type { Store } from "./store.ts";

export interface DirectChatCompletionRequest {
  system: string;
  user: string;
  model?: string;
}

export interface DirectChatCompletionResult {
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

async function getValidAccessToken(store: Store): Promise<{ access_token: string; account_id: string } | null> {
  const tokens = await store.getTokens();
  if (!tokens) return null;

  const isExpired = Date.now() >= tokens.expires_at - 60_000;
  if (!isExpired) {
    return { access_token: tokens.access_token, account_id: tokens.account_id };
  }
  if (!tokens.refresh_token) return null;

  const refreshed = await refreshAccessToken(tokens.refresh_token);
  const updated = {
    ...tokens,
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token ?? tokens.refresh_token,
    expires_at: refreshed.expires_in
      ? Date.now() + refreshed.expires_in * 1000
      : tokens.expires_at + 3600_000,
  };
  if (refreshed.id_token) {
    updated.id_token = refreshed.id_token;
    updated.account_id = extractAccountId(refreshed.id_token);
  }
  await store.saveTokens(updated);
  return { access_token: updated.access_token, account_id: updated.account_id };
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function describeFetchError(err: unknown): Error {
  if (!(err instanceof Error)) return new Error(String(err));
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  if (!cause) return err;
  const detail = cause.code || cause.message || String(cause);
  return new Error(`${err.message} (${detail})`);
}

async function fetchWithRetry(url: string, init: RequestInit, attempts = 4): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(1500 * attempt);
    try {
      const response = await fetch(url, init);
      if (!RETRYABLE_STATUS.has(response.status) || attempt === attempts - 1) return response;
      lastError = new Error(`Codex API ${response.status}`);
      console.warn(`[codex] tentativa ${attempt + 1}/${attempts} falhou: HTTP ${response.status}`);
    } catch (err) {
      lastError = describeFetchError(err);
      console.warn(`[codex] tentativa ${attempt + 1}/${attempts} falhou: ${lastError.message}`);
      if (attempt === attempts - 1) throw lastError;
    }
  }
  throw lastError ?? new Error("Codex: retry esgotado");
}

async function readSseText(response: Response): Promise<string> {
  if (!response.body) throw new Error("Codex: response body vazio");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      const raw = trimmed.slice(6);
      if (raw === "[DONE]") return text;
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed.type === "response.output_text.delta") {
          text += String((parsed as { delta?: string }).delta || "");
        } else if (typeof parsed.delta === "string") {
          text += parsed.delta;
        }
      } catch {
        continue;
      }
    }
  }
  return text;
}

export async function directChatCompletion(
  store: Store,
  req: DirectChatCompletionRequest
): Promise<DirectChatCompletionResult> {
  const auth = await getValidAccessToken(store);
  if (!auth) throw new Error("Não autenticado no Codex — tokens ausentes ou refresh falhou");

  const model = resolveCodexModel(req.model);
  const body = {
    model,
    instructions: req.system,
    input: [{ type: "message", role: "user", content: req.user }],
    stream: true,
    store: false,
  };

  const response = await fetchWithRetry(CODEX_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${auth.access_token}`,
      "Chatgpt-Account-Id": auth.account_id,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Codex API ${response.status}: ${text.slice(0, 500)}`);
  }

  const content = await readSseText(response);
  const promptTokens = Math.ceil((req.system.length + req.user.length) / 4);
  const completionTokens = Math.ceil(content.length / 4);
  return { content, model, promptTokens, completionTokens };
}
