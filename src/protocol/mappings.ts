import { randomUUID } from "node:crypto";
import { HttpError, type JsonObject } from "../types.js";

const DEFAULT_MAX_TOKENS = 8192;
const IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

function fail(path: string, message: string, status = 400): never {
  throw new HttpError(status, `${path}: ${message}`);
}

function object(value: unknown, path: string, status = 400): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "expected an object", status);
  }
  return value as JsonObject;
}

function array(value: unknown, path: string, status = 400): unknown[] {
  if (!Array.isArray(value)) fail(path, "expected an array", status);
  return value;
}

function string(value: unknown, path: string, status = 400): string {
  if (typeof value !== "string") fail(path, "expected a string", status);
  return value;
}

function identifier(value: unknown, path: string, status = 400): string {
  const result = string(value, path, status);
  if (!result.length) fail(path, "must not be empty", status);
  return result;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "expected a boolean");
  return value;
}

function integer(
  value: unknown,
  path: string,
  minimum = 0,
  status = 400,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    fail(path, `expected an integer >= ${minimum}`, status);
  }
  return value;
}

function keys(value: JsonObject, allowed: string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (value[key] !== undefined && !allowed.includes(key)) {
      fail(
        `${path}.${key}`,
        "unsupported; remove this field before crossing providers",
      );
    }
  }
}

function absent(value: unknown, path: string, explanation: string): void {
  if (value != null) fail(path, explanation);
}

function emptyArray(
  value: unknown,
  path: string,
  explanation: string,
  status = 400,
): void {
  if (value != null && array(value, path, status).length)
    fail(path, explanation);
}

function completed(item: JsonObject, path: string, status = 400): void {
  if (item.status != null && item.status !== "completed") {
    fail(
      `${path}.status`,
      `cannot translate ${String(item.status)}; supply a completed item`,
      status,
    );
  }
  if (item.error != null)
    fail(`${path}.error`, "provider returned an error", status);
}

function noNamespace(item: JsonObject, path: string): void {
  absent(
    item.namespace,
    `${path}.namespace`,
    "namespaced tools are unsupported; use flat client tools",
  );
}

function cacheControl(value: unknown, path: string): void {
  if (value == null) return;
  const cache = object(value, path);
  keys(cache, ["type", "ttl"], path);
  if (
    cache.type !== "ephemeral" ||
    (cache.ttl != null && !["5m", "1h"].includes(cache.ttl))
  ) {
    fail(path, "only ephemeral cache hints are supported");
  }
  // Cache placement is provider-specific; never forward Anthropic cache hints to OpenAI.
}

function annotations(value: unknown, path: string, status = 400): void {
  emptyArray(
    value,
    path,
    "citations/annotations cannot be preserved across providers; use plain text",
    status,
  );
}

function anthropicImage(block: JsonObject, path: string): JsonObject {
  keys(block, ["type", "source", "cache_control"], path);
  cacheControl(block.cache_control, `${path}.cache_control`);
  const source = object(block.source, `${path}.source`);
  if (source.type === "base64") {
    keys(source, ["type", "media_type", "data"], `${path}.source`);
    if (!IMAGE_TYPES.has(source.media_type))
      fail(path, "use a JPEG, PNG, GIF, or WebP image");
    const data = identifier(source.data, `${path}.source.data`);
    return {
      type: "input_image",
      image_url: `data:${source.media_type};base64,${data}`,
    };
  }
  if (source.type === "url") {
    keys(source, ["type", "url"], `${path}.source`);
    const url = imageUrl(source.url, `${path}.source.url`);
    return { type: "input_image", image_url: url };
  }
  return fail(
    path,
    "unsupported image source; supply base64 data or an HTTP(S) URL",
  );
}

function imageUrl(value: unknown, path: string): string {
  const url = string(value, path);
  try {
    if (!["http:", "https:"].includes(new URL(url).protocol)) throw new Error();
  } catch {
    fail(path, "expected an absolute HTTP(S) image URL");
  }
  return url;
}

function responsesImage(block: JsonObject, path: string): JsonObject {
  keys(block, ["type", "image_url", "file_id", "detail"], path);
  absent(
    block.file_id,
    `${path}.file_id`,
    "file IDs are provider-local; supply image_url or a base64 data URL",
  );
  if (block.detail != null && block.detail !== "auto") {
    fail(
      `${path}.detail`,
      "explicit image detail has no Anthropic equivalent; use auto",
    );
  }
  const url = string(block.image_url, `${path}.image_url`);
  if (url.startsWith("data:")) {
    const match =
      /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
        url,
      );
    if (!match)
      fail(path, "use a base64 JPEG, PNG, GIF, or WebP image data URL");
    return {
      type: "image",
      source: { type: "base64", media_type: match[1], data: match[2] },
    };
  }
  return {
    type: "image",
    source: { type: "url", url: imageUrl(url, `${path}.image_url`) },
  };
}

function anthropicText(
  block: JsonObject,
  path: string,
  status = 400,
): JsonObject {
  keys(block, ["type", "text", "cache_control", "citations"], path);
  cacheControl(block.cache_control, `${path}.cache_control`);
  annotations(block.citations, `${path}.citations`, status);
  return {
    type: "input_text",
    text: string(block.text, `${path}.text`, status),
  };
}

