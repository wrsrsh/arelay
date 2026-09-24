// End-to-end native Claude Code subagent routing against local mock backends.
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createRelay } from "../src/server.js";
import { defaultConfig } from "../src/config.js";
import { setupClient } from "../src/setup.js";
import { encodeSSE } from "../src/protocol/index.js";
import type { JsonObject } from "../src/types.js";
const home = await mkdtemp(join(tmpdir(), "arelay-claude-agent-"));
process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
process.env.ARELAY_HOME = join(home, "arelay");
process.env.ARELAY_SMOKE_KEY = "local-only";
let mainTurns = 0,
  childTurns = 0;
const upstream = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  res.writeHead(200, { "content-type": "text/event-stream" });
  const emit = (type: string, data: JsonObject = {}) =>
    res.write(encodeSSE({ event: type, data: { type, ...data } }));
  if (req.url === "/v1/responses") {
    childTurns++;
    console.log("OpenAI subagent model:", body.model);
    const item = {
      id: "msg_child",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Child done", annotations: [] }],
    };
    const response = {
      id: "resp_child",
      status: "completed",
      output: [item],
      usage: { input_tokens: 1, output_tokens: 2 },
    };
    emit("response.created", {
      response: { ...response, status: "in_progress", output: [] },
    });
    emit("response.output_text.delta", {
      output_index: 0,
      content_index: 0,
      delta: "Child done",
    });
    emit("response.completed", { response });
    res.end();
    return;
  }
  mainTurns++;
  console.log("Main Claude model:", body.model);
  emit("message_start", {
    message: {
      id: `msg_main_${mainTurns}`,
      type: "message",
      role: "assistant",
      model: body.model,
      content: [],
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  });
  if (mainTurns === 1) {
    emit("content_block_start", {
      index: 0,
      content_block: {
        type: "tool_use",
        id: "toolu_spawn",
        name: "Agent",
        input: {},
      },
    });
    emit("content_block_delta", {
      index: 0,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify({
          description: "Local routing smoke test",
          subagent_type: "general-purpose",
          prompt: "Say child done without calling any tools.",
        }),
      },
    });
  } else {
    emit("content_block_start", {
      index: 0,
      content_block: { type: "text", text: "" },
    });
    emit("content_block_delta", {
      index: 0,
      delta: {
        type: "text_delta",
        text: "Native Claude subagent routing passed",
      },
    });
  }
  emit("content_block_stop", { index: 0 });
  emit("message_delta", {
    delta: {
      stop_reason: mainTurns === 1 ? "tool_use" : "end_turn",
      stop_sequence: null,
    },
    usage: { output_tokens: 2 },
  });
  emit("message_stop");
  res.end();
});
await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
const config = structuredClone(defaultConfig);
config.openai.baseUrl =
  config.anthropic.baseUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`;
config.openai.apiKeyEnv = config.anthropic.apiKeyEnv = "ARELAY_SMOKE_KEY";
const relay = createRelay(config, (e) => console.error("Relay error:", e));
await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
config.port = (relay.address() as { port: number }).port;
await setupClient("claude", config);
const child = spawn(
  "claude",
  [
    "-p",
    "--model",
    "claude-sonnet-4-6",
    "Please use an Agent subagent to say child done, then finish.",
  ],
  {
    cwd: home,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: "smoke-local-only",
      CLAUDE_CODE_OAUTH_TOKEN: "",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ENABLE_TOOL_SEARCH: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
child.stdout.on("data", (b) => process.stdout.write(b));
child.stderr.on("data", (b) => process.stderr.write(b));
const timer = setTimeout(() => child.kill(), 45000);
const code = await new Promise<number | null>((r) => child.on("exit", r));
clearTimeout(timer);
console.log(
  "Relay stats:",
  await (await fetch(`http://127.0.0.1:${config.port}/stats`)).json(),
);
for (const server of [relay, upstream]) {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
}
await rm(home, { recursive: true, force: true });
if (code !== 0 || childTurns < 1 || mainTurns < 2) process.exitCode = 1;
console.log({ mainTurns, childTurns });
