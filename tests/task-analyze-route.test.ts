import { describe, expect, it } from "bun:test";
import { handler } from "../lambda/handler.ts";
import type { FunctionUrlEvent } from "../lambda/types.ts";

function makeEvent(overrides: Partial<FunctionUrlEvent> = {}): FunctionUrlEvent {
  return {
    rawPath: "/task-analyze",
    rawQueryString: "",
    headers: {},
    requestContext: { http: { method: "POST" } },
    ...overrides,
  };
}

describe("/task-analyze route guard", () => {
  it("rejects when STATS_KEY env var is not configured", async () => {
    const previous = process.env.STATS_KEY;
    delete process.env.STATS_KEY;
    try {
      const result = await handler(makeEvent({ rawQueryString: "key=whatever" }));
      expect(result).toEqual({ statusCode: 401, body: JSON.stringify({ error: "unauthorized" }) });
    } finally {
      if (previous !== undefined) process.env.STATS_KEY = previous;
    }
  });

  it("rejects a mismatched key", async () => {
    const previous = process.env.STATS_KEY;
    process.env.STATS_KEY = "correct-key";
    try {
      const result = await handler(makeEvent({ rawQueryString: "key=wrong-key" }));
      expect(result).toEqual({ statusCode: 401, body: JSON.stringify({ error: "unauthorized" }) });
    } finally {
      if (previous === undefined) delete process.env.STATS_KEY;
      else process.env.STATS_KEY = previous;
    }
  });

  it("rejects non-POST methods once authorized", async () => {
    const previous = process.env.STATS_KEY;
    process.env.STATS_KEY = "correct-key";
    try {
      const result = await handler(
        makeEvent({ rawQueryString: "key=correct-key", requestContext: { http: { method: "GET" } } })
      );
      expect(result).toMatchObject({ statusCode: 405 });
    } finally {
      if (previous === undefined) delete process.env.STATS_KEY;
      else process.env.STATS_KEY = previous;
    }
  });

  it("rejects an empty task text", async () => {
    const previous = process.env.STATS_KEY;
    process.env.STATS_KEY = "correct-key";
    try {
      const result = await handler(
        makeEvent({ rawQueryString: "key=correct-key", body: JSON.stringify({ text: "   " }) })
      );
      expect(result).toMatchObject({ statusCode: 400 });
    } finally {
      if (previous === undefined) delete process.env.STATS_KEY;
      else process.env.STATS_KEY = previous;
    }
  });
});