function responsesContent(
  value: unknown,
  path: string,
  images: boolean,
  status = 400,
): JsonObject[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  return array(value, path, status).map((raw, index) => {
    const p = `${path}[${index}]`;
    const block = object(raw, p, status);
    if (block.type === "input_text" || block.type === "output_text") {
      keys(block, ["type", "text", "annotations", "logprobs"], p);
      annotations(block.annotations, `${p}.annotations`, status);
      emptyArray(
        block.logprobs,
        `${p}.logprobs`,
        "log probabilities cannot be mapped to Anthropic",
        status,
      );
      return { type: "text", text: string(block.text, `${p}.text`, status) };
    }
    if (block.type === "refusal") {
      keys(block, ["type", "refusal"], p);
      return {
        type: "text",
        text: string(block.refusal, `${p}.refusal`, status),
      };
    }
    if (block.type === "input_image" && images) return responsesImage(block, p);
    return fail(
      p,
      `unsupported content type ${String(block.type)}; use text${images ? " or images" : ""}`,
    );
  });
}

function parseArguments(
  value: unknown,
  path: string,
  status = 400,
): JsonObject {
  const text = string(value, path, status);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(path, "tool arguments must be complete, valid JSON objects", status);
  }
  return object(parsed, path, status);
}

function toolOptions(tool: JsonObject, path: string): void {
  noNamespace(tool, path);
  if (
    tool.defer_loading != null &&
    boolean(tool.defer_loading, `${path}.defer_loading`)
  ) {
    fail(
      path,
      "deferred/tool-search tools are unsupported; send the complete client tool definition",
    );
  }
  if (tool.allowed_callers != null) {
    for (const caller of array(
      tool.allowed_callers,
      `${path}.allowed_callers`,
    )) {
      if (caller !== "direct")
        fail(
          path,
          "server/programmatic tool callers are unsupported; use direct calls",
        );
    }
  }
}

function uniqueTool(name: string, names: Set<string>, path: string): void {
  if (names.has(name))
    fail(path, `duplicate tool name ${name}; use unique flat names`);
  names.add(name);
}

function anthropicTools(value: unknown): {
  tools: JsonObject[];
  names: Set<string>;
} {
  const names = new Set<string>();
  const tools = array(value ?? [], "tools").map((raw, index) => {
    const path = `tools[${index}]`;
    const tool = object(raw, path);
    if (tool.type != null && tool.type !== "custom") {
      fail(
        path,
        `server/hosted tool ${String(tool.type)} is unsupported; use a client tool with input_schema`,
      );
    }
    keys(
      tool,
      [
        "type",
        "name",
        "description",
        "input_schema",
        "cache_control",
        "strict",
        "defer_loading",
        "allowed_callers",
        "input_examples",
        "namespace",
      ],
      path,
    );
    toolOptions(tool, path);
    cacheControl(tool.cache_control, `${path}.cache_control`);
    emptyArray(
      tool.input_examples,
      `${path}.input_examples`,
      "tool input examples cannot be mapped; put examples in description",
    );
    const name = identifier(tool.name, `${path}.name`);
    uniqueTool(name, names, path);
    const result: JsonObject = {
      type: "function",
      name,
      parameters: object(tool.input_schema, `${path}.input_schema`),
      // Responses otherwise normalizes schemas into strict mode.
      strict:
        tool.strict == null ? false : boolean(tool.strict, `${path}.strict`),
    };
    if (tool.description != null)
      result.description = string(tool.description, `${path}.description`);
    return result;
  });
  return { tools, names };
}

// Responses attempts strict schema normalization when strict is omitted. Normalize
// the portable subset without changing the caller's schema; incompatible schemas
// retain their original constraints in explicit best-effort mode, as Responses does.
function defaultStrictSchema(schema: JsonObject): JsonObject | undefined {
  const allowed = new Set([
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "anyOf",
    "$defs",
    "definitions",
    "$ref",
    "description",
    "title",
    "enum",
    "const",
    "minLength",
    "maxLength",
    "pattern",
    "format",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minItems",
    "maxItems",
  ]);
  if (
    !Object.keys(schema).length ||
    Object.keys(schema).some((key) => !allowed.has(key))
  )
    return undefined;
  const result: JsonObject = { ...schema };
  for (const key of ["properties", "$defs", "definitions"]) {
    if (schema[key] == null) continue;
    const children = object(schema[key], `tools.parameters.${key}`);
    const entries: [string, JsonObject][] = [];
    for (const [name, child] of Object.entries(children)) {
      const normalized = defaultStrictSchema(
        object(child, `tools.parameters.${key}.${name}`),
      );
      if (!normalized) return undefined;
      entries.push([name, normalized]);
    }
    result[key] = Object.fromEntries(entries);
  }
  if (schema.items != null) {
    if (Array.isArray(schema.items) || typeof schema.items !== "object")
      return undefined;
    const normalized = defaultStrictSchema(
      object(schema.items, "tools.parameters.items"),
    );
    if (!normalized) return undefined;
    result.items = normalized;
  }
  if (schema.anyOf != null) {
    const choices: JsonObject[] = [];
    for (const raw of array(schema.anyOf, "tools.parameters.anyOf")) {
      const normalized = defaultStrictSchema(
        object(raw, "tools.parameters.anyOf"),
      );
      if (!normalized) return undefined;
      choices.push(normalized);
    }
    result.anyOf = choices;
  }
  if (
    schema.type === "object" ||
    (Array.isArray(schema.type) && schema.type.includes("object")) ||
    schema.properties != null
  ) {
    if (
      schema.additionalProperties != null &&
      typeof schema.additionalProperties !== "boolean"
    )
      return undefined;
    result.properties ??= {};
    result.required = Object.keys(result.properties);
    result.additionalProperties = false;
  }
  return result;
}

