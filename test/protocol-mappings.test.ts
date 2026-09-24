import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError, type JsonObject } from "../src/types.js";
import {
  anthropicToResponses,
  responsesToAnthropic,
  responsesToAnthropicResponse,
  anthropicToResponsesResponse,
} from "../src/protocol/mappings.js";

const schema = {
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
};
const image = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "aGk=" },
};
const inputImage = {
  type: "input_image",
  image_url: "data:image/png;base64,aGk=",
};
const anthropicTool = {
  name: "read",
  description: "Read a file",
  input_schema: schema,
};
const functionTool = {
  type: "function",
  name: "read",
  description: "Read a file",
  parameters: schema,
  strict: false,
};
const customTool = {
  type: "custom",
  name: "apply_patch",
  description: "Apply a patch",
  format: { type: "text" },
};
const patch = "*** Begin Patch\n*** Add File: a.txt\n+hello\n*** End Patch";

function aRequest(extra: JsonObject = {}): JsonObject {
  return {
    model: "claude-client",
    messages: [{ role: "user", content: "Hello" }],
    ...extra,
  };
}
function rRequest(extra: JsonObject = {}): JsonObject {
  return { model: "codex-client", input: "Hello", ...extra };
}
function aResponse(extra: JsonObject = {}): JsonObject {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "upstream",
    content: [{ type: "text", text: "Hello" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 7 },
    ...extra,
  };
}
function rResponse(extra: JsonObject = {}): JsonObject {
  return {
    id: "resp_test",
    object: "response",
    status: "completed",
    error: null,
    incomplete_details: null,
    output: [
      {
        type: "message",
        id: "msg_test",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Hello", annotations: [] }],
      },
    ],
    usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 },
    ...extra,
  };
}
function error(fn: () => unknown, status: number, match: RegExp): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof HttpError, String(err));
    assert.equal(err.status, status);
    assert.match(err.message, match);
    return true;
  });
}
function call(id = "call_1", name = "read"): JsonObject {
  return {
    type: "function_call",
    call_id: id,
    name,
    arguments: '{"path":"a.txt"}',
  };
}
function result(id = "call_1"): JsonObject {
  return { type: "function_call_output", call_id: id, output: "file contents" };
}
function use(id = "call_1", name = "read"): JsonObject {
  return { type: "tool_use", id, name, input: { path: "a.txt" } };
}

test("Anthropic request overrides model, defaults integer token budget, and disables storage", () => {
  assert.deepEqual(anthropicToResponses(aRequest(), "gpt-target"), {
    model: "gpt-target",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Hello" }],
      },
    ],
    max_output_tokens: 8192,
    store: false,
  });
});

test("Responses request overrides model and supplies required integer max_tokens", () => {
  const { request, customTools } = responsesToAnthropic(
    rRequest(),
    "claude-target",
  );
  assert.deepEqual(request, {
    model: "claude-target",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    max_tokens: 8192,
  });
  assert.deepEqual(customTools, new Set());
});

test("preserves ordered Anthropic system text, user images, assistant text, calls, and results", () => {
  const mapped = anthropicToResponses(
    aRequest({
      system: [
        { type: "text", text: "first", cache_control: { type: "ephemeral" } },
        { type: "text", text: "second" },
      ],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "before" },
            image,
            { type: "text", text: "after" },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "checking" },
            use(),
            { type: "text", text: "called" },
            use("call_2"),
            { type: "text", text: "waiting" },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1",
              content: [{ type: "text", text: "screen" }, image],
            },
            { type: "tool_result", tool_use_id: "call_2", content: "ok" },
            { type: "text", text: "continue" },
          ],
        },
      ],
    }),
    "target",
  );
  assert.deepEqual(mapped.input, [
    {
      type: "message",
      role: "system",
      content: [
        { type: "input_text", text: "first" },
        { type: "input_text", text: "second" },
      ],
    },
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "before" },
        inputImage,
        { type: "input_text", text: "after" },
      ],
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "checking" }],
    },
    call(),
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "called" }],
    },
    call("call_2"),
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "waiting" }],
    },
    {
      type: "function_call_output",
      call_id: "call_1",
      output: [{ type: "input_text", text: "screen" }, inputImage],
    },
    { type: "function_call_output", call_id: "call_2", output: "ok" },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "continue" }],
    },
  ]);
});

test("preserves instructions and leading system/developer messages without losing text boundaries", () => {
  const { request } = responsesToAnthropic(
    rRequest({
      instructions: "instructions",
      input: [
        { role: "system", content: "system" },
        {
          type: "message",
          role: "developer",
          content: [
            { type: "input_text", text: "developer 1" },
            { type: "input_text", text: "developer 2" },
          ],
        },
        {
          role: "user",
          content: [
            { type: "input_text", text: "before" },
            inputImage,
            { type: "input_text", text: "after" },
          ],
        },
      ],
    }),
    "target",
  );
  assert.deepEqual(
    request.system,
    ["instructions", "system", "developer 1", "developer 2"].map((text) => ({
      type: "text",
      text,
    })),
  );
  assert.deepEqual(request.messages, [
    {
      role: "user",
      content: [
        { type: "text", text: "before" },
        image,
        { type: "text", text: "after" },
      ],
    },
  ]);
});

test("rejects late system/developer messages rather than hoisting and changing scope", () => {
  for (const role of ["system", "developer"])
    error(
      () =>
        responsesToAnthropic(
          rRequest({
            input: [
              { role: "user", content: "hi" },
              { role, content: "late" },
            ],
          }),
          "target",
        ),
      400,
      /late system\/developer/,
    );
});

