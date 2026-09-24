import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSSE,
  encodeSSE,
  translateAnthropicStream,
  translateResponsesStream,
  responsesToAnthropic,
  anthropicToResponsesResponse,
  anthropicToResponses,
} from "../src/protocol/index.js";
import {
  routeCodexStream,
  routeCodexResponse,
} from "../src/protocol/subagents.js";
import type { JsonObject } from "../src/types.js";

async function* source(data: JsonObject[]) {
  for (const d of data) yield { event: d.type, data: d };
}
async function collect(
  iter: AsyncIterable<{ event: string; data: JsonObject }>,
) {
  const result: JsonObject[] = [];
  for await (const e of iter) result.push(e.data);
  return result;
}
const textOutput = {
  type: "message",
  id: "msg_x",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "hello", annotations: [] }],
};
const complete = (output: JsonObject[]) => ({
  type: "response.completed",
  response: {
    id: "resp_1",
    status: "completed",
    output,
    usage: { input_tokens: 10, output_tokens: 2 },
  },
});
const anthStart = {
  type: "message_start",
  message: {
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [],
    usage: { input_tokens: 10, output_tokens: 0 },
  },
};
const anthEnd = (reason = "end_turn") => [
  {
    type: "message_delta",
    delta: { stop_reason: reason },
    usage: { output_tokens: 2 },
  },
  { type: "message_stop" },
];
const textEvents = () => [
  anthStart,
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "hello" },
  },
  { type: "content_block_stop", index: 0 },
  ...anthEnd(),
];

for (const separator of ["\n", "\r\n", "\r"])
  test(`SSE handles one-byte chunks and ${JSON.stringify(separator)} boundaries`, async () => {
    const bytes = new TextEncoder().encode(
      `: ping${separator}event: hello${separator}data: {${separator}data: "type":"hello","text":"héllo"}${separator}${separator}data: [DONE]${separator}${separator}`,
    );
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const b of bytes) c.enqueue(Uint8Array.of(b));
        c.close();
      },
    });
    assert.deepEqual(await collect(parseSSE(stream)), [
      { type: "hello", text: "héllo" },
    ]);
  });
test("SSE flushes a valid final frame at EOF and rejects invalid JSON", async () => {
  const stream = (s: string) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(s));
        c.close();
      },
    });
  assert.deepEqual(await collect(parseSSE(stream('data: {"type":"final"}'))), [
    { type: "final" },
  ]);
  await assert.rejects(
    collect(parseSSE(stream("data: invalid\n\n"))),
    /invalid SSE JSON/,
  );
  await assert.rejects(
    collect(parseSSE(stream("data: []\n\n"))),
    /must be an object/,
  );
});
test("SSE enforces frame limits", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(8 * 1024 * 1024 + 1).fill(65));
      c.close();
    },
  });
  await assert.rejects(collect(parseSSE(stream)), /too large/);
});
test("Anthropic stream produces live text, stable IDs, usage and sequenced completion", async () => {
  const events = await collect(
    translateAnthropicStream(source(textEvents()), "alias", new Set()),
  );
  assert.deepEqual(
    events.map((e) => e.sequence_number),
    events.map((_, i) => i),
  );
  const final = events.at(-1)!;
  assert.equal(final.type, "response.completed");
  assert.equal(final.response.output[0].content[0].text, "hello");
  assert.equal(
    final.response.output[0].id,
    events.find((e) => e.type === "response.output_item.added")!.item.id,
  );
  assert.equal(final.response.usage.input_tokens, 10);
  assert.equal(
    events.find((e) => e.type === "response.output_text.delta")!.delta,
    "hello",
  );
});
test("Anthropic max_tokens becomes an incomplete Responses result", async () => {
  const input = textEvents();
  input.splice(-2, 2, ...anthEnd("max_tokens"));
  const events = await collect(
    translateAnthropicStream(source(input), "alias", new Set()),
  );
  assert.equal(events.at(-1)!.type, "response.incomplete");
  assert.equal(
    events.at(-1)!.response.incomplete_details.reason,
    "max_output_tokens",
  );
});
test("Anthropic custom tool JSON converts back to raw patch input", async () => {
  const patch = "*** Begin Patch\n*** End Patch";
  const events = await collect(
    translateAnthropicStream(
      source([
        anthStart,
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool_1",
            name: "apply_patch",
            input: {},
          },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify({ input: patch }),
          },
        },
        { type: "content_block_stop", index: 0 },
        ...anthEnd("tool_use"),
      ]),
      "alias",
      new Set(["apply_patch"]),
    ),
  );
  assert.equal(
    events.find((e) => e.type === "response.custom_tool_call_input.delta")!
      .delta,
    patch,
  );
  assert.equal(events.at(-1)!.response.output[0].type, "custom_tool_call");
  assert.equal(events.at(-1)!.response.output[0].input, patch);
});
test("Parallel Responses arguments are emitted as separate complete Anthropic blocks", async () => {
  const a = {
    type: "function_call",
    id: "fc_a",
    call_id: "a",
    name: "read",
    arguments: '{"path":"a"}',
    status: "completed",
  };
  const b = { ...a, id: "fc_b", call_id: "b", arguments: '{"path":"b"}' };
  const events = await collect(
    translateResponsesStream(
      source([
        { type: "response.created", response: { id: "resp_1" } },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...a, arguments: "" },
        },
        {
          type: "response.output_item.added",
          output_index: 1,
          item: { ...b, arguments: "" },
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          delta: '{"path":',
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 1,
          delta: '{"path":"b"}',
        },
        { type: "response.output_item.done", output_index: 1, item: b },
        { type: "response.output_item.done", output_index: 0, item: a },
        complete([a, b]),
      ]),
      "alias",
    ),
  );
  const deltas = events.filter((e) => e.delta?.type === "input_json_delta");
  assert.deepEqual(
    deltas.map((e) => JSON.parse(e.delta.partial_json)),
    [{ path: "b" }, { path: "a" }],
  );
  assert.equal(events.at(-2)!.delta.stop_reason, "tool_use");
  assert.equal(
    events.filter((e) => e.type === "content_block_start").length,
    2,
  );
});
test("Responses text streams live without duplicating the completed text", async () => {
  const events = await collect(
    translateResponsesStream(
      source([
        {
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          delta: "hello",
        },
        complete([textOutput]),
      ]),
      "alias",
    ),
  );
  assert.deepEqual(
    events
      .filter((e) => e.delta?.type === "text_delta")
      .map((e) => e.delta.text),
    ["hello"],
  );
  assert.equal(events.at(-2)!.usage.input_tokens, 10);
});
for (const direction of ["anthropic", "responses"])
  test(`${direction} truncated and failed streams cannot report success`, async () => {
    const run = (data: JsonObject[]) =>
      direction === "anthropic"
        ? translateAnthropicStream(source(data), "alias", new Set())
        : translateResponsesStream(source(data), "alias");
    await assert.rejects(collect(run([])), /completion/);
    await assert.rejects(collect(run([{ type: "error" }])), /failed/);
  });
