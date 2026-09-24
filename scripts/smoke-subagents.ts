// End-to-end native Codex subagent routing with entirely local mock backends.
import http from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createRelay } from "../src/server.js";
import { defaultConfig } from "../src/config.js";
import { setupClient } from "../src/setup.js";
import { encodeSSE } from "../src/protocol/index.js";
import type { JsonObject } from "../src/types.js";
const home = await mkdtemp(join(tmpdir(), "arelay-subagent-smoke-"));
process.env.CODEX_HOME = join(home, "codex");
process.env.ARELAY_HOME = join(home, "arelay");
process.env.ARELAY_SMOKE_KEY = "local-only";
let mainTurns = 0,
  childTurns = 0;
let childDone!: () => void;
const childCompleted = new Promise<void>((r) => {
  childDone = r;
});
const upstream = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  res.writeHead(200, { "content-type": "text/event-stream" });
  const emit = (type: string, data: JsonObject = {}) =>
    res.write(encodeSSE({ event: type, data: { type, ...data } }));
  if (req.url === "/v1/messages") {
    childTurns++;
    console.log("Anthropic subagent model:", body.model);
    emit("message_start", {
      message: {
        id: "msg_child",
        type: "message",
        role: "assistant",
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    });
    emit("content_block_start", {
      index: 0,
      content_block: { type: "text", text: "" },
    });
    emit("content_block_delta", {
      index: 0,
      delta: { type: "text_delta", text: "Child done" },
    });
    emit("content_block_stop", { index: 0 });
    emit("message_delta", {
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 2 },
    });
    emit("message_stop");
    res.end();
    childDone();
    return;
  }
  mainTurns++;
  console.log("Main model:", body.model);
  console.log("Main transport: standard Responses API");
  let item: JsonObject;
  if (mainTurns === 1)
    item = {
      id: "fc_spawn",
      type: "function_call",
      namespace: "multi_agent_v1",
      name: "spawn_agent",
      call_id: "call_spawn",
      arguments: JSON.stringify({
        message: "Say child done. Do not use any tools.",
      }),
      status: "completed",
    };
  else {
    await childCompleted;
    item = {
      id: "msg_main",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: "Native subagent routing passed",
          annotations: [],
        },
      ],
    };
  }
  const response = {
    id: `resp_${mainTurns}`,
    object: "response",
    status: "completed",
    model: body.model,
    output: [item],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
  emit("response.created", {
    response: { ...response, output: [], status: "in_progress" },
  });
  emit("response.output_item.added", {
    output_index: 0,
    item: {
      ...item,
      status: "in_progress",
      ...(item.type === "function_call" ? { arguments: "" } : {}),
    },
  });
  if (item.type === "function_call")
    emit("response.function_call_arguments.delta", {
      output_index: 0,
      item_id: item.id,
      delta: item.arguments,
    });
  emit("response.output_item.done", { output_index: 0, item });
  emit("response.completed", { response });
  res.end();
});
await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
const config = structuredClone(defaultConfig);
config.openai.baseUrl =
  config.anthropic.baseUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`;
config.openai.apiKeyEnv = config.anthropic.apiKeyEnv = "ARELAY_SMOKE_KEY";
const relay = createRelay(config);
await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
config.port = (relay.address() as { port: number }).port;
await mkdir(process.env.CODEX_HOME, { recursive: true });
await writeFile(
  join(process.env.CODEX_HOME, "config.toml"),
  `model="gpt-6-astra"\nmodel_provider="smoke"\nweb_search="disabled"\n[model_providers.smoke]\nname="smoke"\nbase_url="${config.openai.baseUrl}"\nwire_api="responses"\nenv_key="ARELAY_SMOKE_KEY"\nrequest_max_retries=0\nstream_max_retries=0\n`,
);
await setupClient("codex", config);
const child = spawn(
  "codex",
  [
    "exec",
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-rules",
    "-C",
    home,
    "Please spawn a subagent to say child done, then finish.",
  ],
  { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
);
child.stdout.on("data", (b) => process.stdout.write(b));
child.stderr.on("data", (b) => process.stderr.write(b));
const timer = setTimeout(() => child.kill(), 45000);
const code = await new Promise<number | null>((r) => child.on("exit", r));
clearTimeout(timer);
childDone();
for (const server of [relay, upstream]) {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
}
await rm(home, { recursive: true, force: true });
if (code !== 0 || childTurns !== 1 || mainTurns < 2) process.exitCode = 1;
console.log({ mainTurns, childTurns });