function responsesTools(value: unknown): {
  tools: JsonObject[];
  names: Set<string>;
  customTools: Set<string>;
} {
  const names = new Set<string>();
  const customTools = new Set<string>();
  const tools = array(value ?? [], "tools").map((raw, index) => {
    const path = `tools[${index}]`;
    const tool = object(raw, path);
    if (tool.type !== "function" && tool.type !== "custom") {
      fail(
        path,
        `hosted/server/namespaced tool ${String(tool.type)} is unsupported; use flat function or custom client tools`,
      );
    }
    keys(
      tool,
      [
        "type",
        "name",
        "description",
        "parameters",
        "strict",
        "format",
        "defer_loading",
        "allowed_callers",
        "namespace",
      ],
      path,
    );
    toolOptions(tool, path);
    const name = identifier(tool.name, `${path}.name`);
    uniqueTool(name, names, path);
    const result: JsonObject = { name };
    if (tool.description != null)
      result.description = string(tool.description, `${path}.description`);
    if (tool.type === "function") {
      absent(
        tool.format,
        `${path}.format`,
        "format belongs to custom tools, not function tools",
      );
      result.input_schema =
        tool.parameters == null
          ? { type: "object", properties: {} }
          : object(tool.parameters, `${path}.parameters`);
      if (tool.strict != null)
        result.strict = boolean(tool.strict, `${path}.strict`);
      else {
        const normalized = defaultStrictSchema(result.input_schema);
        result.strict = normalized != null;
        if (normalized) result.input_schema = normalized;
      }
    } else {
      absent(
        tool.parameters,
        `${path}.parameters`,
        "custom tools use a freeform string, not parameters",
      );
      absent(tool.strict, `${path}.strict`, "strict belongs to function tools");
      customTools.add(name);
      const input: JsonObject = { type: "string" };
      if (tool.format != null) {
        const format = object(tool.format, `${path}.format`);
        keys(format, ["type", "syntax", "definition"], `${path}.format`);
        if (format.type === "grammar") {
          if (format.syntax !== "lark" && format.syntax !== "regex")
            fail(path, "custom grammar syntax must be lark or regex");
          const grammar = identifier(
            format.definition,
            `${path}.format.definition`,
          );
          // Anthropic has no grammar decoder. Preserve the constraint as an instruction,
          // including Codex's apply_patch grammar, rather than losing it or JSON-encoding input.
          input.description = `Return raw tool input conforming to this ${format.syntax} grammar:\n${grammar}`;
        } else if (format.type !== "text") {
          fail(path, "custom tool format must be text or grammar");
        } else {
          keys(format, ["type"], `${path}.format`);
        }
      }
      result.input_schema = {
        type: "object",
        properties: { input },
        required: ["input"],
        additionalProperties: false,
      };
    }
    return result;
  });
  return { tools, names, customTools };
}

function sampling(
  body: JsonObject,
  request: JsonObject,
  source: "anthropic" | "responses",
): void {
  for (const key of ["temperature", "top_p"]) {
    if (body[key] == null) continue;
    const value: unknown = body[key];
    // Both destinations accept [0, 1]; do not silently clamp Responses temperature > 1.
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1
    ) {
      fail(key, "cross-provider sampling requires a number between 0 and 1");
    }
    request[key] = value;
  }
  if (body.stream != null) request.stream = boolean(body.stream, "stream");
  const sourceKey = source === "anthropic" ? "max_tokens" : "max_output_tokens";
  const targetKey = source === "anthropic" ? "max_output_tokens" : "max_tokens";
  request[targetKey] =
    body[sourceKey] == null
      ? DEFAULT_MAX_TOKENS
      : integer(body[sourceKey], sourceKey, 1);
}

