import { streamCodexRequest, type CodexRequestPayload } from "./services/codex-client";
import {
  buildUsageResumoPt,
  fetchCodexUsageFromRemote,
  summarizeCodexUsageBody,
} from "./services/codex-usage-api";
import { DEFAULT_CODEX_MODEL, resolveCodexModel } from "./services/model-resolve";
import {
  getUsageSummary,
  loadPersistedSession,
  messagesChars,
  persistSession,
  recordApproxCompletion,
  recordFromHttpResponse,
  recordSseObject,
  resetLastReportedUsage,
} from "./services/usage-store";
import { getValidAccessToken } from "./services/tokens";
import { runReviewPipeline, type ReviewMode } from "./services/review-pipeline";
import { reportText, formatReviewText, commentMarkdown, type FullReportInput } from "./radar/report";
import { formatCostPt } from "./services/review-cost";
import { fetchJiraIssuesWithPrs } from "./radar/jira";

const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

const isColorEnabled = process.stdout.isTTY && process.env.NO_COLOR !== "1";

const color = (text: string, tone: string) =>
  isColorEnabled ? `${tone}${text}${ansi.reset}` : text;

const nowIso = () => new Date().toISOString();

const formatDuration = (ms: number) => {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = ((ms % 60_000) / 1000).toFixed(2);
  return `${minutes}m ${seconds}s`;
};

const statusTone = (status: number) => {
  if (status >= 500) return ansi.red;
  if (status >= 400) return ansi.yellow;
  if (status >= 300) return ansi.magenta;
  return ansi.green;
};

const methodTone = (method: string) => {
  if (method === "GET") return ansi.cyan;
  if (method === "POST") return ansi.blue;
  if (method === "PUT" || method === "PATCH") return ansi.yellow;
  if (method === "DELETE") return ansi.red;
  return ansi.gray;
};

const logInfo = (scope: string, message: string) => {
  const ts = color(nowIso(), ansi.gray);
  const tag = color(`[${scope}]`, ansi.cyan);
  console.log(`${ts} ${tag} ${message}`);
};

const logSuccess = (scope: string, message: string) => {
  const ts = color(nowIso(), ansi.gray);
  const tag = color(`[${scope}]`, ansi.green);
  console.log(`${ts} ${tag} ${message}`);
};

const logWarn = (scope: string, message: string) => {
  const ts = color(nowIso(), ansi.gray);
  const tag = color(`[${scope}]`, ansi.yellow);
  console.log(`${ts} ${tag} ${message}`);
};

const logError = (scope: string, message: string) => {
  const ts = color(nowIso(), ansi.gray);
  const tag = color(`[${scope}]`, ansi.red);
  console.error(`${ts} ${tag} ${message}`);
};

const elapsedMsSince = (startNs: number) =>
  Math.max(0, Math.round((Bun.nanoseconds() - startNs) / 1_000_000));

const responseWithRequestLog = (
  req: Request,
  url: URL,
  startedAtNs: bigint,
  response: Response,
  kind: "info" | "success" | "warn" | "error" = "info",
  suffix = ""
) => {
  const elapsedMs = elapsedMsSince(startedAtNs);
  const message = `${color(req.method, methodTone(req.method))} ${
    url.pathname
  } ${color(String(response.status), statusTone(response.status))} ${color(
    formatDuration(elapsedMs),
    ansi.bold
  )}${suffix}`;
  if (kind === "success") {
    logSuccess("http", message);
    return response;
  }
  if (kind === "warn") {
    logWarn("http", message);
    return response;
  }
  if (kind === "error") {
    logError("http", message);
    return response;
  }
  logInfo("http", message);
  return response;
};

const bootStartedAt = Bun.nanoseconds();
loadPersistedSession();

const PORT = Number.parseInt(process.env.PORT || "3456", 10);

const usageHooks = {
  onHttpResponse: recordFromHttpResponse,
  onSseObject: recordSseObject,
};

