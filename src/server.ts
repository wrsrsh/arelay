import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { BackendConfig, Config, JsonObject } from "./types.js";
import { HttpError } from "./types.js";
import {
  anthropicToResponses,
  responsesToAnthropic,
  anthropicToResponsesResponse,
  responsesToAnthropicResponse,
  parseSSE,
  encodeSSE,
  translateAnthropicStream,
  translateResponsesStream,
} from "./protocol/index.js";

import { routeCodexResponse, routeCodexStream } from "./protocol/subagents.js";
import { VERSION } from "./version.js";
import { runNativeTask } from "./native/worker.js";
import type { NativeTask } from "./native/types.js";
import { nativeAuthorized } from "./native/access.js";

const HOP = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "accept-encoding",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "upgrade",
]);

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let exceeded = false;
    req.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > limit) {
        if (!exceeded) {
          exceeded = true;
          chunks.length = 0;
          reject(new HttpError(413, "Request body exceeds maxBodyBytes"));
        }
      } else if (!exceeded) chunks.push(chunk);
    });
    req.on("end", () => {
      if (!exceeded) resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
    req.on("aborted", () => reject(new HttpError(400, "Request aborted")));
  });
}

async function send(
  res: ServerResponse,
  chunk: string | Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw signal.reason;
  if (!res.write(chunk)) await once(res, "drain", { signal });
}

function credentials(backend: BackendConfig): Record<string, string> {
  const key = process.env[backend.apiKeyEnv];
  if (!key)
    throw new HttpError(
      503,
      `Missing ${backend.apiKeyEnv}; add it to arelay credentials.env and restart the service`,
    );
  return {
    [backend.authHeader]:
      backend.authHeader === "authorization" ? `Bearer ${key}` : key,
  };
}

function endpoint(backend: BackendConfig, path: string): string {
  return (
    backend.baseUrl.replace(/\/+$/, "") + path.replace(/^\/v1(?=\/|$)/, "")
  );
}

