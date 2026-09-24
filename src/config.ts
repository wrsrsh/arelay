import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Config, Paths } from "./types.js";

export function paths(): Paths {
  const dir = resolve(
    process.env.ARELAY_HOME || join(homedir(), ".config", "arelay"),
  );
  return {
    dir,
    config: join(dir, "config.json"),
    credentials: join(dir, "credentials.env"),
    state: join(dir, "state"),
    logs: join(dir, "logs"),
  };
}

export const defaultConfig: Config = {
  version: 1,
  port: 8788,
  openai: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.4",
    apiKeyEnv: "OPENAI_API_KEY",
    authHeader: "authorization",
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-sonnet-4-6",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    authHeader: "x-api-key",
  },
  routes: {
    claudeSubagentModel: "arelay-openai",
    codexSubagentModel: "arelay-claude",
  },
  requestTimeoutMs: 300_000,
  maxBodyBytes: 32 * 1024 * 1024,
};

export function validateConfig(value: unknown): Config {
  if (!value || typeof value !== "object")
    throw new Error("Configuration must be an object");
  const c = value as Config;
  if (c.version !== 1) throw new Error("Unsupported configuration version");
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535)
    throw new Error("port must be 1–65535");
  for (const name of ["openai", "anthropic"] as const) {
    const backend = c[name];
    if (!backend || typeof backend.baseUrl !== "string")
      throw new Error(`${name}.baseUrl is required`);
    const url = new URL(backend.baseUrl);
    if (url.username || url.password || url.search || url.hash)
      throw new Error(
        `${name}.baseUrl must not contain credentials, a query or fragment`,
      );
    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      )
    )
      throw new Error(`${name}.baseUrl requires HTTPS (except loopback tests)`);
    if (
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      Number(url.port || 80) === c.port
    )
      throw new Error(`${name}.baseUrl points back to arelay`);
    if (typeof backend.model !== "string" || !backend.model.trim())
      throw new Error(`${name}.model is required`);
    if (
      typeof backend.apiKeyEnv !== "string" ||
      !/^[A-Z_][A-Z0-9_]*$/.test(backend.apiKeyEnv)
    )
      throw new Error(`${name}.apiKeyEnv must be an environment variable name`);
    if (!["authorization", "api-key", "x-api-key"].includes(backend.authHeader))
      throw new Error(`${name}.authHeader is invalid`);
  }
  if (
    !c.routes ||
    ![c.routes.claudeSubagentModel, c.routes.codexSubagentModel].every(
      (m) => typeof m === "string" && /^[\w.-]+$/.test(m),
    )
  )
    throw new Error(
      "Route aliases must contain only letters, numbers, underscores, dots or hyphens",
    );
  const models = [
    c.routes.claudeSubagentModel,
    c.routes.codexSubagentModel,
    c.openai.model,
    c.anthropic.model,
  ];
  if (new Set(models).size !== models.length)
    throw new Error("Route aliases and backend model IDs must be distinct");
  for (const field of ["requestTimeoutMs", "maxBodyBytes"] as const) {
    if (!Number.isSafeInteger(c[field]) || c[field] <= 0)
      throw new Error(`${field} must be a positive integer`);
  }
  return c;
}

export async function atomicWrite(
  path: string,
  content: string,
): Promise<void> {
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, content, { mode: 0o600, flag: "wx" });
    await rename(tmp, path);
  } finally {
    const { rm } = await import("node:fs/promises");
    await rm(tmp, { force: true });
  }
}

export async function saveConfig(config: Config): Promise<void> {
  validateConfig(config);
  await atomicWrite(paths().config, JSON.stringify(config, null, 2) + "\n");
}

export async function loadConfig(): Promise<Config> {
  return validateConfig(JSON.parse(await readFile(paths().config, "utf8")));
}

export async function initConfig(): Promise<Config> {
  try {
    return await loadConfig();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const config = structuredClone(defaultConfig);
  await saveConfig(config);
  return config;
}

export async function loadCredentials(config: Config): Promise<void> {
  try {
    const text = await readFile(paths().credentials, "utf8");
    await chmod(paths().credentials, 0o600);
    for (const [index, raw] of text.split(/\r?\n/).entries()) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
      if (!match)
        throw new Error(
          `Invalid credentials.env line ${index + 1}; use NAME=value`,
        );
      const key = match[1]!;
      if (![config.openai.apiKeyEnv, config.anthropic.apiKeyEnv].includes(key))
        continue;
      let value = match[2]!.trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      )
        value = value.slice(1, -1);
      if (!process.env[key]) process.env[key] = value;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (process.platform === "darwin") {
    for (const key of new Set([
      config.openai.apiKeyEnv,
      config.anthropic.apiKeyEnv,
    ])) {
      if (process.env[key]) continue;
      try {
        process.env[key] = execFileSync(
          "/usr/bin/security",
          ["find-generic-password", "-s", key, "-w"],
          {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 5000,
          },
        ).trim();
      } catch {
        /* Missing Keychain entries are allowed until that backend is used. */
      }
    }
  }
}
