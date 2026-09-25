import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parse, stringify } from "smol-toml";
import { atomicWrite, paths } from "../config.js";
import type { NativeClient } from "./types.js";
import type { JsonObject } from "../types.js";

export interface ConnectionOptions {
  node: string;
  cli: string;
  home: string;
}
interface Saved {
  version: 1;
  target: string;
  client: NativeClient;
  entryHash: string;
}
const hash = (value: unknown): string =>
  createHash("sha256")
    .update(
      JSON.stringify(value, (_k, v) =>
        v && typeof v === "object" && !Array.isArray(v)
          ? Object.fromEntries(
              Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
            )
          : v,
      ),
    )
    .digest("hex");
async function optional(path: string): Promise<string | undefined> {
  try {
    if (!(await lstat(path)).isFile())
      throw new Error(`Refusing a non-regular configuration file: ${path}`);
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
}
function targetPath(client: NativeClient): string {
  if (client === "claude")
    return process.env.CLAUDE_CONFIG_DIR
      ? join(process.env.CLAUDE_CONFIG_DIR, ".claude.json")
      : join(homedir(), ".claude.json");
  if (client === "codex")
    return join(
      process.env.CODEX_HOME || join(homedir(), ".codex"),
      "config.toml",
    );
  throw new Error("Unknown client");
}
function metaPath(client: NativeClient): string {
  return join(paths().state, `native-${client}.json`);
}
function entry(client: NativeClient, opts: ConnectionOptions): JsonObject {
  for (const path of Object.values(opts))
    if (!isAbsolute(path) || /[\x00-\x1f]/.test(path))
      throw new Error("Connection paths must be absolute");
  return {
    ...(client === "claude" ? { type: "stdio" } : {}),
    command: opts.node,
    args: [opts.cli, "mcp", "--client", client],
    env: { ARELAY_HOME: opts.home },
  };
}
function document(client: NativeClient, text?: string): JsonObject {
  const data =
    text === undefined
      ? {}
      : client === "claude"
        ? JSON.parse(text)
        : parse(text, { integersAsBigInt: true });
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("Client config must be an object");
  const key = client === "claude" ? "mcpServers" : "mcp_servers";
  if (
    data[key] !== undefined &&
    (!data[key] || typeof data[key] !== "object" || Array.isArray(data[key]))
  )
    throw new Error("MCP configuration must be an object");
  return data;
}
const serialize = (client: NativeClient, data: JsonObject) =>
  client === "claude"
    ? JSON.stringify(data, null, 2) + "\n"
    : stringify(data, { numbersAsFloat: true });
async function saved(client: NativeClient): Promise<Saved | undefined> {
  const raw = await optional(metaPath(client));
  if (raw === undefined) return;
  const value = JSON.parse(raw) as Saved;
  if (
    value.version !== 1 ||
    value.client !== client ||
    value.target !== targetPath(client) ||
    !/^[a-f0-9]{64}$/.test(value.entryHash)
  )
    throw new Error(
      "Native connection metadata is invalid or belongs to another config directory",
    );
  return value;
}
async function noApiSetup(client: NativeClient): Promise<void> {
  try {
    await lstat(join(paths().state, `${client}-setup`));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  throw new Error(
    `Restore arelay's API configuration first: arelay unsetup ${client}`,
  );
}
export async function previewNativeClient(
  client: NativeClient,
  opts: ConnectionOptions,
): Promise<{ status: "ready" | "managed" | "blocked"; message: string }> {
  try {
    await noApiSetup(client);
    const wanted = entry(client, opts),
      meta = await saved(client);
    const data = document(client, await optional(targetPath(client)));
    const current =
      data[client === "claude" ? "mcpServers" : "mcp_servers"]?.arelay;
    if (meta) {
      if (hash(current ?? null) !== meta.entryHash)
        throw new Error(
          "The arelay MCP entry changed; preserve your edits before reconnecting",
        );
      return {
        status: "managed",
        message:
          hash(wanted) === meta.entryHash
            ? "Connected"
            : "Connection will be updated to this arelay version",
      };
    }
    if (current !== undefined)
      throw new Error(
        "An unowned MCP server named arelay already exists; it will not be overwritten",
      );
    return { status: "ready", message: "Ready to connect" };
  } catch (e) {
    return {
      status: "blocked",
      message:
        e instanceof SyntaxError || (e as Error).name === "TomlError"
          ? "Client config is not valid JSON/TOML"
          : e instanceof Error
            ? e.message
            : "Unable to read client configuration",
    };
  }
}
async function locked<T>(
  client: NativeClient,
  fn: () => Promise<T>,
): Promise<T> {
  await mkdir(paths().state, { recursive: true, mode: 0o700 });
  const lock = join(paths().state, `native-${client}.lock`);
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch {
    throw new Error(
      "Native setup is already running, or a stale setup lock needs recovery",
    );
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
export async function connectNativeClient(
  client: NativeClient,
  opts: ConnectionOptions,
): Promise<{ changed: boolean }> {
  return locked(client, async () => {
    const preview = await previewNativeClient(client, opts);
    if (preview.status === "blocked") throw new Error(preview.message);
    const target = targetPath(client),
      original = await optional(target),
      oldMeta = await optional(metaPath(client));
    const data = document(client, original),
      wanted = entry(client, opts);
    const key = client === "claude" ? "mcpServers" : "mcp_servers";
    if (
      preview.status === "managed" &&
      hash(data[key]?.arelay) === hash(wanted)
    )
      return { changed: false };
    data[key] ??= {};
    data[key].arelay = wanted;
    const text = serialize(client, data);
    const metadata: Saved = {
      version: 1,
      target,
      client,
      entryHash: hash(wanted),
    };
    if ((await optional(target)) !== original)
      throw new Error("Client settings changed during setup; retry");
    try {
      await atomicWrite(target, text);
      await atomicWrite(metaPath(client), JSON.stringify(metadata) + "\n");
    } catch {
      if ((await optional(target)) !== text)
        throw new Error(
          "Setup failed while client settings changed; preserve your configuration for recovery",
        );
      if (original === undefined) await rm(target, { force: true });
      else await atomicWrite(target, original);
      if (oldMeta === undefined) await rm(metaPath(client), { force: true });
      else await atomicWrite(metaPath(client), oldMeta);
      throw new Error("Native connection failed; previous settings restored");
    }
    return { changed: true };
  });
}
export async function disconnectNativeClient(
  client: NativeClient,
): Promise<void> {
  return locked(client, async () => {
    const meta = await saved(client);
    if (!meta) return;
    const target = targetPath(client),
      original = await optional(target),
      data = document(client, original);
    const key = client === "claude" ? "mcpServers" : "mcp_servers";
    if (hash(data[key]?.arelay ?? null) !== meta.entryHash)
      throw new Error(
        "The arelay MCP entry changed; refusing to remove your edits",
      );
    delete data[key].arelay;
    if (!Object.keys(data[key]).length) delete data[key];
    if ((await optional(target)) !== original)
      throw new Error("Client settings changed during disconnect; retry");
    await atomicWrite(target, serialize(client, data));
    await rm(metaPath(client));
  });
}
