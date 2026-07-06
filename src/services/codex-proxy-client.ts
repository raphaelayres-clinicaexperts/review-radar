export interface ProxyCompletionUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ProxyCompletionResult<T = unknown> {
  data: T;
  usage: ProxyCompletionUsage;
  model: string;
}

const defaultBaseUrl = () => process.env.CODEX_PROXY_URL || "http://localhost:3456/v1";
const defaultModel = () => process.env.CODEX_REVIEW_MODEL || "gpt-5.4-mini";

export async function proxyChatCompletion<T = unknown>(opts: {
  system: string;
  user: string;
  model?: string;
  baseUrl?: string;
}): Promise<ProxyCompletionResult<T>> {
  const baseUrl = opts.baseUrl ?? defaultBaseUrl();
  const model = opts.model ?? defaultModel();
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Codex proxy ${res.status}: ${text.slice(0, 500)}`);
  }
  const body = (await res.json()) as {
    model?: string;
    choices?: Array<{ message?: { content?: string } }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  };
  const content = body.choices?.[0]?.message?.content ?? "";
  const usage = body.usage ?? {};
  const promptTokens = usage.prompt_tokens ?? Math.ceil((opts.system.length + opts.user.length) / 4);
  const completionTokens = usage.completion_tokens ?? Math.ceil(content.length / 4);
  const parsed = extractJson<T>(content);
  return {
    data: parsed,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: usage.total_tokens ?? promptTokens + completionTokens,
    },
    model: body.model ?? model,
  };
}

function extractJson<T>(text: string): T {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Resposta do proxy não contém JSON válido");
    return JSON.parse(match[0]) as T;
  }
}
