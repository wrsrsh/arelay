import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import bundled from "../vendor/codex-models.json" with { type: "json" };
import type { Config, JsonObject } from "./types.js";

/** Preserve existing catalog metadata but normalize agent/tool transport so the
 * router can select models deterministically without parsing code-mode programs. */
export async function codexCatalog(
  config: Config,
  current: unknown,
  configPath: string,
): Promise<string> {
  let catalog: JsonObject = structuredClone(bundled);
  if (current !== undefined) {
    if (typeof current !== "string")
      throw new Error("model_catalog_json must be a file path");
    catalog = JSON.parse(
      await readFile(resolve(dirname(configPath), current), "utf8"),
    );
  }
  if (!Array.isArray(catalog.models) || !catalog.models.length)
    throw new Error("Codex catalog must contain a nonempty models array");
  if (
    catalog.models.some(
      (m: JsonObject) => m.slug === config.routes.codexSubagentModel,
    )
  )
    throw new Error(
      "Codex catalog already contains the arelay model alias; restore the prior integration first",
    );
  for (const model of catalog.models as JsonObject[]) {
    model.tool_mode = "direct";
    model.multi_agent_version = "v1";
    model.use_responses_lite = false;
    model.prefer_websockets = false;
  }
  const template =
    catalog.models.find((m: JsonObject) => m.slug === "gpt-5.4") ??
    catalog.models[0];
  const alias: JsonObject = {
    ...structuredClone(template),
    slug: config.routes.codexSubagentModel,
    display_name: "Claude via arelay",
    description:
      "Anthropic Claude subagent routed by arelay. Tools run inside Codex.",
    supported_in_api: true,
    visibility: "list",
    priority: 99,
    context_window: 200000,
    max_context_window: 200000,
    auto_compact_token_limit: 180000,
    default_reasoning_level: "medium",
    supported_reasoning_levels: [
      { effort: "low", description: "Provider default" },
      { effort: "medium", description: "Provider default" },
      { effort: "high", description: "Provider default" },
    ],
    default_reasoning_summary: "none",
    supports_reasoning_summary_parameter: false,
    supports_reasoning_summaries: false,
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: "freeform",
    shell_type: "unified_exec",
    supports_image_detail_original: false,
    supports_search_tool: false,
    experimental_supported_tools: [],
    node_repl_disabled: true,
    node_repl_auto_review_required: false,
    multi_agent_reasoning_effort: null,
    default_service_tier: null,
    service_tiers: [],
    additional_speed_tiers: [],
  };
  catalog.models.push(alias);
  return JSON.stringify(catalog, null, 2) + "\n";
}
