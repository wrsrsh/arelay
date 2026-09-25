import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parse } from "smol-toml";
import { paths } from "../config.js";
import type { JsonObject } from "../types.js";

const exec = promisify(execFile);
export interface CodexProvider {
  id: string;
  name: string;
  configured: boolean;
  requiresLogin: boolean;
  requiredKey?: string;
  envNames: string[];
  mcpServers: string[];
}

/** Read provider metadata, not Codex's auth/token store. The CLI still owns auth. */
export async function codexProvider(
  configDir?: string,
): Promise<CodexProvider> {
  let data: JsonObject = {};
  try {
    data = parse(
      await readFile(
        join(
          configDir || process.env.CODEX_HOME || join(homedir(), ".codex"),
          "config.toml",
        ),
        "utf8",
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error(
        "Codex config.toml could not be read; repair the existing CLI configuration first",
      );
  }
  const active =
    typeof data.profile === "string"
      ? (data.profiles?.[data.profile] ?? {})
      : {};
  const id = active.model_provider ?? data.model_provider ?? "openai";
  if (typeof id !== "string") throw new Error("Invalid Codex model provider");
  const provider = data.model_providers?.[id];
  if (id !== "openai" && !provider)
    throw new Error("The selected Codex provider has no definition");
  const requiredKey = provider?.env_key;
  const envNames = [
    ...new Set(
      [requiredKey, ...Object.values(provider?.env_http_headers || {})].filter(
        (value) => value !== undefined,
      ),
    ),
  ];
  if (
    envNames.some(
      (name) => typeof name !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(name),
    )
  )
    throw new Error(
      "Codex provider credentials must reference environment variable names",
    );
  const mcpServers = Object.keys(data.mcp_servers || {});
  if (mcpServers.some((name) => !/^[A-Za-z0-9_-]+$/.test(name)))
    throw new Error(
      "Codex MCP server names must use letters, numbers, hyphens or underscores for native worker isolation",
    );
  return {
    id,
    name: String(provider?.name || id)
      .replace(/[^\w .-]/g, "")
      .slice(0, 80),
    configured: Boolean(provider),
    requiresLogin:
      !provider || (provider.requires_openai_auth === true && !requiredKey),
    ...(requiredKey ? { requiredKey } : {}),
    envNames: envNames as string[],
    mcpServers,
  };
}

export interface ProviderCredentialOptions {
  environment: NodeJS.ProcessEnv;
  credentialFile: string;
  keychain: (name: string) => Promise<string | undefined>;
}
export async function providerCredential(
  name: string,
  options?: Partial<ProviderCredentialOptions>,
): Promise<string | undefined> {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name))
    throw new Error("Invalid provider credential variable");
  const env = options?.environment ?? process.env;
  if (env[name]) return env[name];
  try {
    const text = await readFile(
      options?.credentialFile ?? paths().credentials,
      "utf8",
    );
    for (const raw of text.split(/\r?\n/)) {
      const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(raw.trim());
      if (match?.[1] !== name) continue;
      let value = match[2]!.trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      )
        value = value.slice(1, -1);
      if (value) return value;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error("Cannot read arelay's provider credentials file");
  }
  if (options?.keychain) return options.keychain(name);
  if (process.platform !== "darwin") return undefined;
  try {
    const { stdout } = await exec(
      "/usr/bin/security",
      ["find-generic-password", "-s", name, "-w"],
      { timeout: 5000, maxBuffer: 64 * 1024 },
    );
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Only variables declared by the selected provider are forwarded. No OAuth tokens. */
export async function codexProviderEnvironment(
  provider: CodexProvider,
  configDir?: string,
): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {};
  if (configDir) env.CODEX_HOME = configDir;
  for (const name of provider.envNames) {
    const value = await providerCredential(name);
    if (value) env[name] = value;
  }
  if (provider.requiredKey && !env[provider.requiredKey])
    throw new Error(
      `Codex provider ${provider.name} needs ${provider.requiredKey}. Keep it available in the environment, arelay credentials.env, or its named Keychain item.`,
    );
  // Honor an explicitly exported first-party API key, but never discover one as a
  // fallback to an existing ChatGPT login: that could silently change billing.
  if (!provider.configured && process.env.OPENAI_API_KEY)
    env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  return env;
}