test("Current Claude inline system messages and diagnostic metadata are accepted", () => {
  const out = anthropicToResponses(
    {
      model: "alias",
      messages: [
        { role: "user", content: "hi" },
        { role: "system", content: "reminder" },
      ],
      diagnostics: { agent: true },
    },
    "gpt",
  );
  assert.deepEqual(
    out.input.map((m: JsonObject) => m.role),
    ["user", "system"],
  );
});
test("Codex namespaces roundtrip calls and replies without ambiguous flattening", async () => {
  const { request, customTools } = responsesToAnthropic(
    {
      model: "alias",
      input: "hi",
      client_metadata: { source: "codex" },
      tools: [
        {
          type: "namespace",
          name: "multi_agent_v1",
          tools: [
            {
              type: "function",
              name: "spawn_agent",
              parameters: { type: "object", properties: {} },
              strict: false,
            },
          ],
        },
      ],
    },
    "claude",
  );
  const name = request.tools[0].name;
  const body = {
    id: "msg",
    type: "message",
    role: "assistant",
    content: [
      { type: "tool_use", id: "call", name, input: { message: "task" } },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  const result = anthropicToResponsesResponse(body, "alias", customTools);
  assert.equal(result.output[0].namespace, "multi_agent_v1");
  assert.equal(result.output[0].name, "spawn_agent");
  const events = await collect(
    translateAnthropicStream(
      source([
        anthStart,
        {
          type: "content_block_start",
          index: 0,
          content_block: body.content[0],
        },
        { type: "content_block_stop", index: 0 },
        ...anthEnd("tool_use"),
      ]),
      "alias",
      customTools,
    ),
  );
  assert.equal(
    events.find((e) => e.type === "response.output_item.added")!.item.namespace,
    "multi_agent_v1",
  );
});
test("Codex spawn routing rewrites every streamed representation but no unrelated call", async () => {
  const item = {
    type: "function_call",
    namespace: "multi_agent_v1",
    name: "spawn_agent",
    id: "fc",
    call_id: "call",
    arguments: '{"message":"task","model":"original"}',
  };
  const events = await collect(
    routeCodexStream(
      source([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...item, arguments: "" },
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          delta: item.arguments,
        },
        {
          type: "response.function_call_arguments.done",
          output_index: 0,
          arguments: item.arguments,
        },
        { type: "response.output_item.done", output_index: 0, item },
        complete([item]),
      ]),
      "arelay-claude",
    ),
  );
  const delta = events.find(
    (e) => e.type === "response.function_call_arguments.delta",
  )!;
  assert.equal(JSON.parse(delta.delta).model, "arelay-claude");
  assert.equal(
    JSON.parse(events.at(-1)!.response.output[0].arguments).model,
    "arelay-claude",
  );
  const unrelated = { ...item, name: "read" };
  assert.deepEqual(routeCodexResponse({ output: [unrelated] }, "alias"), {
    output: [unrelated],
  });
  assert.match(
    encodeSSE({ event: "hello", data: { type: "hello" } }),
    /^event: hello\ndata: /,
  );
});