test("combines adjacent Responses assistant messages and calls in order, then tool outputs and user text", () => {
  const { request } = responsesToAnthropic(
    rRequest({
      input: [
        { role: "user", content: "read" },
        {
          type: "message",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "checking" }],
        },
        call(),
        { role: "assistant", content: "next" },
        call("call_2"),
        {
          ...result(),
          output: [{ type: "input_text", text: "screen" }, inputImage],
        },
        result("call_2"),
        { role: "user", content: "continue" },
      ],
    }),
    "target",
  );
  assert.deepEqual(request.messages, [
    { role: "user", content: [{ type: "text", text: "read" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "checking" },
        use(),
        { type: "text", text: "next" },
        use("call_2"),
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_1",
          content: [{ type: "text", text: "screen" }, image],
        },
        {
          type: "tool_result",
          tool_use_id: "call_2",
          content: "file contents",
        },
        { type: "text", text: "continue" },
      ],
    },
  ]);
});

test("tool errors retain their meaning for string, multimodal, and empty tool results", () => {
  for (const [content, expected] of [
    ["permission denied", "Tool error: permission denied"],
    [
      [{ type: "text", text: "failed" }, image],
      [
        { type: "input_text", text: "Tool error:" },
        { type: "input_text", text: "failed" },
        inputImage,
      ],
    ],
    [undefined, "Tool error: "],
    [[], [{ type: "input_text", text: "Tool error:" }]],
  ]) {
    const mapped = anthropicToResponses(
      aRequest({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call_1",
                is_error: true,
                content,
              },
            ],
          },
        ],
      }),
      "target",
    );
    assert.deepEqual(mapped.input[0].output, expected);
  }
});

test("URL image sources translate both ways, including tool-result images", () => {
  const aImage = {
    type: "image",
    source: { type: "url", url: "https://example.com/image.png" },
  };
  const rImage = {
    type: "input_image",
    image_url: "https://example.com/image.png",
  };
  const r = anthropicToResponses(
    aRequest({ messages: [{ role: "user", content: [aImage] }] }),
    "target",
  );
  assert.deepEqual(r.input[0].content, [rImage]);
  assert.deepEqual(
    responsesToAnthropic(
      rRequest({ input: [call(), { ...result(), output: [rImage] }] }),
      "target",
    ).request.messages[1].content[0].content,
    [aImage],
  );
});

test("all supported image media types and auto detail are accepted", () => {
  for (const media_type of [
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
  ]) {
    const mapped = responsesToAnthropic(
      rRequest({
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_image",
                image_url: `data:${media_type};base64,aGk=`,
                detail: "auto",
              },
            ],
          },
        ],
      }),
      "target",
    );
    assert.equal(
      mapped.request.messages[0].content[0].source.media_type,
      media_type,
    );
  }
});

test("maps function definitions, descriptions, schemas, and explicit strictness", () => {
  assert.deepEqual(
    anthropicToResponses(aRequest({ tools: [anthropicTool] }), "target").tools,
    [functionTool],
  );
  assert.deepEqual(
    responsesToAnthropic(rRequest({ tools: [functionTool] }), "target").request
      .tools,
    [{ ...anthropicTool, strict: false }],
  );
  assert.equal(
    anthropicToResponses(
      aRequest({ tools: [{ ...anthropicTool, strict: true }] }),
      "target",
    ).tools[0].strict,
    true,
  );
  assert.equal(
    responsesToAnthropic(
      rRequest({ tools: [{ ...functionTool, strict: true }] }),
      "target",
    ).request.tools[0].strict,
    true,
  );
});

test("omitted function strictness normalizes portable object schemas without mutating them", () => {
  const parameters = {
    type: "object",
    properties: {
      optional: { type: ["string", "null"] },
      nested: { type: "object", properties: { count: { type: "integer" } } },
    },
  };
  const before = structuredClone(parameters);
  const { request } = responsesToAnthropic(
    rRequest({ tools: [{ type: "function", name: "f", parameters }] }),
    "target",
  );
  assert.equal(request.tools[0].strict, true);
  assert.deepEqual(request.tools[0].input_schema.required, [
    "optional",
    "nested",
  ]);
  assert.deepEqual(request.tools[0].input_schema.properties.nested.required, [
    "count",
  ]);
  assert.equal(
    request.tools[0].input_schema.properties.nested.additionalProperties,
    false,
  );
  assert.deepEqual(parameters, before);
  const incompatible = {
    type: "object",
    properties: {
      map: { type: "object", additionalProperties: { type: "string" } },
    },
  };
  const fallback = responsesToAnthropic(
    rRequest({
      tools: [{ type: "function", name: "f", parameters: incompatible }],
    }),
    "target",
  ).request.tools[0];
  assert.equal(fallback.strict, false);
  assert.deepEqual(fallback.input_schema, incompatible);
});

test("custom tool format validation never turns unknown encodings into ordinary functions", () => {
  for (const format of [
    { type: "json" },
    { type: "grammar", syntax: "unknown", definition: "x" },
    { type: "grammar", syntax: "lark", definition: "" },
    { type: "text", ignored_constraint: true },
  ])
    error(
      () =>
        responsesToAnthropic(
          rRequest({ tools: [{ ...customTool, format }] }),
          "target",
        ),
      400,
      /format|grammar|definition/,
    );
  const mapped = responsesToAnthropic(
    rRequest({ tools: [{ type: "custom", name: "raw" }] }),
    "target",
  );
  assert.deepEqual(mapped.customTools, new Set(["raw"]));
  assert.deepEqual(mapped.request.tools[0].input_schema.properties, {
    input: { type: "string" },
  });
});

