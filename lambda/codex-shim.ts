import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { directChatCompletion } from "./codex-client.ts";
import type { Store } from "./store.ts";

interface ShimChatRequest {
  model?: string;
  messages?: Array<{ role: string; content: string }>;
}

export interface CodexShim {
  baseUrl: string;
  close(): void;
}

function extractSystemAndUser(messages: Array<{ role: string; content: string }>): {
  system: string;
  user: string;
} {
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  const user = messages
    .filter((m) => m.role !== "system")
    .map((m) => m.content)
    .join("\n\n");
  return { system, user };
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function startCodexShim(store: Store): Promise<CodexShim> {
  const server = createServer((req, res) => {
    const sendJson = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (req.url !== "/v1/chat/completions" || req.method !== "POST") {
      sendJson(404, { error: { message: "not_found" } });
      return;
    }
    readBody(req)
      .then(async (raw) => {
        const body = JSON.parse(raw) as ShimChatRequest;
        const { system, user } = extractSystemAndUser(body.messages ?? []);
        const result = await directChatCompletion(store, { system, user, model: body.model });
        sendJson(200, {
          model: result.model,
          choices: [{ message: { role: "assistant", content: result.content } }],
          usage: {
            prompt_tokens: result.promptTokens,
            completion_tokens: result.completionTokens,
            total_tokens: result.promptTokens + result.completionTokens,
          },
        });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        sendJson(502, { error: { message } });
      });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => server.close(),
  };
}
