import { CODEX_API_URL } from "../config";
import { resolveCodexModel } from "./model-resolve";
import { getValidAccessToken } from "./tokens";

export interface CodexRequestPayload {
  model: string;
  input: Array<{ role: string; content: string }>;
  instructions?: string;
  stream?: boolean;
  store?: boolean;
}

export interface CodexStreamEvent {
  type: string;
  data: unknown;
  raw: string;
}

export type CodexStreamHooks = {
  onHttpResponse?: (response: Response) => void;
  onSseObject?: (obj: Record<string, unknown>) => void;
};

function transformPayload(payload: CodexRequestPayload) {
  let instructions = payload.instructions || "";
  const transformedInput: Array<{
    type: string;
    role: string;
    content: string;
  }> = [];

  for (const item of payload.input) {
    if (item.role === "system") {
      instructions = item.content;
    } else {
      transformedInput.push({
        type: "message",
        role: item.role,
        content: item.content,
      });
    }
  }

  return {
    model: resolveCodexModel(payload.model),
    instructions,
    input: transformedInput,
    stream: payload.stream ?? true,
    store: payload.store ?? false,
  };
}

export async function streamCodexRequest(
  payload: CodexRequestPayload,
  onChunk: (event: CodexStreamEvent) => void,
  onDone: () => void,
  onError: (err: Error) => void,
  hooks?: CodexStreamHooks
): Promise<void> {
  const tokenResult = await getValidAccessToken();
  if (!tokenResult) {
    onError(new Error("Não autenticado. Rode `bun run auth` primeiro."));
    return;
  }

  const body = transformPayload(payload);

  try {
    const response = await fetch(CODEX_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenResult.access_token}`,
        "Chatgpt-Account-Id": tokenResult.account_id,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      onError(
        new Error(`Codex API ${response.status}: ${text.slice(0, 500)}`)
      );
      return;
    }

    hooks?.onHttpResponse?.(response);

    if (!response.body) {
      onError(new Error("Response body vazio"));
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;

        if (trimmed.startsWith("data: ")) {
          const raw = trimmed.slice(6);

          if (raw === "[DONE]") {
            onDone();
            return;
          }

          try {
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            hooks?.onSseObject?.(parsed);
            onChunk({
              type: (parsed.type as string) || "unknown",
              data: parsed,
              raw,
            });
          } catch {
            onChunk({ type: "raw", data: null, raw });
          }
        }
      }
    }

    onDone();
  } catch (err) {
    onError(err instanceof Error ? err : new Error(String(err)));
  }
}

export async function codexRequest(
  payload: Omit<CodexRequestPayload, "stream">
): Promise<string> {
  return new Promise((resolve, reject) => {
    let fullText = "";

    streamCodexRequest(
      { ...payload, stream: true },
      (event) => {
        const data = event.data as Record<string, unknown>;
        if (data?.type === "response.output_text.delta") {
          fullText += (data as { delta?: string }).delta || "";
        } else if (data?.delta) {
          fullText += String((data as { delta?: unknown }).delta);
        }
      },
      () => resolve(fullText),
      reject
    );
  });
}