test("custom freeform tools use exactly one input string, preserve raw calls, and mark customTools", () => {
  const { request, customTools } = responsesToAnthropic(
    rRequest({
      tools: [customTool, functionTool],
      input: [
        { role: "user", content: "patch" },
        {
          type: "custom_tool_call",
          id: "ctc_1",
          call_id: "patch_1",
          name: "apply_patch",
          input: patch,
        },
        { type: "custom_tool_call_output", call_id: "patch_1", output: "Done" },
      ],
    }),
    "target",
  );
  assert.deepEqual(customTools, new Set(["apply_patch"]));
  assert.deepEqual(request.tools[0], {
    name: "apply_patch",
    description: "Apply a patch",
    input_schema: {
      type: "object",
      properties: { input: { type: "string" } },
      required: ["input"],
      additionalProperties: false,
    },
  });
  assert.deepEqual(request.messages[1].content, [
    {
      type: "tool_use",
      id: "patch_1",
      name: "apply_patch",
      input: { input: patch },
    },
  ]);
  assert.deepEqual(request.messages[2].content, [
    { type: "tool_result", tool_use_id: "patch_1", content: "Done" },
  ]);
});

test("Codex apply_patch grammar is retained as input instructions, not discarded", () => {
  for (const syntax of ["lark", "regex"]) {
    const definition =
      syntax === "lark"
        ? 'start: "*** Begin Patch" /(.|\n)*/ "*** End Patch"'
        : "^patch.*$";
    const { request, customTools } = responsesToAnthropic(
      rRequest({
        tools: [
          { ...customTool, format: { type: "grammar", syntax, definition } },
        ],
      }),
      "target",
    );
    assert.deepEqual(customTools, new Set(["apply_patch"]));
    const inputSchema = request.tools[0].input_schema;
    assert.deepEqual(Object.keys(inputSchema.properties), ["input"]);
    assert.equal(inputSchema.properties.input.type, "string");
    assert.ok(inputSchema.properties.input.description.includes(definition));
    assert.ok(inputSchema.properties.input.description.includes(syntax));
  }
});

test("custom tool history can restore customTools even when its definition is no longer declared", () => {
  const { request, customTools } = responsesToAnthropic(
    rRequest({
      input: [
        {
          type: "custom_tool_call",
          call_id: "patch",
          name: "apply_patch",
          input: "",
        },
        {
          type: "custom_tool_call_output",
          call_id: "patch",
          output: [{ type: "input_text", text: "ok" }, inputImage],
        },
      ],
    }),
    "target",
  );
  assert.deepEqual(customTools, new Set(["apply_patch"]));
  assert.deepEqual(request.messages[0].content[0].input, { input: "" });
  assert.deepEqual(request.messages[1].content[0].content, [
    { type: "text", text: "ok" },
    image,
  ]);
});

test("function and custom call/output round trip through nonstream response and subsequent request", () => {
  const customTools = new Set(["apply_patch"]);
  const response = anthropicToResponsesResponse(
    aResponse({
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "editing" },
        use(),
        {
          type: "tool_use",
          id: "patch_1",
          name: "apply_patch",
          input: { input: patch },
        },
      ],
    }),
    "codex-client",
    customTools,
  );
  assert.equal(response.output[1].type, "function_call");
  assert.equal(response.output[2].type, "custom_tool_call");
  assert.equal(response.output[2].input, patch);
  assert.equal(response.output[2].arguments, undefined);
  const { request } = responsesToAnthropic(
    rRequest({
      tools: [functionTool, customTool],
      input: [
        { role: "user", content: "edit" },
        ...response.output,
        result(),
        { type: "custom_tool_call_output", call_id: "patch_1", output: "ok" },
      ],
    }),
    "claude",
  );
  assert.deepEqual(request.messages[1].content[2].input, { input: patch });
  assert.equal(request.messages[2].content[1].tool_use_id, "patch_1");
});

for (const [aChoice, rChoice] of [
  [{ type: "auto" }, "auto"],
  [{ type: "none" }, "none"],
  [{ type: "any" }, "required"],
  [
    { type: "tool", name: "read" },
    { type: "function", name: "read" },
  ],
] as const) {
  test(`tool_choice maps ${JSON.stringify(aChoice)} both ways`, () => {
    assert.deepEqual(
      anthropicToResponses(
        aRequest({ tools: [anthropicTool], tool_choice: aChoice }),
        "target",
      ).tool_choice,
      rChoice,
    );
    assert.deepEqual(
      responsesToAnthropic(
        rRequest({ tools: [functionTool], tool_choice: rChoice }),
        "target",
      ).request.tool_choice,
      aChoice,
    );
  });
}

test("custom named tool choice and parallel flags map without changing custom call kind", () => {
  assert.deepEqual(
    responsesToAnthropic(
      rRequest({
        tools: [customTool],
        tool_choice: { type: "custom", name: "apply_patch" },
        parallel_tool_calls: false,
      }),
      "target",
    ).request.tool_choice,
    { type: "tool", name: "apply_patch", disable_parallel_tool_use: true },
  );
  assert.deepEqual(
    responsesToAnthropic(rRequest({ parallel_tool_calls: true }), "target")
      .request.tool_choice,
    { type: "auto", disable_parallel_tool_use: false },
  );
  assert.deepEqual(
    responsesToAnthropic(
      rRequest({ tool_choice: "none", parallel_tool_calls: false }),
      "target",
    ).request.tool_choice,
    { type: "none" },
  );
  assert.equal(
    anthropicToResponses(
      aRequest({
        tool_choice: { type: "auto", disable_parallel_tool_use: true },
      }),
      "target",
    ).parallel_tool_calls,
    false,
  );
});

