import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CODEX_MODEL,
  resolveCodexModel,
} from "../src/services/model-resolve";

describe("resolveCodexModel", () => {
  test("maps ChatGPT-style models to default Codex model", () => {
    expect(resolveCodexModel("gpt-3.5-turbo")).toBe(DEFAULT_CODEX_MODEL);
    expect(resolveCodexModel("gpt-4o")).toBe(DEFAULT_CODEX_MODEL);
    expect(resolveCodexModel("GPT-4O")).toBe(DEFAULT_CODEX_MODEL);
  });

  test("passes through official Codex model ids", () => {
    expect(resolveCodexModel("gpt-5.4-mini")).toBe("gpt-5.4-mini");
    expect(resolveCodexModel("gpt-5.4")).toBe("gpt-5.4");
    expect(resolveCodexModel("gpt-5-codex")).toBe("gpt-5-codex");
  });

  test("uses default when empty or null", () => {
    expect(resolveCodexModel()).toBe(DEFAULT_CODEX_MODEL);
    expect(resolveCodexModel("")).toBe(DEFAULT_CODEX_MODEL);
    expect(resolveCodexModel("   ")).toBe(DEFAULT_CODEX_MODEL);
    expect(resolveCodexModel(null)).toBe(DEFAULT_CODEX_MODEL);
  });

  test("maps provider-prefixed chat aliases", () => {
    expect(resolveCodexModel("openai/gpt-3.5-turbo")).toBe(DEFAULT_CODEX_MODEL);
  });

  test("unknown model falls back to default", () => {
    expect(resolveCodexModel("unknown-xyz")).toBe(DEFAULT_CODEX_MODEL);
  });
});
