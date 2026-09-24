import { stripVTControlCharacters } from "node:util";
import type { Config } from "../types.js";
import { VERSION } from "../version.js";
import type { Client } from "./types.js";

export function terminalText(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ")
    .trim();
}

export function palette(enabled: boolean) {
  const wrap = (code: number) => (value: string) =>
    enabled ? `\x1b[${code}m${value}\x1b[0m` : value;
  return {
    cyan: wrap(36),
    violet: wrap(35),
    green: wrap(32),
    dim: wrap(2),
    bold: wrap(1),
  };
}

export function banner(width = 80, color = true): string {
  const c = palette(color);
  const logo =
    width < 48
      ? ["  a r e l a y"]
      : [
          "                     __",
          "  ____ ________  / /___ ___  __",
          " / __ `/ ___/ _ \\/ / __ `/ / / /",
          "/ /_/ / /  /  __/ / /_/ / /_/ /",
          "\\__,_/_/   \\___/_/\\__,_/\\__, /",
          "                      /____/",
        ];
  return (
    "\n" +
    logo.map((line, i) => (i < 3 ? c.cyan(line) : c.violet(line))).join("\n") +
    `\n\n  ${c.bold("route your subagents")}${width >= 48 ? c.dim(`  /  v${VERSION}`) : ""}\n` +
    `  ${c.dim("your main model and tools stay in their client.")}\n`
  );
}

export function providerLabel(
  baseUrl: string,
  protocol: "openai" | "anthropic",
): string {
  const host = new URL(baseUrl).hostname;
  if (
    host.endsWith(".openai.azure.com") ||
    host.endsWith(".services.ai.azure.com")
  )
    return "Azure";
  if (host === "api.openai.com") return "OpenAI";
  if (host === "api.anthropic.com") return "Anthropic";
  return protocol === "openai" ? "Responses endpoint" : "Messages endpoint";
}

export function routePreview(
  config: Config,
  clients: Client[],
  startService: boolean,
  color = false,
): string {
  const c = palette(color);
  const route = (
    client: Client,
    title: string,
    protocol: "openai" | "anthropic",
  ) => {
    const backend = config[protocol];
    return clients.includes(client)
      ? `${c.bold(title)}\n  main        unchanged\n  subagents   ${c.cyan(providerLabel(backend.baseUrl, protocol))}\n              ${c.violet(terminalText(backend.model))}`
      : `${c.dim(title)}\n  client settings left as they are`;
  };
  return [
    route("claude", "CLAUDE CODE", "openai"),
    route("codex", "CODEX", "anthropic"),
    `${c.bold("BACKGROUND SERVICE")}\n  127.0.0.1:${config.port}\n  ${startService ? "start now + at login" : "leave the service as it is"}`,
  ].join("\n\n");
}