test("Claude Code cache/metadata/thinking options are accepted without forwarding provider-specific params", () => {
  const mapped = anthropicToResponses(
    aRequest({
      max_tokens: 1234,
      stream: true,
      temperature: 0.2,
      top_p: 0.8,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      metadata: { user_id: "session-user" },
      cache_control: { type: "ephemeral", ttl: "1h" },
      context_management: {
        edits: [{ type: "clear_thinking_20251015", keep: "all" }],
      },
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private", signature: "sig" },
            { type: "redacted_thinking", data: "opaque" },
            { type: "text", text: "answer" },
          ],
        },
      ],
    }),
    "target",
  );
  assert.equal(mapped.max_output_tokens, 1234);
  assert.equal(mapped.stream, true);
  assert.equal(mapped.temperature, 0.2);
  assert.equal(mapped.top_p, 0.8);
  for (const field of [
    "thinking",
    "reasoning",
    "output_config",
    "metadata",
    "context_management",
    "cache_control",
  ])
    assert.equal(mapped[field], undefined);
  assert.deepEqual(mapped.input, [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "answer" }],
    },
  ]);
});

test("Codex common options are accepted; reasoning omitted and verbosity becomes an instruction", () => {
  const { request } = responsesToAnthropic(
    rRequest({
      stream: true,
      stream_options: { include_usage: true, include_obfuscation: false },
      store: false,
      background: false,
      previous_response_id: null,
      conversation: null,
      truncation: "disabled",
      context_management: [],
      service_tier: "default",
      max_output_tokens: 256,
      reasoning: { effort: "high", summary: "auto" },
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: "session",
      prompt_cache_retention: "in_memory",
      metadata: { session_id: "s" },
      safety_identifier: "user",
      user: "user",
      text: { format: { type: "text" }, verbosity: "low" },
      input: [
        {
          type: "reasoning",
          encrypted_content: "opaque-reasoning",
          summary: [],
        },
        { role: "user", content: "hello" },
      ],
    }),
    "target",
  );
  assert.equal(request.max_tokens, 256);
  assert.equal(request.stream, true);
  for (const field of [
    "reasoning",
    "thinking",
    "include",
    "metadata",
    "store",
    "prompt_cache_key",
    "stream_options",
    "text",
  ])
    assert.equal(request[field], undefined);
  assert.deepEqual(request.system, [
    { type: "text", text: "Respond with low verbosity." },
  ]);
  assert.deepEqual(request.messages, [
    { role: "user", content: [{ type: "text", text: "hello" }] },
  ]);
});

for (const value of [
  0,
  -1,
  1.5,
  "100",
  Number.NaN,
  Infinity,
  Number.MAX_SAFE_INTEGER + 1,
]) {
  test(`rejects invalid max token budget ${String(value)}`, () => {
    error(
      () => anthropicToResponses(aRequest({ max_tokens: value }), "target"),
      400,
      /max_tokens.*integer/,
    );
    error(
      () =>
        responsesToAnthropic(rRequest({ max_output_tokens: value }), "target"),
      400,
      /max_output_tokens.*integer/,
    );
  });
}

test("explicit null token limits use defaults and valid budgets are never rounded", () => {
  assert.equal(
    anthropicToResponses(aRequest({ max_tokens: null }), "target")
      .max_output_tokens,
    8192,
  );
  assert.equal(
    responsesToAnthropic(rRequest({ max_output_tokens: null }), "target")
      .request.max_tokens,
    8192,
  );
  assert.equal(
    responsesToAnthropic(rRequest({ max_output_tokens: 1 }), "target").request
      .max_tokens,
    1,
  );
});

for (const [extra, match] of [
  [{ previous_response_id: "resp_old" }, /previous_response_id.*stateless/],
  [{ conversation: "conv_1" }, /conversation.*stateless/],
  [{ prompt: { id: "prompt_1" } }, /prompt.*stateless/],
  [{ store: true }, /store.*false/],
  [{ background: true }, /background.*false/],
  [{ truncation: "auto" }, /truncation/],
  [{ context_management: [{ type: "compaction" }] }, /compaction/],
  [{ max_tool_calls: 1 }, /max_tool_calls/],
  [{ include: ["web_search_call.action.sources"] }, /include/],
  [{ text: { format: { type: "json_schema", schema } } }, /structured output/],
  [{ top_logprobs: 5 }, /log probabilities/],
  [{ service_tier: "priority" }, /service_tier/],
  [{ unexpected_behavior: true }, /unexpected_behavior/],
  [{ temperature: 1.7 }, /sampling/],
  [{ stream: "true" }, /stream.*boolean/],
  [{ parallel_tool_calls: "false" }, /parallel_tool_calls.*boolean/],
] as Array<[JsonObject, RegExp]>) {
  test(`Responses request rejects unsupported option ${Object.keys(extra)[0]}`, () =>
    error(() => responsesToAnthropic(rRequest(extra), "target"), 400, match));
}

for (const [extra, match] of [
  [{ top_k: 20 }, /top_k/],
  [{ stop_sequences: ["STOP"] }, /stop_sequences/],
  [
    { output_config: { format: { type: "json_schema", schema } } },
    /structured output/,
  ],
  [{ output_format: { type: "json_schema", schema } }, /structured output/],
  [
    { context_management: { edits: [{ type: "compact_20260112" }] } },
    /compaction/,
  ],
  [{ container: "container_1" }, /container.*stateful/],
  [{ mcp_servers: [{ type: "url", url: "https://mcp.example" }] }, /MCP/],
  [{ service_tier: "standard_only" }, /service_tier/],
  [{ inference_geo: "us" }, /geography/],
  [{ cache_control: { type: "permanent" } }, /cache/],
  [{ unexpected_behavior: true }, /unexpected_behavior/],
  [{ top_p: 1.1 }, /sampling/],
] as Array<[JsonObject, RegExp]>) {
  test(`Anthropic request rejects unsupported option ${Object.keys(extra)[0]}`, () =>
    error(() => anthropicToResponses(aRequest(extra), "target"), 400, match));
}