function anthropicRequestOptions(body: JsonObject): void {
  keys(
    body,
    [
      "model",
      "messages",
      "system",
      "max_tokens",
      "stream",
      "temperature",
      "top_p",
      "top_k",
      "tools",
      "tool_choice",
      "stop_sequences",
      "thinking",
      "metadata",
      "cache_control",
      "output_config",
      "output_format",
      "service_tier",
      "context_management",
      "container",
      "mcp_servers",
      "inference_geo",
      "diagnostics",
    ],
    "request",
  );
  absent(body.top_k, "top_k", "Responses has no top_k equivalent; remove it");
  emptyArray(
    body.stop_sequences,
    "stop_sequences",
    "Responses cannot enforce stop sequences; remove them",
  );
  absent(
    body.output_format,
    "output_format",
    "structured output constraints are unsupported; request plain text",
  );
  absent(
    body.container,
    "container",
    "stateful containers are unsupported; supply full history",
  );
  emptyArray(
    body.mcp_servers,
    "mcp_servers",
    "server MCP tools are unsupported; use client tools",
  );
  absent(
    body.inference_geo,
    "inference_geo",
    "cross-provider inference geography cannot be guaranteed",
  );
  if (body.service_tier != null && body.service_tier !== "auto")
    fail("service_tier", "only auto is supported across providers");
  cacheControl(body.cache_control, "cache_control");
  if (body.output_config != null) {
    const config = object(body.output_config, "output_config");
    keys(config, ["effort", "format"], "output_config");
    absent(
      config.format,
      "output_config.format",
      "structured output constraints are unsupported; request plain text",
    );
    // Thinking/effort options are intentionally not forwarded to OpenAI.
  }
  if (body.context_management != null) {
    const context = object(body.context_management, "context_management");
    keys(context, ["edits"], "context_management");
    for (const raw of array(context.edits ?? [], "context_management.edits")) {
      const edit = object(raw, "context_management.edits");
      if (edit.type !== "clear_thinking_20251015")
        fail(
          "context_management",
          "compaction/tool-history edits are unsupported; send unmodified full history",
        );
    }
  }
}

function responsesRequestOptions(body: JsonObject): void {
  keys(
    body,
    [
      "model",
      "input",
      "instructions",
      "max_output_tokens",
      "stream",
      "stream_options",
      "temperature",
      "top_p",
      "tools",
      "tool_choice",
      "parallel_tool_calls",
      "reasoning",
      "text",
      "metadata",
      "store",
      "background",
      "previous_response_id",
      "conversation",
      "prompt",
      "include",
      "truncation",
      "context_management",
      "max_tool_calls",
      "service_tier",
      "prompt_cache_key",
      "client_metadata",
      "prompt_cache_retention",
      "safety_identifier",
      "user",
      "top_logprobs",
    ],
    "request",
  );
  for (const key of ["previous_response_id", "conversation", "prompt"]) {
    absent(
      body[key],
      key,
      "this relay is stateless; send the full input history and inline instructions instead",
    );
  }
  for (const key of ["store", "background"]) {
    if (body[key] != null && boolean(body[key], key))
      fail(key, "stateful/background responses are unsupported; set false");
  }
  if (body.truncation != null && body.truncation !== "disabled")
    fail(
      "truncation",
      "automatic truncation is unsupported; send a history that fits and use disabled",
    );
  emptyArray(
    body.context_management,
    "context_management",
    "opaque compaction is unsupported; send the full uncompressed history",
  );
  absent(
    body.max_tool_calls,
    "max_tool_calls",
    "server tool-call limits are unsupported; use client tools",
  );
  if (
    body.service_tier != null &&
    !["auto", "default"].includes(body.service_tier)
  )
    fail("service_tier", "only auto/default is supported across providers");
  if (body.top_logprobs != null && body.top_logprobs !== 0)
    fail(
      "top_logprobs",
      "Anthropic cannot return log probabilities; remove it",
    );
  if (body.text != null) {
    const text = object(body.text, "text");
    keys(text, ["format", "verbosity"], "text");
    if (text.format != null) {
      const format = object(text.format, "text.format");
      if (format.type !== "text")
        fail(
          "text.format",
          "structured output constraints are unsupported; request plain text",
        );
      keys(format, ["type"], "text.format");
    }
    if (
      text.verbosity != null &&
      !["low", "medium", "high"].includes(text.verbosity)
    )
      fail("text.verbosity", "expected low, medium, or high");
    // Verbosity becomes a soft system instruction; reasoning and routing hints are omitted.
  }
  for (const include of array(body.include ?? [], "include")) {
    if (include !== "reasoning.encrypted_content")
      fail(
        "include",
        `unsupported expansion ${String(include)}; only omitted reasoning data is accepted`,
      );
  }
  if (body.stream_options != null) {
    const options = object(body.stream_options, "stream_options");
    keys(options, ["include_usage", "include_obfuscation"], "stream_options");
    for (const [key, value] of Object.entries(options))
      boolean(value, `stream_options.${key}`);
  }
}