const server = Bun.serve({
  port: PORT,
  idleTimeout: 120,
  async fetch(req) {
    const startedAt = Bun.nanoseconds();
    const url = new URL(req.url);

    try {
      if (req.method === "OPTIONS") {
        return responseWithRequestLog(
          req,
          url,
          startedAt,
          new Response(null, {
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type, Authorization",
            },
          }),
          "info"
        );
      }

      if (url.pathname === "/health") {
        const token = await getValidAccessToken();
        return responseWithRequestLog(
          req,
          url,
          startedAt,
          Response.json({
            status: token ? "authenticated" : "not_authenticated",
            timestamp: new Date().toISOString(),
          }),
          "success"
        );
      }

      if (url.pathname === "/usage" && req.method === "GET") {
        const remote = await fetchCodexUsageFromRemote();
        const proxy = getUsageSummary();
        const summary =
          remote.ok && remote.body
            ? summarizeCodexUsageBody(remote.body)
            : null;
        const resumo =
          remote.ok && remote.body ? buildUsageResumoPt(remote.body) : null;
        const minimal = url.searchParams.get("minimal") === "1";
        if (minimal) {
          return responseWithRequestLog(
            req,
            url,
            startedAt,
            Response.json(
              {
                resumo,
                codexFetch: {
                  ok: remote.ok,
                  status: remote.status,
                  error: remote.error,
                },
              },
              { headers: { "Access-Control-Allow-Origin": "*" } }
            ),
            "success"
          );
        }
        return responseWithRequestLog(
          req,
          url,
          startedAt,
          Response.json(
            {
              resumo,
              codexFetch: {
                ok: remote.ok,
                status: remote.status,
                error: remote.error,
              },
              codex: remote.ok ? remote.body : null,
              codexSummary: summary,
              proxy,
            },
            { headers: { "Access-Control-Allow-Origin": "*" } }
          ),
          "success"
        );
      }

      if (url.pathname === "/review" && (req.method === "GET" || req.method === "POST")) {
        try {
          let prRef = url.searchParams.get("pr") ?? "";
          let mode = (url.searchParams.get("mode") ?? "full") as ReviewMode;
          let skipCodex = url.searchParams.get("no-codex") === "1";

          if (req.method === "POST") {
            const body = (await req.json()) as {
              pr?: string;
              mode?: ReviewMode;
              skipCodex?: boolean;
            };
            prRef = body.pr ?? prRef;
            mode = body.mode ?? mode;
            skipCodex = body.skipCodex ?? skipCodex;
          }

          if (!prRef) {
            return responseWithRequestLog(
              req,
              url,
              startedAt,
              Response.json(
                { error: { message: "Informe pr (owner/repo#123)" } },
                { status: 400 }
              ),
              "warn"
            );
          }

          if (!process.env.GITHUB_TOKEN) {
            return responseWithRequestLog(
              req,
              url,
              startedAt,
              Response.json(
                { error: { message: "GITHUB_TOKEN não configurado" } },
                { status: 503 }
              ),
              "error"
            );
          }

          const result = await runReviewPipeline(prRef, mode, { skipCodex });
          const payload = {
            pr: result.pr,
            mode: result.mode,
            radar: result.radar
              ? {
                  route: result.radar.route,
                  rationale: result.radar.rationale,
                  drs: result.radar.drs,
                  ci: result.radar.ci,
                  gate0: result.radar.gate0,
                  codex: result.radar.codex,
                  findings: result.radar.findings,
                }
              : null,
            review: result.review
              ? {
                  summary: result.review.summary,
                  findings: result.review.findings,
                  commentReady: result.review.commentReady,
                  ran: result.review.ran,
                  skipped: result.review.skipped,
                }
              : null,
            cost: result.cost,
            markdown: commentMarkdown({ radar: result.radar, review: result.review, cost: result.cost } as FullReportInput),
            text: [
              result.radar ? reportText(result.radar) : "",
              result.review ? formatReviewText(result.review) : "",
              formatCostPt(result.cost),
            ]
              .filter(Boolean)
              .join("\n\n"),
          };

          return responseWithRequestLog(
            req,
            url,
            startedAt,
            Response.json(payload, {
              headers: { "Access-Control-Allow-Origin": "*" },
            }),
            "success"
          );
        } catch (err) {
          logError("review", `Error: ${String(err)}`);
          return responseWithRequestLog(
            req,
            url,
            startedAt,
            Response.json({ error: { message: String(err) } }, { status: 500 }),
            "error"
          );
        }
      }

      if (url.pathname === "/dashboard") {
        const html = await Bun.file("pr-dashboard.html").text();
        return responseWithRequestLog(
          req,
          url,
          startedAt,
          new Response(html, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          }),
          "success"
        );
      }

      if (url.pathname === "/prs" && req.method === "GET") {
        try {
          const customJql = url.searchParams.get("jql") ?? undefined;
          const issues = await fetchJiraIssuesWithPrs(customJql);
          return responseWithRequestLog(
            req,
            url,
            startedAt,
            Response.json(
              { issues, total: issues.length },
              { headers: { "Access-Control-Allow-Origin": "*" } }
            ),
            "success"
          );
        } catch (err) {
          logError("prs", `Erro Jira: ${String(err)}`);
          return responseWithRequestLog(
            req,
            url,
            startedAt,
            Response.json(
              { error: { message: String(err) } },
              { status: 500, headers: { "Access-Control-Allow-Origin": "*" } }
            ),
            "error"
          );
        }
      }

      if (url.pathname === "/v1/models" && req.method === "GET") {
        return responseWithRequestLog(
          req,
          url,
          startedAt,
          Response.json({
            object: "list",
            data: [
              { id: "gpt-5.4", object: "model", owned_by: "openai" },
              { id: "gpt-5.4-mini", object: "model", owned_by: "openai" },
              { id: "gpt-5.3-codex", object: "model", owned_by: "openai" },
              { id: "gpt-5-codex", object: "model", owned_by: "openai" },
              { id: "gpt-5-codex-mini", object: "model", owned_by: "openai" },
            ],
          }),
          "success"
        );
      }

      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        try {
          const body = (await req.json()) as {
            model?: string;
            messages?: Array<{ role: string; content: string }>;
            stream?: boolean;
          };

          const requestedModel = body.model?.trim() || DEFAULT_CODEX_MODEL;
          const codexModel = resolveCodexModel(body.model);
          const messages = body.messages || [];
          const stream = body.stream ?? false;

          resetLastReportedUsage();

          const payload: CodexRequestPayload = {
            model: codexModel,
            input: messages,
            stream: true,
          };

          if (stream) {
            return responseWithRequestLog(
              req,
              url,
              startedAt,
              new Response(
                new ReadableStream({
                  start(controller) {
                    const encoder = new TextEncoder();
                    let assistantAcc = "";

                    const sendSSE = (data: string) => {
                      controller.enqueue(encoder.encode(`data: ${data}\n\n`));
                    };

                    streamCodexRequest(
                      payload,
                      (event) => {
                        const data = event.data as Record<string, unknown>;
                        let delta = "";

                        if (data?.type === "response.output_text.delta") {
                          delta = String((data as { delta?: string }).delta || "");
                        } else if (data?.delta) {
                          delta = String((data as { delta?: unknown }).delta);
                        }

                        if (delta) assistantAcc += delta;

                        if (delta) {
                          const chunk = {
                            id: "chatcmpl-codex",
                            object: "chat.completion.chunk",
                            created: Math.floor(Date.now() / 1000),
                            model: requestedModel,
                            choices: [
                              {
                                index: 0,
                                delta: { content: delta },
                                finish_reason: null,
                              },
                            ],
                          };
                          sendSSE(JSON.stringify(chunk));
                        }
                      },
                      () => {
                        recordApproxCompletion(
                          messagesChars(messages),
                          assistantAcc.length
                        );
                        persistSession();
                        if (process.env.CODEX_PROXY_LOG_USAGE === "1") {
                          console.log("[usage]", JSON.stringify(getUsageSummary()));
                        }
                        const finalChunk = {
                          id: "chatcmpl-codex",
                          object: "chat.completion.chunk",
                          created: Math.floor(Date.now() / 1000),
                          model: requestedModel,
                          choices: [
                            {
                              index: 0,
                              delta: {},
                              finish_reason: "stop",
                            },
                          ],
                        };
                        sendSSE(JSON.stringify(finalChunk));
                        sendSSE("[DONE]");
                        controller.close();
                      },
                      (err) => {
                        logError("server", `Stream error: ${err.message}`);
                        sendSSE(
                          JSON.stringify({ error: { message: err.message } })
                        );
                        controller.close();
                      },
                      usageHooks
                    );
                  },
                }),
                {
                  headers: {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    Connection: "keep-alive",
                    "Access-Control-Allow-Origin": "*",
                  },
                }
              ),
              "success",
              ` ${color("(stream)", ansi.dim)}`
            );
          }

          const fullText = await new Promise<string>((resolve, reject) => {
            let text = "";
            streamCodexRequest(
              payload,
              (event) => {
                const data = event.data as Record<string, unknown>;
                if (data?.type === "response.output_text.delta") {
                  text += String((data as { delta?: string }).delta || "");
                } else if (data?.delta) {
                  text += String((data as { delta?: unknown }).delta);
                }
              },
              () => resolve(text),
              reject,
              usageHooks
            );
          });

          recordApproxCompletion(messagesChars(messages), fullText.length);
          persistSession();
          if (process.env.CODEX_PROXY_LOG_USAGE === "1") {
            console.log("[usage]", JSON.stringify(getUsageSummary()));
          }

          const lastU = getUsageSummary().lastReportedUsage;
          const p = lastU?.promptTokens;
          const c = lastU?.completionTokens;
          const t = lastU?.totalTokens;
          const approxP = Math.ceil(messagesChars(messages) / 4);
          const approxC = Math.ceil(fullText.length / 4);

          return responseWithRequestLog(
            req,
            url,
            startedAt,
            Response.json({
              id: "chatcmpl-codex",
              object: "chat.completion",
              created: Math.floor(Date.now() / 1000),
              model: requestedModel,
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: fullText },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: p ?? approxP,
                completion_tokens: c ?? approxC,
                total_tokens: t ?? approxP + approxC,
              },
            }),
            "success"
          );
        } catch (err) {
          logError("server", `Error: ${String(err)}`);
          return responseWithRequestLog(
            req,
            url,
            startedAt,
            Response.json(
              { error: { message: String(err) } },
              { status: 500 }
            ),
            "error"
          );
        }
      }

      return responseWithRequestLog(
        req,
        url,
        startedAt,
        Response.json({ error: "Not found" }, { status: 404 }),
        "warn"
      );
    } catch (err) {
      logError("http", `${req.method} ${url.pathname} falhou: ${String(err)}`);
      return responseWithRequestLog(
        req,
        url,
        startedAt,
        Response.json(
          { error: { message: "internal_server_error" } },
          { status: 500 }
        ),
        "error"
      );
    }
  },
});

const bootElapsedMs = elapsedMsSince(bootStartedAt);
const endpointUrl = `http://localhost:${PORT}/v1/chat/completions`;
const healthUrl = `http://localhost:${PORT}/health`;
const usageUrl = `http://localhost:${PORT}/usage?minimal=1`;
logSuccess(
  "boot",
  `${color("Codex Proxy iniciado", ansi.bold)} em ${color(
    formatDuration(bootElapsedMs),
    ansi.bold
  )}`
);
logInfo(
  "boot",
  `Endpoint: ${color(endpointUrl, ansi.cyan)}`
);
logInfo("boot", `Health:   ${color(healthUrl, ansi.cyan)}`);
logInfo("boot", `Usage:    ${color(usageUrl, ansi.cyan)}`);
logInfo("boot", `Server:   ${color(server.url.href, ansi.cyan)}`);