for (const tool of [
  { type: "web_search_preview" },
  { type: "web_search" },
  { type: "file_search" },
  { type: "code_interpreter" },
  { type: "computer_use_preview" },
  { type: "mcp" },
  { type: "apply_patch" },
  { type: "shell" },
  { type: "namespace", name: "ns", tools: [functionTool] },
  { ...functionTool, namespace: "ns" },
  { ...functionTool, defer_loading: true },
  { ...functionTool, allowed_callers: ["programmatic"] },
]) {
  test(`rejects Responses hosted/namespaced/server tool ${JSON.stringify(tool)}`, () =>
    error(
      () => responsesToAnthropic(rRequest({ tools: [tool] }), "target"),
      400,
      /unsupported|namespace/,
    ));
}

for (const tool of [
  { type: "web_search_20250305", name: "web_search" },
  { type: "bash_20250124", name: "bash" },
  { type: "computer_20250124", name: "computer" },
  { ...anthropicTool, namespace: "ns" },
  { ...anthropicTool, defer_loading: true },
  { ...anthropicTool, allowed_callers: ["code_execution_20250825"] },
]) {
  test(`rejects Anthropic hosted/server tool ${JSON.stringify(tool)}`, () =>
    error(
      () => anthropicToResponses(aRequest({ tools: [tool] }), "target"),
      400,
      /unsupported|namespace/,
    ));
}

test("does not silently drop one unsupported tool among valid tools", () => {
  error(
    () =>
      responsesToAnthropic(
        rRequest({ tools: [functionTool, { type: "web_search" }, customTool] }),
        "target",
      ),
    400,
    /tools\[1\]/,
  );
  error(
    () =>
      anthropicToResponses(
        aRequest({ tools: [anthropicTool, { type: "web_search_20250305" }] }),
        "target",
      ),
    400,
    /tools\[1\]/,
  );
});

test("rejects duplicate tool names and mismatched custom/function choices and calls", () => {
  error(
    () =>
      responsesToAnthropic(
        rRequest({ tools: [functionTool, functionTool] }),
        "target",
      ),
    400,
    /duplicate/,
  );
  error(
    () =>
      anthropicToResponses(
        aRequest({ tools: [anthropicTool, anthropicTool] }),
        "target",
      ),
    400,
    /duplicate/,
  );
  for (const tool_choice of [
    "invalid",
    "required",
    { type: "allowed_tools", tools: [] },
    { type: "function", name: "missing" },
  ])
    error(
      () => responsesToAnthropic(rRequest({ tool_choice }), "target"),
      400,
      /tool_choice/,
    );
  error(
    () =>
      responsesToAnthropic(
        rRequest({
          tools: [customTool],
          tool_choice: { type: "function", name: "apply_patch" },
        }),
        "target",
      ),
    400,
    /match/,
  );
  error(
    () =>
      responsesToAnthropic(
        rRequest({ tools: [customTool], input: [call("p", "apply_patch")] }),
        "target",
      ),
    400,
    /call kind/,
  );
  error(
    () =>
      anthropicToResponses(
        aRequest({ tool_choice: { type: "tool", name: "missing" } }),
        "target",
      ),
    400,
    /declared/,
  );
});

for (const item of [
  { type: "item_reference", id: "item_old" },
  { type: "compaction", encrypted_content: "opaque" },
  { type: "compaction_summary", content: "opaque" },
  { type: "web_search_call", status: "completed" },
  { type: "function_call", ...call(), namespace: "ns" },
]) {
  test(`rejects unsupported Responses history ${item.type}`, () =>
    error(
      () => responsesToAnthropic(rRequest({ input: [item] }), "target"),
      400,
      /unsupported|namespace/,
    ));
}

test("undeclared historical names cannot change between function and custom calls", () => {
  const customCall = {
    type: "custom_tool_call",
    call_id: "custom_1",
    name: "read",
    input: "raw",
  };
  for (const input of [
    [call(), customCall],
    [customCall, call()],
  ])
    error(
      () => responsesToAnthropic(rRequest({ input }), "target"),
      400,
      /call kind/,
    );
});

test("rejects malformed JSON function arguments, including primitives and arrays", () => {
  for (const args of ["{", "[]", "null", "123", '"hello"', { path: "a" }]) {
    error(
      () =>
        responsesToAnthropic(
          rRequest({ input: [{ ...call(), arguments: args }] }),
          "target",
        ),
      400,
      /arguments/,
    );
    error(
      () =>
        responsesToAnthropicResponse(
          rResponse({ output: [{ ...call(), arguments: args }] }),
          "model",
        ),
      502,
      /arguments/,
    );
  }
});

test("rejects orphan, duplicate, delayed, mismatched, and non-leading tool outputs", () => {
  for (const input of [
    [result()],
    [call(), result(), result()],
    [call(), call()],
    [
      call(),
      { type: "custom_tool_call_output", call_id: "call_1", output: "ok" },
    ],
    [call(), { role: "user", content: "before output" }, result()],
    [call(), call("call_2"), result()],
    [call(), result(), { role: "assistant", content: "done" }, result()],
  ])
    error(
      () => responsesToAnthropic(rRequest({ input }), "target"),
      400,
      /tool|call/,
    );
});

