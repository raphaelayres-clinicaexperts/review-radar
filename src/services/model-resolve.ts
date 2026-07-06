const DEFAULT_CODEX_MODEL = "gpt-5.4-mini";

const CODEX_MODELS_LOWER = new Set([
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.2-codex",
  "gpt-5.2",
  "gpt-5.1-codex-max",
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5-codex",
  "gpt-5-codex-mini",
  "gpt-5",
]);

const CHAT_ALIAS_LOWER: Record<string, string> = {
  "gpt-4o": DEFAULT_CODEX_MODEL,
  "gpt-4o-2024-08-06": DEFAULT_CODEX_MODEL,
  "gpt-4o-2024-05-13": DEFAULT_CODEX_MODEL,
  "gpt-4o-mini": DEFAULT_CODEX_MODEL,
  "gpt-4-turbo": DEFAULT_CODEX_MODEL,
  "gpt-4": DEFAULT_CODEX_MODEL,
  "gpt-3.5-turbo": DEFAULT_CODEX_MODEL,
  "gpt-3.5-turbo-0125": DEFAULT_CODEX_MODEL,
  "gpt-3.5-turbo-1106": DEFAULT_CODEX_MODEL,
  "o3-mini": DEFAULT_CODEX_MODEL,
  "codex-mini": DEFAULT_CODEX_MODEL,
};

export function resolveCodexModel(requested?: string | null): string {
  if (requested == null || String(requested).trim() === "") {
    return DEFAULT_CODEX_MODEL;
  }
  const raw = String(requested).trim();
  const lower = raw.toLowerCase();
  if (CODEX_MODELS_LOWER.has(lower)) {
    return lower;
  }
  const fromChat = CHAT_ALIAS_LOWER[lower];
  if (fromChat) {
    return fromChat;
  }
  const slash = lower.lastIndexOf("/");
  const tail = slash >= 0 ? lower.slice(slash + 1) : lower;
  if (CHAT_ALIAS_LOWER[tail]) {
    return CHAT_ALIAS_LOWER[tail];
  }
  if (CODEX_MODELS_LOWER.has(tail)) {
    return tail;
  }
  return DEFAULT_CODEX_MODEL;
}

export { DEFAULT_CODEX_MODEL };
