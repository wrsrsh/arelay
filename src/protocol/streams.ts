import { randomUUID } from "node:crypto";
import { HttpError, type JsonObject } from "../types.js";
import {
  anthropicToResponsesResponse,
  responsesToAnthropicResponse,
} from "./mappings.js";
import type { SSEEvent } from "./sse.js";
import { restoreNamespacedTool } from "./namespaces.js";

const event = (type: string, data: JsonObject = {}): SSEEvent => ({
  event: type,
  data: { type, ...data },
});
const upstreamError = () =>
  new HttpError(
    502,
    "Upstream stream failed or ended without a completion event",
  );

/** Text streams live. Tool arguments are emitted atomically when each call finishes,
 * since OpenAI may interleave calls but Anthropic requires sequential blocks. */
export async function* translateResponsesStream(
  source: AsyncIterable<SSEEvent>,
  model: string,
): AsyncGenerator<SSEEvent> {
  let started = false;
  let index = -1;
  let open: string | undefined;
  const text = new Map<string, string>();
  const emittedTools = new Set<number>();
  let finished = false;
  const start = (id?: string) => {
    started = true;
    return event("message_start", {
      message: {
        id: id || `msg_${randomUUID()}`,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  };
  const close = () => {
    open = undefined;
    return event("content_block_stop", { index });
  };
  for await (const { data: ev } of source) {
    if (finished) throw new HttpError(502, "Data after upstream completion");
    if (["error", "response.failed"].includes(ev.type)) throw upstreamError();
    if (!started) yield start(ev.response?.id);
    if (
      ["response.output_text.delta", "response.refusal.delta"].includes(ev.type)
    ) {
      const key = `${ev.output_index}:${ev.content_index ?? 0}`;
      if (typeof ev.delta !== "string") throw upstreamError();
      if (open !== key) {
        if (open !== undefined) yield close();
        if (text.has(key))
          throw new HttpError(
            502,
            "Interleaved text blocks cannot be represented in Anthropic streaming",
          );
        open = key;
        index++;
        yield event("content_block_start", {
          index,
          content_block: { type: "text", text: "" },
        });
      }
      text.set(key, (text.get(key) || "") + ev.delta);
      yield event("content_block_delta", {
        index,
        delta: { type: "text_delta", text: ev.delta },
      });
    }
    if (ev.type === "response.output_item.done") {
      const item = ev.item;
      if (!item || typeof item !== "object") throw upstreamError();
      if (item.type === "function_call" || item.type === "custom_tool_call") {
        const converted = responsesToAnthropicResponse(
          {
            id: "temporary",
            status: "completed",
            output: [item],
            usage: { input_tokens: 0, output_tokens: 0 },
          },
          model,
        );
        if (open !== undefined) yield close();
        index++;
        const block = converted.content[0];
        yield event("content_block_start", {
          index,
          content_block: { ...block, input: {} },
        });
        yield event("content_block_delta", {
          index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(block.input),
          },
        });
        yield event("content_block_stop", { index });
        emittedTools.add(ev.output_index);
      }
    }
    if (ev.type === "response.completed" || ev.type === "response.incomplete") {
      // Validate final status, supported output types, and usage before claiming success.
      const converted = responsesToAnthropicResponse(ev.response, model);
      if (open !== undefined) yield close();
      for (const [outputIndex, item] of (
        ev.response.output as JsonObject[]
      ).entries()) {
        if (item.type === "message") {
          for (const [contentIndex, part] of (
            item.content as JsonObject[]
          ).entries()) {
            const key = `${outputIndex}:${contentIndex}`;
            const full = part.text ?? part.refusal ?? "";
            if (text.has(key)) {
              if (text.get(key) !== full)
                throw new HttpError(
                  502,
                  "Upstream final text did not match streamed text",
                );
              continue;
            }
            index++;
            yield event("content_block_start", {
              index,
              content_block: { type: "text", text: "" },
            });
            yield event("content_block_delta", {
              index,
              delta: { type: "text_delta", text: full },
            });
            yield event("content_block_stop", { index });
          }
        } else if (
          ["function_call", "custom_tool_call"].includes(item.type) &&
          !emittedTools.has(outputIndex)
        ) {
          const block = responsesToAnthropicResponse(
            {
              id: "temporary",
              status: "completed",
              output: [item],
              usage: { input_tokens: 0, output_tokens: 0 },
            },
            model,
          ).content[0];
          index++;
          yield event("content_block_start", {
            index,
            content_block: { ...block, input: {} },
          });
          yield event("content_block_delta", {
            index,
            delta: {
              type: "input_json_delta",
              partial_json: JSON.stringify(block.input),
            },
          });
          yield event("content_block_stop", { index });
        }
      }
      yield event("message_delta", {
        delta: { stop_reason: converted.stop_reason, stop_sequence: null },
        usage: converted.usage,
      });
      yield event("message_stop");
      finished = true;
      return;
    }
  }
  if (!finished) throw upstreamError();
}

/** Responses stream with stable item IDs, completed output, and sequence numbers. */
export async function* translateAnthropicStream(
  source: AsyncIterable<SSEEvent>,
  model: string,
  customTools: Set<string>,
): AsyncGenerator<SSEEvent> {
  let sequence = 0;
  const emit = (type: string, data: JsonObject = {}) =>
    event(type, { ...data, sequence_number: sequence++ });
  const id = `resp_${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let message: JsonObject | undefined;
  const blocks = new Map<
    number,
    {
      block: JsonObject;
      item?: JsonObject;
      outputIndex?: number;
      arguments: string;
      stopped: boolean;
    }
  >();
  const output: JsonObject[] = [];
  const base = (): JsonObject => ({
    id,
    object: "response",
    created_at: created,
    status: "in_progress",
    model,
    output: [],
    error: null,
    incomplete_details: null,
    usage: null,
  });
  let hasStop = false;
  for await (const { data: ev } of source) {
    if (ev.type === "error") throw upstreamError();
    if (ev.type === "ping") continue;
    if (ev.type === "message_start") {
      if (message) throw upstreamError();
      message = { ...ev.message, content: [], usage: { ...ev.message?.usage } };
      yield emit("response.created", { response: base() });
      yield emit("response.in_progress", { response: base() });
      continue;
    }
    if (!message) throw upstreamError();
    if (ev.type === "content_block_start") {
      if (!Number.isInteger(ev.index) || blocks.has(ev.index))
        throw upstreamError();
      const block = structuredClone(ev.content_block);
      const entry: {
        block: JsonObject;
        item?: JsonObject;
        outputIndex?: number;
        arguments: string;
        stopped: boolean;
      } = { block, arguments: "", stopped: false };
      blocks.set(ev.index, entry);
      let item: JsonObject | undefined;
      if (block.type === "text") {
        item = {
          id: `msg_${randomUUID()}`,
          type: "message",
          role: "assistant",
          status: "in_progress",
          content: [],
        };
      } else if (block.type === "tool_use") {
        const custom = customTools.has(block.name);
        item = {
          id: `${custom ? "ctc" : "fc"}_${randomUUID()}`,
          type: custom ? "custom_tool_call" : "function_call",
          call_id: block.id,
          name: block.name,
          status: "in_progress",
          ...(custom ? { input: "" } : { arguments: "" }),
        };
      } else if (!["thinking", "redacted_thinking"].includes(block.type)) {
        throw new HttpError(
          502,
          `Unsupported Anthropic stream content: ${String(block.type)}`,
        );
      }
      if (item) {
        item = restoreNamespacedTool(item, customTools);
        entry.item = item;
        entry.outputIndex = output.length;
        output.push(item);
        yield emit("response.output_item.added", {
          output_index: entry.outputIndex,
          item: structuredClone(item),
        });
        if (item.type === "message") {
          yield emit("response.content_part.added", {
            item_id: item.id,
            output_index: entry.outputIndex,
            content_index: 0,
            part: {
              type: "output_text",
              text: "",
              annotations: [],
              logprobs: [],
            },
          });
          if (block.text)
            yield emit("response.output_text.delta", {
              item_id: item.id,
              output_index: entry.outputIndex,
              content_index: 0,
              delta: block.text,
              logprobs: [],
            });
        }
      }
      continue;
    }
    if (ev.type === "content_block_delta") {
      const entry = blocks.get(ev.index);
      if (!entry || entry.stopped) throw upstreamError();
      const delta = ev.delta;
      const item = entry.item;
      if (delta?.type === "text_delta" && entry.block.type === "text" && item) {
        if (typeof delta.text !== "string") throw upstreamError();
        entry.block.text += delta.text;
        yield emit("response.output_text.delta", {
          item_id: item.id,
          output_index: entry.outputIndex,
          content_index: 0,
          delta: delta.text,
          logprobs: [],
        });
      } else if (
        delta?.type === "input_json_delta" &&
        entry.block.type === "tool_use" &&
        item
      ) {
        if (typeof delta.partial_json !== "string") throw upstreamError();
        entry.arguments += delta.partial_json;
        if (item.type === "function_call")
          yield emit("response.function_call_arguments.delta", {
            item_id: item.id,
            output_index: entry.outputIndex,
            delta: delta.partial_json,
          });
      } else if (!["thinking_delta", "signature_delta"].includes(delta?.type))
        throw upstreamError();
      continue;
    }
    if (ev.type === "content_block_stop") {
      const entry = blocks.get(ev.index);
      if (!entry || entry.stopped) throw upstreamError();
      entry.stopped = true;
      const item = entry.item;
      if (item) {
        item.status = "completed";
        const common = { item_id: item.id, output_index: entry.outputIndex };
        if (item.type === "message") {
          const part = {
            type: "output_text",
            text: entry.block.text,
            annotations: [],
            logprobs: [],
          };
          item.content = [part];
          yield emit("response.output_text.done", {
            ...common,
            content_index: 0,
            text: entry.block.text,
            logprobs: [],
          });
          yield emit("response.content_part.done", {
            ...common,
            content_index: 0,
            part,
          });
        } else {
          try {
            entry.block.input = entry.arguments
              ? JSON.parse(entry.arguments)
              : entry.block.input;
          } catch {
            throw new HttpError(
              502,
              "Upstream tool arguments were not valid JSON",
            );
          }
          const mapped = anthropicToResponsesResponse(
            {
              id: "tmp",
              type: "message",
              role: "assistant",
              content: [entry.block],
              stop_reason: "tool_use",
              usage: { input_tokens: 0, output_tokens: 0 },
            },
            model,
            customTools,
          ).output[0];
          if (item.type === "custom_tool_call") {
            item.input = mapped.input;
            yield emit("response.custom_tool_call_input.delta", {
              ...common,
              delta: item.input,
            });
            yield emit("response.custom_tool_call_input.done", {
              ...common,
              input: item.input,
            });
          } else {
            item.arguments = entry.arguments || mapped.arguments;
            if (!entry.arguments)
              yield emit("response.function_call_arguments.delta", {
                ...common,
                delta: item.arguments,
              });
            yield emit("response.function_call_arguments.done", {
              ...common,
              arguments: item.arguments,
            });
          }
        }
        yield emit("response.output_item.done", {
          output_index: entry.outputIndex,
          item: structuredClone(item),
        });
      }
      continue;
    }
    if (ev.type === "message_delta") {
      if (ev.delta?.stop_reason) {
        message.stop_reason = ev.delta.stop_reason;
        hasStop = true;
      }
      message.stop_sequence = ev.delta?.stop_sequence ?? null;
      Object.assign(message.usage, ev.usage);
      continue;
    }
    if (ev.type === "message_stop") {
      if (!hasStop || [...blocks.values()].some((b) => !b.stopped))
        throw upstreamError();
      message.content = [...blocks.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, b]) => b.block);
      const final = anthropicToResponsesResponse(message, model, customTools);
      for (const item of output)
        if (final.status === "incomplete" && item.type === "message")
          item.status = "incomplete";
      const response = { ...final, id, created_at: created, output };
      yield emit(
        final.status === "incomplete"
          ? "response.incomplete"
          : "response.completed",
        { response },
      );
      return;
    }
    throw new HttpError(
      502,
      `Unsupported Anthropic stream event: ${String(ev.type)}`,
    );
  }
  throw upstreamError();
}