test("rejects unsupported content instead of coercing objects to strings", () => {
  for (const block of [
    { type: "document", source: {} },
    { type: "server_tool_use", name: "web" },
    { type: "compaction", content: "opaque" },
    { type: "text", text: 42 },
  ]) {
    error(
      () =>
        anthropicToResponses(
          aRequest({ messages: [{ role: "user", content: [block] }] }),
          "target",
        ),
      400,
      /content|text/,
    );
  }
  for (const block of [
    { type: "input_file", file_id: "f" },
    { type: "input_audio", input_audio: {} },
    { type: "input_text", text: {} },
  ]) {
    error(
      () =>
        responsesToAnthropic(
          rRequest({ input: [{ role: "user", content: [block] }] }),
          "target",
        ),
      400,
      /content|text/,
    );
  }
  error(
    () =>
      anthropicToResponses(
        aRequest({ system: [{ type: "compaction", content: "opaque" }] }),
        "target",
      ),
    400,
    /system/,
  );
  error(
    () =>
      anthropicToResponses(
        aRequest({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "id",
                  content: [{ type: "document" }],
                },
              ],
            },
          ],
        }),
        "target",
      ),
    400,
    /tool results/,
  );
  error(
    () =>
      responsesToAnthropic(
        rRequest({ input: [{ role: "user", content: { text: "no array" } }] }),
        "target",
      ),
    400,
    /array/,
  );
});

test("rejects image file IDs, unsupported types/detail, malformed data URLs, and assistant images", () => {
  for (const block of [
    { type: "input_image", file_id: "file_id" },
    { ...inputImage, detail: "high" },
    { ...inputImage, image_url: "data:image/svg+xml;base64,aGk=" },
    { ...inputImage, image_url: "data:image/png;utf8,hi" },
    { ...inputImage, image_url: "file:///tmp/img.png" },
    { ...inputImage, image_url: "not a url" },
  ])
    error(
      () =>
        responsesToAnthropic(
          rRequest({ input: [{ role: "user", content: [block] }] }),
          "target",
        ),
      400,
      /image|detail|file/,
    );
  error(
    () =>
      responsesToAnthropic(
        rRequest({ input: [{ role: "assistant", content: [inputImage] }] }),
        "target",
      ),
    400,
    /unsupported/,
  );
  error(
    () =>
      anthropicToResponses(
        aRequest({ messages: [{ role: "assistant", content: [image] }] }),
        "target",
      ),
    400,
    /unsupported/,
  );
});

test("rejects empty histories and unfinished request items even if reasoning is normally omitted", () => {
  error(
    () => responsesToAnthropic(rRequest({ input: [] }), "target"),
    400,
    /input/,
  );
  error(
    () => anthropicToResponses(aRequest({ messages: [] }), "target"),
    400,
    /messages/,
  );
  error(
    () =>
      responsesToAnthropic(
        rRequest({
          input: [
            { type: "reasoning", status: "in_progress" },
            { role: "user", content: "hi" },
          ],
        }),
        "target",
      ),
    400,
    /in_progress/,
  );
  error(
    () =>
      anthropicToResponses(
        aRequest({
          messages: [
            {
              role: "assistant",
              content: [{ type: "thinking", thinking: "private" }],
            },
          ],
        }),
        "target",
      ),
    400,
    /no translatable/,
  );
});

test("Responses nonstream response maps text, model, stop, and full uncached usage", () => {
  assert.deepEqual(responsesToAnthropicResponse(rResponse(), "claude-client"), {
    id: "resp_test",
    type: "message",
    role: "assistant",
    model: "claude-client",
    content: [{ type: "text", text: "Hello" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 12,
      output_tokens: 7,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  });
});

test("Anthropic nonstream response maps text, completed status, identifiers, and total usage", () => {
  const mapped = anthropicToResponsesResponse(
    aResponse(),
    "codex-client",
    new Set(),
  );
  assert.equal(mapped.id, "msg_test");
  assert.equal(mapped.object, "response");
  assert.equal(mapped.model, "codex-client");
  assert.equal(mapped.status, "completed");
  assert.equal(mapped.error, null);
  assert.equal(mapped.incomplete_details, null);
  assert.ok(Number.isInteger(mapped.created_at));
  assert.equal(mapped.output_text, "Hello");
  assert.equal(mapped.output[0].role, "assistant");
  assert.equal(mapped.output[0].status, "completed");
  assert.match(mapped.output[0].id, /^msg_/);
  assert.deepEqual(mapped.output[0].content, [
    { type: "output_text", text: "Hello", annotations: [], logprobs: [] },
  ]);
  assert.deepEqual(mapped.usage, {
    input_tokens: 12,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 7,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 19,
  });
});

test("nonstream outputs retain text/tool/text ordering and omit private reasoning", () => {
  const content = [
    { type: "text", text: "before" },
    use(),
    { type: "thinking", thinking: "private" },
    { type: "text", text: "after" },
  ];
  const mapped = anthropicToResponsesResponse(
    aResponse({ content, stop_reason: "tool_use" }),
    "model",
    new Set(),
  );
  assert.deepEqual(
    mapped.output.map((item: JsonObject) => item.type),
    ["message", "function_call", "message"],
  );
  assert.equal(mapped.output_text, "beforeafter");
  assert.equal(mapped.output[1].arguments, '{"path":"a.txt"}');
  const reversed = responsesToAnthropicResponse(
    {
      ...mapped,
      output: [
        ...mapped.output,
        { type: "reasoning", summary: [], encrypted_content: "private" },
      ],
    },
    "model",
  );
  assert.deepEqual(reversed.content, [content[0], content[1], content[3]]);
  assert.equal(reversed.stop_reason, "tool_use");
});

test("Responses custom output becomes Anthropic string input without JSON parsing", () => {
  const mapped = responsesToAnthropicResponse(
    rResponse({
      output: [
        {
          type: "custom_tool_call",
          id: "ctc",
          call_id: "patch",
          name: "apply_patch",
          input: patch,
          status: "completed",
        },
      ],
    }),
    "model",
  );
  assert.deepEqual(mapped.content, [
    {
      type: "tool_use",
      id: "patch",
      name: "apply_patch",
      input: { input: patch },
    },
  ]);
  assert.equal(mapped.stop_reason, "tool_use");
});

test("custom nonstream output rejects malformed wrappers instead of corrupting raw tool input", () => {
  for (const input of [
    { patch },
    { input: { patch } },
    { input: patch, other: "lost" },
    [],
    null,
  ]) {
    error(
      () =>
        anthropicToResponsesResponse(
          aResponse({
            content: [
              { type: "tool_use", id: "p", name: "apply_patch", input },
            ],
            stop_reason: "tool_use",
          }),
          "model",
          new Set(["apply_patch"]),
        ),
      502,
      /input/,
    );
  }
  const mapped = anthropicToResponsesResponse(
    aResponse({
      content: [
        {
          type: "tool_use",
          id: "p",
          name: "apply_patch",
          input: { input: "" },
        },
      ],
      stop_reason: "tool_use",
    }),
    "model",
    new Set(["apply_patch"]),
  );
  assert.equal(mapped.output[0].input, "");
});

test("cache reads/writes and reasoning output usage map without double-counting", () => {
  const usage = {
    input_tokens: 10,
    cache_read_input_tokens: 30,
    cache_creation_input_tokens: 20,
    output_tokens: 15,
    output_tokens_details: { thinking_tokens: 5 },
  };
  const mapped = anthropicToResponsesResponse(
    aResponse({ usage }),
    "model",
    new Set(),
  );
  assert.deepEqual(mapped.usage, {
    input_tokens: 60,
    input_tokens_details: { cached_tokens: 30, cache_write_tokens: 20 },
    output_tokens: 15,
    output_tokens_details: { reasoning_tokens: 5 },
    total_tokens: 75,
  });
  assert.deepEqual(responsesToAnthropicResponse(mapped, "model").usage, usage);
});

test("Responses cached input is subtracted from Anthropic noncached input, not output", () => {
  const mapped = responsesToAnthropicResponse(
    rResponse({
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 40 },
        output_tokens: 20,
        total_tokens: 120,
      },
    }),
    "model",
  );
  assert.deepEqual(mapped.usage, {
    input_tokens: 60,
    cache_read_input_tokens: 40,
    cache_creation_input_tokens: 0,
    output_tokens: 20,
  });
});