export function createRelay(
  config: Config,
  onError?: (error: unknown) => void,
  nativeRunner: typeof runNativeTask = runNativeTask,
  nativeToken?: string,
): http.Server {
  const stats = {
    startedAt: new Date().toISOString(),
    claudeToOpenAI: 0,
    codexToClaude: 0,
    anthropicPassthrough: 0,
    openaiPassthrough: 0,
    nativeCodex: 0,
    nativeClaude: 0,
    errors: 0,
    active: 0,
  };
  let nativeActive = 0;
  const controllers = new Set<AbortController>();
  const server = http.createServer((req, res) => {
    let counted = false;
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(
      () => controller.abort(new Error("Request timeout")),
      req.url === "/native/delegate"
        ? (config.native?.timeoutMs ?? 600000) + 10000
        : config.requestTimeoutMs,
    );
    timeout.unref();
    res.on("close", () => controller.abort());
    const countWork = () => {
      counted = true;
      stats.active++;
    };
    const run = async () => {
      const port = req.socket.localPort;
      if (
        !req.headers.host ||
        ![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(
          req.headers.host.toLowerCase(),
        )
      )
        throw new HttpError(403, "Only localhost requests are accepted");
      if (req.headers.origin || req.headers["sec-fetch-site"])
        throw new HttpError(403, "Browser-origin requests are not accepted");
      if (req.method === "HEAD" && req.url === "/api/hello") {
        res.writeHead(200);
        res.end();
        return;
      }
      if (req.method === "GET" && req.url === "/health")
        return json(res, 200, { ok: true, version: VERSION });
      if (req.method === "GET" && req.url === "/stats")
        return json(res, 200, stats);
      if (req.method !== "POST")
        throw new HttpError(405, "Use POST for model requests");
      const url = new URL(req.url || "/", "http://localhost");
      if (url.pathname === "/native/delegate") {
        if (!nativeAuthorized(req.headers.authorization, nativeToken))
          throw new HttpError(
            401,
            "Native worker access requires the local service key",
          );
        if (!config.native?.enabled)
          throw new HttpError(
            503,
            "Native delegation is not connected. Run arelay setup.",
          );
        if (nativeActive >= config.native.maxConcurrent)
          throw new HttpError(
            429,
            "All native workers are busy; retry shortly",
          );
        if (!req.headers["content-type"]?.startsWith("application/json"))
          throw new HttpError(415, "Use application/json");
        let task: NativeTask;
        try {
          task = JSON.parse((await readBody(req, 256 * 1024)).toString("utf8"));
        } catch {
          throw new HttpError(400, "Invalid native task JSON");
        }
        if (
          !task ||
          !["claude", "codex"].includes(task.target) ||
          typeof task.task !== "string" ||
          typeof task.cwd !== "string" ||
          (task.model !== undefined && typeof task.model !== "string")
        )
          throw new HttpError(400, "Supply target, task, and an absolute cwd");
        if (nativeActive >= config.native.maxConcurrent)
          throw new HttpError(
            429,
            "All native workers are busy; retry shortly",
          );
        countWork();
        nativeActive++;
        stats[task.target === "codex" ? "nativeCodex" : "nativeClaude"]++;
        try {
          return json(
            res,
            200,
            await nativeRunner(task, config.native, controller.signal),
          );
        } catch (error) {
          throw new HttpError(
            controller.signal.aborted ? 504 : 502,
            error instanceof Error ? error.message : "Native worker failed",
          );
        } finally {
          nativeActive--;
        }
      }
      if (
        ![
          "/v1/messages",
          "/v1/messages/count_tokens",
          "/v1/responses",
          "/v1/responses/compact",
        ].includes(url.pathname)
      )
        throw new HttpError(404, "Unsupported API endpoint");
      if (
        req.headers["content-encoding"] &&
        req.headers["content-encoding"] !== "identity"
      )
        throw new HttpError(
          415,
          "Compressed requests are unsupported; disable request compression for this provider",
        );
      if (
        !req.headers["content-type"]
          ?.toLowerCase()
          .startsWith("application/json")
      )
        throw new HttpError(415, "Content-Type must be application/json");
      const raw = await readBody(req, config.maxBodyBytes);
      let body: JsonObject;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        throw new HttpError(400, "Invalid JSON body");
      }
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        typeof body.model !== "string"
      )
        throw new HttpError(
          400,
          "Request must be an object with a model string",
        );
      countWork();
      const anthropic = url.pathname.startsWith("/v1/messages");
      const translate = anthropic
        ? body.model === config.routes.claudeSubagentModel
        : body.model === config.routes.codexSubagentModel;
      if (
        body.model ===
        (anthropic
          ? config.routes.codexSubagentModel
          : config.routes.claudeSubagentModel)
      )
        throw new HttpError(
          400,
          "Model alias belongs to the other API; check client configuration",
        );
      if (!translate) {
        stats[anthropic ? "anthropicPassthrough" : "openaiPassthrough"]++;
        const backend = anthropic ? config.anthropic : config.openai;
        const headers = new Headers();
        const connectionTokens = (req.headers.connection || "")
          .toLowerCase()
          .split(",")
          .map((v) => v.trim());
        for (const [name, value] of Object.entries(req.headers)) {
          if (
            !HOP.has(name) &&
            !connectionTokens.includes(name) &&
            value !== undefined
          )
            headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
        // Generated Codex providers authenticate to this local relay without a key.
        // Use arelay's saved backend key only when no client auth was supplied.
        if (
          !anthropic &&
          !["authorization", "api-key", "x-api-key"].some((name) =>
            headers.has(name),
          )
        ) {
          for (const [name, value] of Object.entries(credentials(backend)))
            headers.set(name, value);
        }
        const upstream = await fetch(
          endpoint(backend, url.pathname + url.search),
          {
            method: "POST",
            headers,
            body: new Uint8Array(raw),
            signal: controller.signal,
            redirect: "error",
          },
        );
        const responseHeaders: Record<string, string> = {};
        upstream.headers.forEach((value, key) => {
          if (!HOP.has(key) && key !== "content-encoding")
            responseHeaders[key] = value;
        });
        res.writeHead(upstream.status, responseHeaders);
        if (!anthropic && upstream.ok && url.pathname === "/v1/responses") {
          if (
            upstream.body &&
            upstream.headers.get("content-type")?.includes("text/event-stream")
          ) {
            for await (const ev of routeCodexStream(
              parseSSE(upstream.body),
              config.routes.codexSubagentModel,
            ))
              await send(res, encodeSSE(ev), controller.signal);
          } else {
            res.write(
              JSON.stringify(
                routeCodexResponse(
                  (await upstream.json()) as JsonObject,
                  config.routes.codexSubagentModel,
                ),
              ),
            );
          }
        } else if (upstream.body)
          for await (const chunk of upstream.body)
            await send(res, chunk, controller.signal);
        res.end();
        return;
      }
      if (url.pathname.endsWith("/compact"))
        throw new HttpError(
          400,
          "Cross-provider compaction is unsupported. Start a fresh subagent with uncompressed history; main-model compaction still passes through.",
        );
      if (url.pathname.endsWith("/count_tokens")) {
        const estimate = Math.ceil(
          Buffer.byteLength(
            JSON.stringify([body.system, body.messages, body.tools]),
            "utf8",
          ) / 3,
        );
        res.setHeader("x-arelay-token-count", "estimate");
        return json(res, 200, { input_tokens: estimate });
      }
      stats[anthropic ? "claudeToOpenAI" : "codexToClaude"]++;
      const backend = anthropic ? config.openai : config.anthropic;
      let converted: JsonObject;
      let customTools = new Set<string>();
      if (anthropic) converted = anthropicToResponses(body, backend.model);
      else
        ({ request: converted, customTools } = responsesToAnthropic(
          body,
          backend.model,
        ));
      const stream = body.stream === true;
      converted.stream = stream;
      const headers = {
        "content-type": "application/json",
        ...credentials(backend),
        ...(anthropic ? {} : { "anthropic-version": "2023-06-01" }),
      };
      const upstream = await fetch(
        endpoint(backend, anthropic ? "/v1/responses" : "/v1/messages"),
        {
          method: "POST",
          headers,
          body: JSON.stringify(converted),
          signal: controller.signal,
          redirect: "error",
        },
      );
      if (!upstream.ok) {
        await upstream.body?.cancel();
        const retryAfter = upstream.headers.get("retry-after");
        if (retryAfter) res.setHeader("retry-after", retryAfter);
        throw new HttpError(
          upstream.status,
          `${anthropic ? "OpenAI" : "Anthropic"} backend returned HTTP ${upstream.status}; check credentials, model access, quota, and backend configuration`,
        );
      }
      if (!stream) {
        const data = (await upstream.json()) as JsonObject;
        const result = anthropic
          ? responsesToAnthropicResponse(data, body.model)
          : routeCodexResponse(
              anthropicToResponsesResponse(data, body.model, customTools),
              config.routes.codexSubagentModel,
            );
        return json(res, 200, result);
      }
      if (
        !upstream.body ||
        !upstream.headers.get("content-type")?.includes("text/event-stream")
      )
        throw new HttpError(502, "Backend did not return an SSE stream");
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-accel-buffering": "no",
      });
      const heartbeat = setInterval(() => {
        if (!res.destroyed && !res.writableNeedDrain)
          res.write(": keep-alive\n\n");
      }, 15_000);
      heartbeat.unref();
      try {
        const source = parseSSE(upstream.body);
        const events = anthropic
          ? translateResponsesStream(source, body.model)
          : routeCodexStream(
              translateAnthropicStream(source, body.model, customTools),
              config.routes.codexSubagentModel,
            );
        for await (const ev of events)
          await send(res, encodeSSE(ev), controller.signal);
      } finally {
        clearInterval(heartbeat);
      }
      res.end();
    };
    void run()
      .catch((error: unknown) => {
        stats.errors++;
        onError?.(error);
        if (res.destroyed || res.writableEnded) return;
        const status =
          error instanceof HttpError
            ? error.status
            : controller.signal.aborted
              ? 504
              : 502;
        const message =
          error instanceof HttpError
            ? error.message
            : controller.signal.aborted
              ? "Request timed out or was cancelled"
              : "Backend request failed; check connectivity and configuration";
        if (res.headersSent) {
          const isResponses = req.url?.startsWith("/v1/responses");
          res.end(
            encodeSSE({
              event: "error",
              data: isResponses
                ? {
                    type: "error",
                    code: "arelay_error",
                    message,
                    param: null,
                    sequence_number: 2147483647,
                  }
                : { type: "error", error: { type: "api_error", message } },
            }),
          );
        } else
          json(res, status, {
            type: "error",
            error: {
              type: status === 400 ? "invalid_request_error" : "api_error",
              message,
            },
          });
      })
      .finally(() => {
        clearTimeout(timeout);
        if (counted) stats.active--;
        controllers.delete(controller);
      });
  });
  server.on("arelay:shutdown", () => {
    for (const controller of controllers)
      controller.abort(new Error("Service is stopping"));
  });
  server.requestTimeout = config.requestTimeoutMs;
  server.headersTimeout = Math.min(config.requestTimeoutMs, 60_000);
  server.on("upgrade", (_req, socket) => {
    socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n");
  });
  return server;
}