/** Translate a stateless Anthropic Messages request into a Responses request. */
export function anthropicToResponses(
  body: JsonObject,
  targetModel: string,
): JsonObject {
  object(body, "request");
  anthropicRequestOptions(body);
  const request: JsonObject = { model: targetModel, input: [], store: false };
  sampling(body, request, "anthropic");
  const input: JsonObject[] = request.input;
  if (body.system != null) {
    const blocks =
      typeof body.system === "string"
        ? [{ type: "text", text: body.system }]
        : array(body.system, "system");
    const content = blocks.map((raw, i) => {
      const block = object(raw, `system[${i}]`);
      if (block.type !== "text")
        fail(
          `system[${i}]`,
          "system content must be plain text; remove opaque/unsupported blocks",
        );
      return anthropicText(block, `system[${i}]`);
    });
    if (content.length)
      input.push({ type: "message", role: "system", content });
  }
  const messages = array(body.messages, "messages");
  if (!messages.length)
    fail("messages", "supply at least one conversation message");
  for (const [index, raw] of messages.entries()) {
    const path = `messages[${index}]`;
    const message = object(raw, path);
    keys(message, ["role", "content"], path);
    if (!["user", "assistant", "system"].includes(message.role))
      fail(path, "role must be user, assistant, or system");
    const blocks =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : array(message.content, `${path}.content`);
    let pending: JsonObject[] = [];
    const flush = () => {
      if (pending.length)
        input.push({ type: "message", role: message.role, content: pending });
      pending = [];
    };
    for (const [i, rawBlock] of blocks.entries()) {
      const p = `${path}.content[${i}]`;
      const block = object(rawBlock, p);
      if (block.type === "thinking" || block.type === "redacted_thinking")
        continue;
      if (block.type === "text") {
        const text = anthropicText(block, p);
        pending.push({
          ...text,
          type: message.role === "assistant" ? "output_text" : "input_text",
        });
      } else if (block.type === "image" && message.role === "user") {
        pending.push(anthropicImage(block, p));
      } else if (block.type === "tool_use" && message.role === "assistant") {
        flush();
        keys(
          block,
          [
            "type",
            "id",
            "name",
            "input",
            "cache_control",
            "caller",
            "namespace",
          ],
          p,
        );
        noNamespace(block, p);
        cacheControl(block.cache_control, `${p}.cache_control`);
        if (
          block.caller != null &&
          object(block.caller, `${p}.caller`).type !== "direct"
        )
          fail(p, "server tool callers are unsupported");
        input.push({
          type: "function_call",
          call_id: identifier(block.id, `${p}.id`),
          name: identifier(block.name, `${p}.name`),
          arguments: JSON.stringify(object(block.input, `${p}.input`)),
        });
      } else if (block.type === "tool_result" && message.role === "user") {
        flush();
        keys(
          block,
          ["type", "tool_use_id", "content", "is_error", "cache_control"],
          p,
        );
        cacheControl(block.cache_control, `${p}.cache_control`);
        const isError =
          block.is_error == null
            ? false
            : boolean(block.is_error, `${p}.is_error`);
        let output: string | JsonObject[];
        if (block.content == null || typeof block.content === "string") {
          output = `${isError ? "Tool error: " : ""}${block.content ?? ""}`;
        } else {
          output = array(block.content, `${p}.content`).map((part, j) => {
            const q = `${p}.content[${j}]`;
            const content = object(part, q);
            if (content.type === "text") return anthropicText(content, q);
            if (content.type === "image") return anthropicImage(content, q);
            return fail(
              q,
              "tool results support only text and images; remove server/opaque content",
            );
          });
          // Responses has no is_error flag: preserve its meaning as visible tool output.
          if (isError)
            output.unshift({ type: "input_text", text: "Tool error:" });
        }
        input.push({
          type: "function_call_output",
          call_id: identifier(block.tool_use_id, `${p}.tool_use_id`),
          output,
        });
      } else {
        fail(
          p,
          `unsupported ${message.role} content type ${String(block.type)}; use text, user images, or client tool calls/results`,
        );
      }
    }
    flush();
  }
  if (!input.some((item) => item.role !== "system"))
    fail(
      "messages",
      "no translatable conversation content remains after omitting thinking",
    );
  const { tools, names } = anthropicTools(body.tools);
  if (body.tools != null) request.tools = tools;
  if (body.tool_choice != null) {
    const choice = object(body.tool_choice, "tool_choice");
    keys(choice, ["type", "name", "disable_parallel_tool_use"], "tool_choice");
    if (choice.type === "tool") {
      if (!names.has(choice.name))
        fail("tool_choice.name", "must name a declared client tool");
      request.tool_choice = { type: "function", name: choice.name };
    } else if (["auto", "any", "none"].includes(choice.type)) {
      absent(
        choice.name,
        "tool_choice.name",
        "name is only valid for a forced tool",
      );
      if (choice.type === "any" && !tools.length)
        fail("tool_choice", "any requires at least one client tool");
      request.tool_choice = choice.type === "any" ? "required" : choice.type;
    } else fail("tool_choice", "use auto, any, none, or tool");
    if (choice.disable_parallel_tool_use != null)
      request.parallel_tool_calls = !boolean(
        choice.disable_parallel_tool_use,
        "tool_choice.disable_parallel_tool_use",
      );
  }
  return request;
}

