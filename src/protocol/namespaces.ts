import { createHash } from "node:crypto";
import { HttpError, type JsonObject } from "../types.js";
import {
  responsesToAnthropic as convertRequest,
  anthropicToResponsesResponse as convertResponse,
} from "./mappings.js";

type Names = Map<string, { namespace: string; name: string }>;
const contexts = new WeakMap<Set<string>, Names>();

/** Flatten Responses namespaces into stable Anthropic tool names, and retain the
 * inverse mapping for replies. Hashes avoid delimiter ambiguity and the 64-char limit. */
export function responsesToAnthropic(
  body: JsonObject,
  model: string,
): { request: JsonObject; customTools: Set<string> } {
  const copy = structuredClone(body);
  const names: Names = new Map();
  const occupied = new Set<string>(
    (Array.isArray(copy.tools) ? copy.tools : [])
      .filter((t: JsonObject) => t.type !== "namespace")
      .map((t: JsonObject) => t.name),
  );
  const nameFor = (namespace: unknown, name: unknown): string => {
    if (
      typeof namespace !== "string" ||
      !namespace ||
      typeof name !== "string" ||
      !name
    )
      throw new HttpError(
        400,
        "Namespaced tools require nonempty namespace and name strings",
      );
    const flat =
      "arelay_ns_" +
      createHash("sha256")
        .update(JSON.stringify([namespace, name]))
        .digest("hex")
        .slice(0, 40);
    if (occupied.has(flat))
      throw new HttpError(
        400,
        "Namespaced tool conflicts with a flat tool name",
      );
    names.set(flat, { namespace, name });
    return flat;
  };
  if (Array.isArray(copy.tools)) {
    copy.tools = copy.tools.flatMap((tool: JsonObject) => {
      if (tool.type !== "namespace") return [tool];
      if (!Array.isArray(tool.tools))
        throw new HttpError(400, "Namespace must contain a tools array");
      return tool.tools.map((child: JsonObject) => {
        if (!["function", "custom"].includes(child.type))
          throw new HttpError(
            400,
            "Namespaces support only client function/custom tools",
          );
        return {
          ...child,
          name: nameFor(tool.name, child.name),
          description: [tool.description, child.description]
            .filter(Boolean)
            .join("\n\n"),
        };
      });
    });
  }
  if (Array.isArray(copy.input)) {
    for (const item of copy.input as JsonObject[]) {
      if (
        item.namespace != null &&
        ["function_call", "custom_tool_call"].includes(item.type)
      ) {
        item.name = nameFor(item.namespace, item.name);
        delete item.namespace;
      }
    }
  }
  if (copy.tool_choice?.namespace != null) {
    copy.tool_choice.name = nameFor(
      copy.tool_choice.namespace,
      copy.tool_choice.name,
    );
    delete copy.tool_choice.namespace;
  }
  const result = convertRequest(copy, model);
  contexts.set(result.customTools, names);
  return result;
}

export function restoreNamespacedTool(
  item: JsonObject,
  customTools: Set<string>,
): JsonObject {
  const original = contexts.get(customTools)?.get(item.name);
  return original ? { ...item, ...original } : item;
}

export function anthropicToResponsesResponse(
  body: JsonObject,
  model: string,
  customTools: Set<string>,
): JsonObject {
  const response = convertResponse(body, model, customTools);
  response.output = response.output.map((item: JsonObject) =>
    restoreNamespacedTool(item, customTools),
  );
  return response;
}
