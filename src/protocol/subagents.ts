import { HttpError, type JsonObject } from "../types.js";
import type { SSEEvent } from "./sse.js";

function isSpawn(item: JsonObject): boolean {
  return (
    item.type === "function_call" &&
    item.name === "spawn_agent" &&
    (item.namespace == null || item.namespace === "multi_agent_v1")
  );
}
export function routeSpawn(item: JsonObject, model: string): JsonObject {
  if (!isSpawn(item)) return item;
  let args: JsonObject;
  try {
    args = JSON.parse(item.arguments);
  } catch {
    throw new HttpError(502, "Codex spawn_agent arguments are not valid JSON");
  }
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw new HttpError(502, "Codex spawn_agent arguments must be an object");
  return { ...item, arguments: JSON.stringify({ ...args, model }) };
}
export function routeCodexResponse(
  body: JsonObject,
  model: string,
): JsonObject {
  if (!Array.isArray(body.output)) return body;
  return {
    ...body,
    output: body.output.map((item: JsonObject) => routeSpawn(item, model)),
  };
}

/** Codex v1 agents expose model overrides, not role selectors. Force only the
 * built-in spawn_agent's model argument, leaving the main model and all other
 * calls untouched. Buffer those arguments to rewrite all SSE representations. */
export async function* routeCodexStream(
  source: AsyncIterable<SSEEvent>,
  model: string,
): AsyncGenerator<SSEEvent> {
  const calls = new Map<
    number,
    { item: JsonObject; arguments: string; sent: boolean }
  >();
  let sequence = 0;
  for await (const event of source) {
    let data = event.data;
    if (
      data.type === "response.output_item.added" &&
      isSpawn(data.item ?? {})
    ) {
      calls.set(data.output_index, {
        item: data.item,
        arguments: data.item.arguments || "",
        sent: false,
      });
      data = { ...data, item: { ...data.item, arguments: "" } };
    }
    const call = calls.get(data.output_index);
    if (call && data.type === "response.function_call_arguments.delta") {
      call.arguments += data.delta;
      continue;
    }
    if (call && data.type === "response.function_call_arguments.done") {
      call.arguments = data.arguments ?? call.arguments;
      continue;
    }
    if (call && data.type === "response.output_item.done") {
      const item = routeSpawn(
        { ...data.item, arguments: data.item.arguments || call.arguments },
        model,
      );
      const common = { output_index: data.output_index, item_id: item.id };
      for (const e of [
        {
          type: "response.function_call_arguments.delta",
          ...common,
          delta: item.arguments,
        },
        {
          type: "response.function_call_arguments.done",
          ...common,
          arguments: item.arguments,
        },
      ])
        yield { event: e.type, data: { ...e, sequence_number: sequence++ } };
      data = { ...data, item };
      call.sent = true;
    }
    if (["response.completed", "response.incomplete"].includes(data.type)) {
      // Completion-only providers are allowed. Standard clients consume the final output too.
      data = { ...data, response: routeCodexResponse(data.response, model) };
    }
    yield {
      event: event.event,
      data: { ...data, sequence_number: sequence++ },
    };
  }
}