/** Translate Responses history, returning the custom-tool names needed for output. */
export function responsesToAnthropic(
  body: JsonObject,
  targetModel: string,
): { request: JsonObject; customTools: Set<string> } {
  object(body, "request");
  responsesRequestOptions(body);
  const { tools, names, customTools } = responsesTools(body.tools);
  const request: JsonObject = { model: targetModel, messages: [] };
  sampling(body, request, "responses");
  if (body.tools != null) request.tools = tools;
  const messages: JsonObject[] = request.messages;
  const system: JsonObject[] = [];
  if (body.instructions != null)
    system.push({
      type: "text",
      text: string(body.instructions, "instructions"),
    });
  const append = (role: string, content: JsonObject[]) => {
    if (!content.length) return;
    const last = messages.at(-1);
    if (last?.role === role) last.content.push(...content);
    else messages.push({ role, content });
  };
  const items =
    typeof body.input === "string"
      ? [{ role: "user", content: body.input }]
      : array(body.input, "input");
  const callKinds = new Map<string, string>();
  const nameKinds = new Map<string, boolean>(
    [...names].map((name) => [name, customTools.has(name)]),
  );
  for (const [i, raw] of items.entries()) {
    const path = `input[${i}]`;
    const item = object(raw, path);
    completed(item, path);
    if (item.type === "reasoning") continue;
    if (item.type === "message" || (item.type == null && item.role != null)) {
      keys(item, ["type", "id", "role", "content", "status", "phase"], path);
      if (
        item.phase != null &&
        !["commentary", "final_answer"].includes(item.phase)
      )
        fail(path, "unsupported message phase");
      if (!["system", "developer", "user", "assistant"].includes(item.role))
        fail(
          path,
          "unsupported message role; use system, developer, user, or assistant",
        );
      const content = responsesContent(
        item.content,
        `${path}.content`,
        item.role === "user",
      );
      if (item.role === "system" || item.role === "developer") {
        if (messages.length)
          fail(
            path,
            "late system/developer instructions cannot be safely hoisted; place them before conversation messages",
          );
        system.push(...content);
      } else append(item.role, content);
    } else if (
      item.type === "function_call" ||
      item.type === "custom_tool_call"
    ) {
      keys(
        item,
        [
          "type",
          "id",
          "call_id",
          "name",
          "arguments",
          "input",
          "status",
          "namespace",
        ],
        path,
      );
      noNamespace(item, path);
      const name = identifier(item.name, `${path}.name`);
      const custom = item.type === "custom_tool_call";
      if (nameKinds.has(name) && nameKinds.get(name) !== custom)
        fail(
          path,
          `tool ${name} call kind does not match its definition or history`,
        );
      nameKinds.set(name, custom);
      const callId = identifier(item.call_id, `${path}.call_id`);
      if (callKinds.has(callId))
        fail(path, "duplicate tool call_id; supply each call once");
      callKinds.set(callId, item.type);
      let input: JsonObject;
      if (custom) {
        absent(
          item.arguments,
          `${path}.arguments`,
          "custom calls use input, not arguments",
        );
        customTools.add(name);
        input = { input: string(item.input, `${path}.input`) };
      } else {
        absent(
          item.input,
          `${path}.input`,
          "function calls use arguments, not input",
        );
        input = parseArguments(item.arguments, `${path}.arguments`);
      }
      append("assistant", [{ type: "tool_use", id: callId, name, input }]);
    } else if (
      item.type === "function_call_output" ||
      item.type === "custom_tool_call_output"
    ) {
      keys(item, ["type", "id", "call_id", "output", "status"], path);
      const callId = identifier(item.call_id, `${path}.call_id`);
      const kind = callKinds.get(callId);
      if (!kind)
        fail(
          path,
          "tool output has no matching call in input; this relay requires full stateless history",
        );
      if (`${kind}_output` !== item.type)
        fail(path, "tool output type must match its function/custom call");
      const content =
        typeof item.output === "string"
          ? item.output
          : responsesContent(item.output, `${path}.output`, true);
      append("user", [{ type: "tool_result", tool_use_id: callId, content }]);
    } else {
      fail(
        path,
        `unsupported input type ${String(item.type)}; hosted tools, item references, and opaque compaction require the original provider; send full client-tool history`,
      );
    }
  }
  if (!messages.length)
    fail(
      "input",
      "supply at least one user/assistant message or client tool item",
    );
  validateToolResults(messages);
  if (body.text?.verbosity != null)
    system.push({
      type: "text",
      text: `Respond with ${body.text.verbosity} verbosity.`,
    });
  if (system.length) request.system = system;
  if (body.tool_choice != null || body.parallel_tool_calls != null) {
    const choice = body.tool_choice ?? "auto";
    let mapped: JsonObject;
    if (typeof choice === "string") {
      if (!["auto", "none", "required"].includes(choice))
        fail("tool_choice", "use auto, none, required, or a named client tool");
      if (choice === "required" && !tools.length)
        fail("tool_choice", "required needs at least one client tool");
      mapped = { type: choice === "required" ? "any" : choice };
    } else {
      const selected = object(choice, "tool_choice");
      keys(selected, ["type", "name"], "tool_choice");
      if (!["function", "custom"].includes(selected.type))
        fail(
          "tool_choice",
          "hosted/namespaced/allowed-tools choices are unsupported; select a flat client tool",
        );
      if (!names.has(selected.name))
        fail("tool_choice.name", "must name a declared client tool");
      if (customTools.has(selected.name) !== (selected.type === "custom"))
        fail("tool_choice", "choice type must match the tool definition");
      mapped = { type: "tool", name: selected.name };
    }
    if (body.parallel_tool_calls != null) {
      const parallel = boolean(body.parallel_tool_calls, "parallel_tool_calls");
      if (mapped.type !== "none") mapped.disable_parallel_tool_use = !parallel;
    }
    request.tool_choice = mapped;
  }
  return { request, customTools };
}