test("null optional cache details are treated as zero, including zero-token responses", () => {
  const mapped = anthropicToResponsesResponse(
    aResponse({
      content: [],
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
        output_tokens_details: null,
      },
    }),
    "model",
    new Set(),
  );
  assert.equal(mapped.usage.total_tokens, 0);
  assert.equal(mapped.usage.input_tokens_details.cached_tokens, 0);
  assert.equal(
    responsesToAnthropicResponse(
      rResponse({
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          input_tokens_details: null,
        },
      }),
      "model",
    ).usage.cache_read_input_tokens,
    0,
  );
});

test("recognized token-limit stops translate as incomplete/max_tokens rather than success", () => {
  for (const stop_reason of ["max_tokens", "model_context_window_exceeded"]) {
    const mapped = anthropicToResponsesResponse(
      aResponse({ stop_reason }),
      "model",
      new Set(),
    );
    assert.equal(mapped.status, "incomplete");
    assert.deepEqual(mapped.incomplete_details, {
      reason: "max_output_tokens",
    });
    assert.equal(mapped.output[0].status, "incomplete");
    assert.equal(
      responsesToAnthropicResponse(mapped, "model").stop_reason,
      "max_tokens",
    );
  }
  const r = rResponse({
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
  });
  assert.equal(
    responsesToAnthropicResponse(r, "model").stop_reason,
    "max_tokens",
  );
});

test("token-limit stop takes precedence over a complete tool call but rejects truncated JSON", () => {
  assert.equal(
    responsesToAnthropicResponse(
      rResponse({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [call()],
      }),
      "model",
    ).stop_reason,
    "max_tokens",
  );
  error(
    () =>
      responsesToAnthropicResponse(
        rResponse({
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [{ ...call(), status: "incomplete", arguments: "{" }],
        }),
        "model",
      ),
    502,
    /incomplete/,
  );
});

test("refusals and stop_sequence have portable nonstream shapes", () => {
  const mapped = anthropicToResponsesResponse(
    aResponse({
      stop_reason: "refusal",
      content: [{ type: "text", text: "Cannot help" }],
    }),
    "model",
    new Set(),
  );
  assert.deepEqual(mapped.output[0].content, [
    { type: "refusal", refusal: "Cannot help" },
  ]);
  assert.equal(
    responsesToAnthropicResponse(mapped, "model").stop_reason,
    "refusal",
  );
  assert.equal(
    anthropicToResponsesResponse(
      aResponse({ stop_reason: "stop_sequence", stop_sequence: "STOP" }),
      "model",
      new Set(),
    ).status,
    "completed",
  );
});

for (const status of [
  "failed",
  "error",
  "truncated",
  "in_progress",
  "queued",
  "cancelled",
  "incomplete",
  null,
  undefined,
]) {
  test(`nonstream Responses rejects ${String(status)} status`, () =>
    error(
      () => responsesToAnthropicResponse(rResponse({ status }), "model"),
      502,
      /status/,
    ));
}
for (const stop_reason of [
  "pause_turn",
  "error",
  "truncated",
  "in_progress",
  null,
  undefined,
]) {
  test(`nonstream Anthropic rejects ${String(stop_reason)} stop`, () =>
    error(
      () =>
        anthropicToResponsesResponse(
          aResponse({ stop_reason }),
          "model",
          new Set(),
        ),
      502,
      /stop_reason/,
    ));
}

