import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRelay } from "../src/server.js";
import { defaultConfig } from "../src/config.js";
import type { Config, JsonObject } from "../src/types.js";
const listen = (server: http.Server) =>
  new Promise<number>((r) =>
    server.listen(0, "127.0.0.1", () =>
      r((server.address() as { port: number }).port),
    ),
  );
async function close(server: http.Server) {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
}
async function fixture(
  t: { after: (fn: () => Promise<void>) => void },
  overrides: Partial<Config> = {},
) {
  const requests: {
    path: string;
    headers: http.IncomingHttpHeaders;
    body: JsonObject;
  }[] = [];
  let mode = "success";
  const upstream = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ path: req.url!, headers: req.headers, body });
    if (mode === "timeout") return;
    if (mode === "error") {
      res.writeHead(429, { "retry-after": "2" });
      res.end("DO_NOT_LEAK_SECRET");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url?.startsWith("/v1/messages"))
      res.end(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: body.model,
          content: [{ type: "text", text: "anthropic" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 2 },
        }),
      );
    else
      res.end(
        JSON.stringify({
          id: "resp_test",
          object: "response",
          model: body.model,
          status: "completed",
          output: [
            {
              id: "msg",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [
                { type: "output_text", text: "openai", annotations: [] },
              ],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 2 },
        }),
      );
  });
  const upstreamPort = await listen(upstream);
  const config = { ...structuredClone(defaultConfig), ...overrides };
  for (const name of ["openai", "anthropic"] as const) {
    config[name].baseUrl = `http://127.0.0.1:${upstreamPort}/v1`;
    config[name].apiKeyEnv = "ARELAY_TEST_KEY";
  }
  process.env.ARELAY_TEST_KEY = "backend-secret";
  const relay = createRelay(config);
  const port = await listen(relay);
  t.after(async () => {
    await close(relay);
    await close(upstream);
    delete process.env.ARELAY_TEST_KEY;
  });
  const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  return {
    config,
    port,
    post,
    requests,
    setMode: (v: string) => {
      mode = v;
    },
  };
}
test("Claude→OpenAI and Codex→Claude translate only alias requests and isolate credentials", async (t) => {
  const f = await fixture(t);
  let response = await f.post(
    "/v1/messages?beta=true",
    {
      model: f.config.routes.claudeSubagentModel,
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    },
    { "x-api-key": "claude-client-key", "anthropic-beta": "private-feature" },
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).content[0].text, "openai");
  assert.equal(f.requests[0]!.headers.authorization, "Bearer backend-secret");
  assert.equal(f.requests[0]!.headers["x-api-key"], undefined);
  assert.equal(f.requests[0]!.headers["anthropic-beta"], undefined);
  assert.equal(f.requests[0]!.body.model, f.config.openai.model);
  response = await f.post(
    "/v1/responses",
    { model: f.config.routes.codexSubagentModel, input: "hi", stream: false },
    { authorization: "Bearer codex-client-key" },
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).output[0].content[0].text, "anthropic");
  assert.equal(f.requests[1]!.headers["x-api-key"], "backend-secret");
  assert.equal(f.requests[1]!.headers.authorization, undefined);
});
test("Main-model requests preserve model, payload, query and client auth", async (t) => {
  const f = await fixture(t);
  const body = {
    model: "claude-main",
    messages: [{ role: "user", content: "hi" }],
    vendor_field: { untouched: true },
  };
  const response = await f.post("/v1/messages?beta=true", body, {
    "x-api-key": "client-key",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(f.requests[0]!.body, body);
  assert.equal(f.requests[0]!.path, "/v1/messages?beta=true");
  assert.equal(f.requests[0]!.headers["x-api-key"], "client-key");
});
test("Generated Codex providers use the relay key without a client-side environment variable", async (t) => {
  const f = await fixture(t);
  const response = await f.post("/v1/responses", {
    model: "gpt-main",
    input: "hi",
    stream: false,
  });
  assert.equal(response.status, 200);
  assert.equal(f.requests[0]!.headers.authorization, "Bearer backend-secret");
  assert.equal(f.requests[0]!.body.model, "gpt-main");
});

test("Local health, Claude connectivity probe and stats work without model credentials", async (t) => {
  const f = await fixture(t);
  delete process.env.ARELAY_TEST_KEY;
  assert.equal((await fetch(`http://127.0.0.1:${f.port}/health`)).status, 200);
  assert.equal(
    (await fetch(`http://127.0.0.1:${f.port}/api/hello`, { method: "HEAD" }))
      .status,
    200,
  );
  assert.equal((await fetch(`http://127.0.0.1:${f.port}/stats`)).status, 200);
  const response = await f.post("/v1/responses", {
    model: f.config.routes.codexSubagentModel,
    input: "hi",
  });
  assert.equal(response.status, 503);
  assert.match(await response.text(), /ARELAY_TEST_KEY/);
});
test("Reject browser origins, bad hosts, invalid JSON, unsupported endpoints and alias mixups", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.post("/v1/messages", {}, { origin: "https://evil.example" }))
      .status,
    403,
  );
  const badHostStatus = await new Promise<number | undefined>(
    (resolve, reject) => {
      const request = http.request(
        {
          hostname: "127.0.0.1",
          port: f.port,
          method: "POST",
          path: "/v1/messages",
          headers: { host: "evil.example", "content-type": "application/json" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      request.on("error", reject);
      request.end("{}");
    },
  );
  assert.equal(badHostStatus, 403);
  assert.equal((await f.post("/not-an-api", {})).status, 404);
  assert.equal(
    (
      await f.post("/v1/messages", {
        model: f.config.routes.codexSubagentModel,
      })
    ).status,
    400,
  );
  const bad = await fetch(`http://127.0.0.1:${f.port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  assert.equal(bad.status, 400);
  assert.equal(f.requests.length, 0);
});
test("Body limits return 413 and cross-provider compaction is rejected explicitly", async (t) => {
  const f = await fixture(t, { maxBodyBytes: 512 });
  assert.equal(
    (await f.post("/v1/messages", { data: "x".repeat(1024) })).status,
    413,
  );
  const response = await f.post("/v1/responses/compact", {
    model: f.config.routes.codexSubagentModel,
    input: [],
  });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /compaction/);
});
test("Cross-provider token count is explicitly marked as an estimate", async (t) => {
  const f = await fixture(t);
  const response = await f.post("/v1/messages/count_tokens", {
    model: f.config.routes.claudeSubagentModel,
    messages: [],
  });
  assert.equal(response.headers.get("x-arelay-token-count"), "estimate");
  assert.ok((await response.json()).input_tokens > 0);
});
test("Upstream error status and retry hints survive without leaking response contents", async (t) => {
  const f = await fixture(t);
  f.setMode("error");
  const response = await f.post("/v1/responses", {
    model: f.config.routes.codexSubagentModel,
    input: "hi",
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "2");
  assert.ok(!(await response.text()).includes("DO_NOT_LEAK_SECRET"));
});
test("Upstream timeouts are bounded", async (t) => {
  const f = await fixture(t, { requestTimeoutMs: 100 });
  f.setMode("timeout");
  const response = await f.post("/v1/responses", {
    model: f.config.routes.codexSubagentModel,
    input: "hi",
  });
  assert.equal(response.status, 504);
});