function validateToolResults(messages: JsonObject[]): void {
  const seenResults = new Set<string>();
  for (const [i, message] of messages.entries()) {
    if (message.role !== "user") continue;
    let sawText = false;
    const previous = messages[i - 1];
    const calls = new Set<string>(
      previous?.role === "assistant"
        ? (previous.content as JsonObject[])
            .filter((block) => block.type === "tool_use")
            .map((block) => block.id as string)
        : [],
    );
    for (const block of message.content as JsonObject[]) {
      if (block.type !== "tool_result") {
        sawText = true;
        continue;
      }
      if (sawText)
        fail(
          "input",
          "Anthropic requires tool outputs before user text/images in a turn; reorder the source history explicitly",
        );
      if (!calls.has(block.tool_use_id) || seenResults.has(block.tool_use_id))
        fail(
          "input",
          "tool outputs must appear exactly once, immediately after their assistant tool calls",
        );
      seenResults.add(block.tool_use_id);
    }
    if ([...calls].some((id) => !seenResults.has(id)))
      fail(
        "input",
        "supply outputs for all parallel tool calls before continuing the conversation",
      );
  }
}

function outputReasoning(value: unknown, key: string, output: number): number {
  const details =
    value == null ? {} : object(value, "usage.output_tokens_details", 502);
  const reasoning = integer(
    details[key] ?? 0,
    `usage.output_tokens_details.${key}`,
    0,
    502,
  );
  if (reasoning > output)
    fail(
      "usage.output_tokens_details",
      "reasoning tokens exceed output tokens",
      502,
    );
  return reasoning;
}

function responsesUsage(value: unknown): JsonObject {
  const usage = object(value, "usage", 502);
  const input = integer(usage.input_tokens, "usage.input_tokens", 0, 502);
  const output = integer(usage.output_tokens, "usage.output_tokens", 0, 502);
  const details =
    usage.input_tokens_details == null
      ? {}
      : object(usage.input_tokens_details, "usage.input_tokens_details", 502);
  const cached = integer(
    details.cached_tokens ?? 0,
    "usage.input_tokens_details.cached_tokens",
    0,
    502,
  );
  const written = integer(
    details.cache_write_tokens ?? 0,
    "usage.input_tokens_details.cache_write_tokens",
    0,
    502,
  );
  if (cached + written > input)
    fail(
      "usage",
      "cached and cache-write tokens exceed total input tokens",
      502,
    );
  if (
    usage.total_tokens != null &&
    integer(usage.total_tokens, "usage.total_tokens", 0, 502) !== input + output
  )
    fail(
      "usage.total_tokens",
      "does not equal input_tokens + output_tokens",
      502,
    );
  integer(input + output, "usage total tokens", 0, 502);
  const reasoning = outputReasoning(
    usage.output_tokens_details,
    "reasoning_tokens",
    output,
  );
  const result: JsonObject = {
    input_tokens: input - cached - written,
    output_tokens: output,
    cache_creation_input_tokens: written,
    cache_read_input_tokens: cached,
  };
  if (usage.output_tokens_details != null)
    result.output_tokens_details = { thinking_tokens: reasoning };
  return result;
}

function anthropicUsage(value: unknown): JsonObject {
  const usage = object(value, "usage", 502);
  const uncached = integer(usage.input_tokens, "usage.input_tokens", 0, 502);
  const cached = integer(
    usage.cache_read_input_tokens ?? 0,
    "usage.cache_read_input_tokens",
    0,
    502,
  );
  const written = integer(
    usage.cache_creation_input_tokens ?? 0,
    "usage.cache_creation_input_tokens",
    0,
    502,
  );
  const output = integer(usage.output_tokens, "usage.output_tokens", 0, 502);
  const input = integer(
    uncached + cached + written,
    "usage total input tokens",
    0,
    502,
  );
  const total = integer(input + output, "usage total tokens", 0, 502);
  const inputDetails: JsonObject = { cached_tokens: cached };
  if (written) inputDetails.cache_write_tokens = written;
  const reasoning = outputReasoning(
    usage.output_tokens_details,
    "thinking_tokens",
    output,
  );
  if (usage.server_tool_use != null) {
    const server = object(usage.server_tool_use, "usage.server_tool_use", 502);
    if (Object.values(server).some((count) => count != null && count !== 0))
      fail(
        "usage.server_tool_use",
        "server tool usage is unsupported across providers; use client tools",
      );
  }
  return {
    input_tokens: input,
    input_tokens_details: inputDetails,
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: reasoning },
    total_tokens: total,
  };
}