test("nonstream rejects body/item errors and unfinished items, including omitted reasoning", () => {
  error(
    () =>
      responsesToAnthropicResponse(
        rResponse({ error: { code: "server_error" } }),
        "model",
      ),
    502,
    /error/,
  );
  error(
    () =>
      anthropicToResponsesResponse(
        aResponse({ error: { type: "api_error" } }),
        "model",
        new Set(),
      ),
    502,
    /error/,
  );
  for (const item of [
    { ...call(), status: "in_progress" },
    { type: "reasoning", status: "failed" },
    { ...call(), error: { message: "bad" } },
  ])
    error(
      () =>
        responsesToAnthropicResponse(rResponse({ output: [item] }), "model"),
      502,
      /status|error/,
    );
  const r = rResponse({
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
  });
  r.output[0].status = "incomplete";
  r.output[0].error = { message: "hidden error" };
  error(() => responsesToAnthropicResponse(r, "model"), 502, /error/);
  error(
    () =>
      responsesToAnthropicResponse(
        rResponse({
          status: "incomplete",
          incomplete_details: { reason: "content_filter" },
        }),
        "model",
      ),
    502,
    /status/,
  );
  error(
    () =>
      responsesToAnthropicResponse(
        rResponse({ incomplete_details: { reason: "max_output_tokens" } }),
        "model",
      ),
    502,
    /incomplete_details/,
  );
});

test("nonstream rejects unsupported hosted/server output, opaque compaction, and namespaces", () => {
  for (const item of [
    { type: "web_search_call" },
    { type: "file_search_call" },
    { type: "compaction", encrypted_content: "opaque" },
    { ...call(), namespace: "ns" },
  ])
    error(
      () =>
        responsesToAnthropicResponse(rResponse({ output: [item] }), "model"),
      400,
      /unsupported|namespace/,
    );
  for (const block of [
    { type: "server_tool_use", id: "srv" },
    { type: "web_search_tool_result" },
    { type: "compaction", content: "opaque" },
    { ...use(), namespace: "ns" },
    { ...use(), caller: { type: "code_execution_20250825" } },
  ])
    error(
      () =>
        anthropicToResponsesResponse(
          aResponse({ content: [block] }),
          "model",
          new Set(),
        ),
      400,
      /unsupported|namespace|server/,
    );
  error(
    () =>
      anthropicToResponsesResponse(
        aResponse({ container: { id: "state" } }),
        "model",
        new Set(),
      ),
    400,
    /stateful/,
  );
});

test("nonstream citations/annotations cannot be silently lost; malformed shapes are upstream errors", () => {
  const r = rResponse();
  r.output[0].content[0].annotations = [
    { type: "url_citation", url: "https://example.com" },
  ];
  error(() => responsesToAnthropicResponse(r, "model"), 400, /annotations/);
  r.output[0].content[0].annotations = {};
  error(() => responsesToAnthropicResponse(r, "model"), 502, /array/);
  error(
    () =>
      anthropicToResponsesResponse(
        aResponse({
          content: [
            {
              type: "text",
              text: "hi",
              citations: [{ type: "char_location" }],
            },
          ],
        }),
        "model",
        new Set(),
      ),
    400,
    /citations/,
  );
});

test("nonstream rejects malformed provider envelopes and missing required content/usage", () => {
  for (const extra of [
    { id: "" },
    { output: null },
    { usage: null },
    { object: "chat.completion" },
  ])
    error(
      () => responsesToAnthropicResponse(rResponse(extra), "model"),
      502,
      /response|output|usage/,
    );
  for (const extra of [
    { id: "" },
    { content: null },
    { usage: null },
    { role: "user" },
    { type: "error" },
    { stop_reason: "tool_use" },
  ])
    error(
      () => anthropicToResponsesResponse(aResponse(extra), "model", new Set()),
      502,
      /response|content|usage/,
    );
});

test("nonstream rejects invalid or inconsistent token accounting", () => {
  for (const usage of [
    { input_tokens: -1, output_tokens: 2 },
    { input_tokens: 1, output_tokens: 1.5 },
    { input_tokens: "1", output_tokens: 2 },
    { input_tokens: 1, output_tokens: 2, total_tokens: 99 },
    {
      input_tokens: 1,
      output_tokens: 2,
      input_tokens_details: { cached_tokens: 2 },
    },
    {
      input_tokens: 1,
      output_tokens: 2,
      output_tokens_details: { reasoning_tokens: 3 },
    },
    { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 2 },
  ])
    error(
      () => responsesToAnthropicResponse(rResponse({ usage }), "model"),
      502,
      /usage/,
    );
  for (const usage of [
    { input_tokens: 1, output_tokens: -1 },
    { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: -1 },
    { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 0.5 },
    {
      input_tokens: 1,
      output_tokens: 2,
      output_tokens_details: { thinking_tokens: 3 },
    },
  ])
    error(
      () =>
        anthropicToResponsesResponse(aResponse({ usage }), "model", new Set()),
      502,
      /usage/,
    );
  error(
    () =>
      anthropicToResponsesResponse(
        aResponse({
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            server_tool_use: { web_search_requests: 1 },
          },
        }),
        "model",
        new Set(),
      ),
    400,
    /server tool usage/,
  );
});

test("mappings do not mutate input histories, schemas, or provider responses", () => {
  const inputs = [
    aRequest({ tools: [anthropicTool] }),
    rRequest({ tools: [functionTool, customTool], input: [call(), result()] }),
    aResponse(),
    rResponse(),
  ];
  const before = structuredClone(inputs);
  anthropicToResponses(inputs[0]!, "target");
  responsesToAnthropic(inputs[1]!, "target");
  anthropicToResponsesResponse(inputs[2]!, "target", new Set());
  responsesToAnthropicResponse(inputs[3]!, "target");
  assert.deepEqual(inputs, before);
});