/** Translate a finished Responses result. Only a known token-limit incomplete result is portable. */
export function responsesToAnthropicResponse(
  body: JsonObject,
  model: string,
): JsonObject {
  object(body, "response", 502);
  if (body.error != null)
    fail("response.error", "upstream Responses request failed", 502);
  const limited =
    body.status === "incomplete" &&
    body.incomplete_details?.reason === "max_output_tokens";
  if (body.status !== "completed" && !limited)
    fail(
      "response.status",
      `cannot translate ${String(body.status)}; expected completed or a max_output_tokens stop`,
      502,
    );
  if (body.status === "completed" && body.incomplete_details != null)
    fail(
      "response.incomplete_details",
      "completed response contains incomplete details",
      502,
    );
  if (body.object != null && body.object !== "response")
    fail("response.object", "expected a Responses response", 502);
  const content: JsonObject[] = [];
  let refusal = false;
  for (const [i, raw] of array(body.output, "output", 502).entries()) {
    const path = `output[${i}]`;
    const item = object(raw, path, 502);
    if (item.error != null)
      fail(`${path}.error`, "provider returned an item error", 502);
    if (!(
      limited &&
      ["message", "reasoning"].includes(item.type) &&
      item.status === "incomplete"
    ))
      completed(item, path, 502);
    if (item.type === "reasoning") continue;
    if (item.type === "message") {
      if (item.role !== "assistant")
        fail(path, "provider output message must have assistant role", 502);
      const blocks = array(item.content, `${path}.content`, 502);
      for (const rawBlock of blocks) {
        const block = object(rawBlock, `${path}.content`, 502);
        if (block.type !== "output_text" && block.type !== "refusal")
          fail(
            path,
            `unsupported output content ${String(block.type)}; only text/refusal is portable`,
          );
        if (block.type === "refusal") refusal = true;
      }
      content.push(...responsesContent(blocks, `${path}.content`, false, 502));
    } else if (
      item.type === "function_call" ||
      item.type === "custom_tool_call"
    ) {
      noNamespace(item, path);
      content.push({
        type: "tool_use",
        id: identifier(item.call_id, `${path}.call_id`, 502),
        name: identifier(item.name, `${path}.name`, 502),
        input:
          item.type === "custom_tool_call"
            ? { input: string(item.input, `${path}.input`, 502) }
            : parseArguments(item.arguments, `${path}.arguments`, 502),
      });
    } else {
      fail(
        path,
        `unsupported output type ${String(item.type)}; hosted/server tools and opaque compaction cannot cross providers`,
      );
    }
  }
  return {
    id: identifier(body.id, "response.id", 502),
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: limited
      ? "max_tokens"
      : content.some((block) => block.type === "tool_use")
        ? "tool_use"
        : refusal
          ? "refusal"
          : "end_turn",
    stop_sequence: null,
    usage: responsesUsage(body.usage),
  };
}

/** Translate an Anthropic result; custom tool input stays raw text, never JSON arguments. */
export function anthropicToResponsesResponse(
  body: JsonObject,
  model: string,
  customTools: Set<string>,
): JsonObject {
  object(body, "response", 502);
  completed(body, "response", 502);
  absent(
    body.container,
    "response.container",
    "stateful provider containers cannot cross providers",
  );
  if (body.type !== "message" || body.role !== "assistant")
    fail("response", "expected an Anthropic assistant message", 502);
  const limited =
    body.stop_reason === "max_tokens" ||
    body.stop_reason === "model_context_window_exceeded";
  if (
    !["end_turn", "tool_use", "stop_sequence", "refusal"].includes(
      body.stop_reason,
    ) &&
    !limited
  ) {
    fail(
      "response.stop_reason",
      `cannot translate ${String(body.stop_reason)}; expected a finished turn (pause_turn requires provider state)`,
      502,
    );
  }
  const output: JsonObject[] = [];
  let pending: JsonObject[] = [];
  const flush = () => {
    if (pending.length)
      output.push({
        type: "message",
        id: `msg_${randomUUID()}`,
        role: "assistant",
        status: limited ? "incomplete" : "completed",
        content: pending,
      });
    pending = [];
  };
  for (const [i, raw] of array(body.content, "content", 502).entries()) {
    const path = `content[${i}]`;
    const block = object(raw, path, 502);
    if (block.type === "thinking" || block.type === "redacted_thinking")
      continue;
    if (block.type === "text") {
      const text = anthropicText(block, path, 502).text;
      pending.push(
        body.stop_reason === "refusal"
          ? { type: "refusal", refusal: text }
          : { type: "output_text", text, annotations: [], logprobs: [] },
      );
    } else if (block.type === "tool_use") {
      flush();
      noNamespace(block, path);
      if (
        block.caller != null &&
        object(block.caller, `${path}.caller`, 502).type !== "direct"
      )
        fail(path, "server tool callers cannot cross providers");
      const name = identifier(block.name, `${path}.name`, 502);
      const callId = identifier(block.id, `${path}.id`, 502);
      const input = object(block.input, `${path}.input`, 502);
      if (customTools.has(name)) {
        if (Object.keys(input).length !== 1 || !Object.hasOwn(input, "input"))
          fail(
            path,
            "custom tool input must contain exactly one string property named input",
            502,
          );
        output.push({
          type: "custom_tool_call",
          id: `ctc_${randomUUID()}`,
          call_id: callId,
          name,
          input: string(input.input, `${path}.input.input`, 502),
          status: "completed",
        });
      } else {
        output.push({
          type: "function_call",
          id: `fc_${randomUUID()}`,
          call_id: callId,
          name,
          arguments: JSON.stringify(input),
          status: "completed",
        });
      }
    } else {
      fail(
        path,
        `unsupported output content ${String(block.type)}; hosted/server tools and opaque compaction cannot cross providers`,
      );
    }
  }
  flush();
  if (
    body.stop_reason === "tool_use" &&
    !output.some(
      (item) =>
        item.type === "function_call" || item.type === "custom_tool_call",
    )
  )
    fail("response.stop_reason", "tool_use stop has no client tool calls", 502);
  const text = output
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content as JsonObject[])
    .filter((block) => block.type === "output_text")
    .map((block) => block.text)
    .join("");
  return {
    id: identifier(body.id, "response.id", 502),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: limited ? "incomplete" : "completed",
    error: null,
    incomplete_details: limited ? { reason: "max_output_tokens" } : null,
    model,
    output,
    output_text: text,
    usage: anthropicUsage(body.usage),
  };
}
