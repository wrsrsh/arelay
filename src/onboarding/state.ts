import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "smol-toml";
import {
  atomicWrite,
  defaultConfig,
  loadConfig,
  paths,
  validateConfig,
} from "../config.js";
import { previewClientSetup, restoreClient, setupClient } from "../setup.js";
import { service } from "../service.js";
import type { BackendConfig, Config } from "../types.js";
import type {
  ApplyResult,
  Client,
  CredentialStatus,
  WizardInitialState,
  WizardPlan,
  WizardServices,
} from "./types.js";

const validName = (name: string): boolean => /^[A-Z_][A-Z0-9_]*$/.test(name);
const hash = (bytes: Buffer | null): string | null =>
  bytes === null ? null : createHash("sha256").update(bytes).digest("hex");

async function optionalBytes(path: string): Promise<Buffer | null> {
  try {
    if (!(await lstat(path)).isFile())
      throw new Error(`Refusing non-regular file: ${path}`);
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function utf8(bytes: Buffer): string {
  const value = bytes.toString("utf8");
  if (!Buffer.from(value).equals(bytes))
    throw new Error("Configuration and credentials must be valid UTF-8");
  return value;
}

/** Validate without ever including the secret in an error. No shell evaluation. */
export function validateCredential(name: string, value: string): void {
  if (!validName(name))
    throw new Error("Invalid credential environment variable name");
  if (
    typeof value !== "string" ||
    !/^[\x21-\x7e]+$/.test(value) ||
    /['\"]/.test(value)
  )
    throw new Error(
      "Credentials must be nonempty and contain no whitespace, NUL, or quotes",
    );
}

/** Preserve unrelated lines/comments and the original newline style. */
export function mergeCredentials(
  original: string,
  updates: Readonly<Record<string, string>>,
): string {
  for (const [name, value] of Object.entries(updates))
    validateCredential(name, value);
  const seen = new Set<string>();
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  let output = "";
  for (const line of original.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=/.exec(line);
    const name = match?.[1];
    if (!name || !Object.hasOwn(updates, name)) {
      output += line;
      continue;
    }
    if (!seen.has(name)) {
      output += `${name}=${updates[name]}${line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : ""}`;
      seen.add(name);
    }
  }
  for (const [name, value] of Object.entries(updates)) {
    if (seen.has(name)) continue;
    if (output && !output.endsWith("\n")) output += newline;
    output += `${name}=${value}${newline}`;
  }
  return output;
}

function fileHasCredential(content: string, name: string): boolean {
  let present = false;
  for (const raw of content.split(/\r?\n/)) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(raw.trim());
    if (match?.[1] !== name) continue;
    let value = match[2]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    // loadCredentials uses the first nonempty entry, too.
    present ||= Boolean(value.trim());
  }
  return present;
}

export async function keychainHasCredential(name: string): Promise<boolean> {
  if (!validName(name)) return false;
  return new Promise((resolvePresence) => {
    // Metadata lookup only: never request (-w/-g) or capture the password.
    const child = execFile(
      "/usr/bin/security",
      ["find-generic-password", "-s", name],
      { timeout: 5000 },
      (error) => resolvePresence(!error),
    );
    child.stdout?.resume();
    child.stderr?.resume();
  });
}

export interface StateDependencies {
  platform: NodeJS.Platform;
  environment: NodeJS.ProcessEnv;
  keychain: (name: string) => Promise<boolean>;
  preview: typeof previewClientSetup;
  setup: typeof setupClient;
  restore: typeof restoreClient;
  service: typeof service;
  write: typeof atomicWrite;
}

export async function credentialStatus(
  name: string,
  options: Pick<StateDependencies, "platform" | "environment" | "keychain"> = {
    platform: process.platform,
    environment: process.env,
    keychain: keychainHasCredential,
  },
): Promise<CredentialStatus | undefined> {
  if (!validName(name))
    throw new Error("Invalid credential environment variable name");
  const bytes = await optionalBytes(paths().credentials);
  if (bytes !== null && fileHasCredential(utf8(bytes), name))
    return { source: "credentials file", persistent: true };
  if (options.platform === "darwin" && (await options.keychain(name)))
    return { source: "Keychain", persistent: true };
  if (options.environment[name]?.trim())
    return { source: "environment", persistent: false };
  return undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Only the selected Responses provider's non-secret backend settings are suggested. */
export async function detectCodexBackend(
  config: Config,
): Promise<BackendConfig | undefined> {
  const bytes = await optionalBytes(
    resolve(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml"),
  );
  if (bytes === null) return undefined;
  // Optional discovery must not prevent opening the wizard; setup preflight reports invalid TOML.
  try {
    const settings = parse(utf8(bytes), { integersAsBigInt: true });
    let active: Record<string, unknown> = settings;
    if (settings.profile !== undefined) {
      if (typeof settings.profile !== "string") return undefined;
      const profile = record(record(settings.profiles)?.[settings.profile]);
      if (!profile) return undefined;
      active = profile;
    }
    if (
      (active.forced_login_method ?? settings.forced_login_method) === "chatgpt"
    )
      return undefined;
    const name = active.model_provider ?? settings.model_provider;
    if (typeof name !== "string" || name === "arelay") return undefined;
    const provider = record(record(settings.model_providers)?.[name]);
    if (
      !provider ||
      provider.wire_api !== "responses" ||
      typeof provider.base_url !== "string"
    )
      return undefined;
    if (
      provider.requires_openai_auth === true &&
      provider.env_key === undefined
    )
      return undefined;
    const apiKeyEnv = provider.env_key ?? config.openai.apiKeyEnv;
    if (typeof apiKeyEnv !== "string" || !validName(apiKeyEnv))
      return undefined;
    const model = active.model ?? settings.model ?? config.openai.model;
    if (typeof model !== "string") return undefined;
    const backend: BackendConfig = {
      baseUrl: provider.base_url,
      model,
      apiKeyEnv,
      authHeader:
        record(provider.env_http_headers)?.["api-key"] === apiKeyEnv
          ? "api-key"
          : "authorization",
    };
    if (
      ["chatgpt.com", "chat.openai.com"].includes(
        new URL(backend.baseUrl).hostname,
      )
    )
      return undefined;
    validateConfig({ ...config, openai: backend });
    return backend;
  } catch {
    return undefined;
  }
}

export async function loadWizardState(): Promise<WizardInitialState> {
  let config: Config;
  let existing = true;
  try {
    config = await loadConfig();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    config = structuredClone(defaultConfig);
    existing = false;
  }
  const codexBackend = await detectCodexBackend(config);
  return { config, existing, ...(codexBackend ? { codexBackend } : {}) };
}

interface Snapshot {
  path: string;
  bytes: Buffer | null;
  expected: Buffer;
  attempted: boolean;
}

export function createWizardServices(
  overrides: Partial<StateDependencies> = {},
): WizardServices {
  const deps: StateDependencies = {
    platform: process.platform,
    environment: process.env,
    keychain: keychainHasCredential,
    preview: previewClientSetup,
    setup: setupClient,
    restore: restoreClient,
    service,
    write: atomicWrite,
    ...overrides,
  };
  const credential = (name: string) => credentialStatus(name, deps);
  return {
    load: loadWizardState,
    credential,
    preview: (client, config, keys) => deps.preview(client, config, keys),
    async apply(input: WizardPlan): Promise<ApplyResult> {
      // Detach from mutable UI state before any asynchronous work.
      const plan = structuredClone(input);
      validateConfig(plan.config);
      if (
        !Array.isArray(plan.clients) ||
        plan.clients.some((client) => !["claude", "codex"].includes(client)) ||
        new Set(plan.clients).size !== plan.clients.length
      )
        throw new Error("Invalid or duplicate setup clients");
      const names = new Set([
        plan.config.openai.apiKeyEnv,
        plan.config.anthropic.apiKeyEnv,
      ]);
      for (const [name, value] of Object.entries(plan.credentials)) {
        validateCredential(name, value);
        if (!names.has(name))
          throw new Error("Credentials must belong to a configured backend");
      }
      const p = paths();
      const configBytes = await optionalBytes(p.config);
      const credentialBytes = await optionalBytes(p.credentials);
      if (configBytes !== null) utf8(configBytes);
      const merged = mergeCredentials(
        credentialBytes === null ? "" : utf8(credentialBytes),
        plan.credentials,
      );
      const availableKeys = new Set(Object.keys(plan.credentials));
      for (const name of names)
        if (await credential(name)) availableKeys.add(name);
      for (const client of plan.clients) {
        if (
          (await deps.preview(client, plan.config, availableKeys)).status ===
          "blocked"
        )
          throw new Error(
            `${client} preflight blocked setup; review client configuration before retrying`,
          );
      }
      const snapshots: Snapshot[] = [
        ...(Object.keys(plan.credentials).length
          ? [
              {
                path: p.credentials,
                bytes: credentialBytes,
                expected: Buffer.from(merged),
                attempted: false,
              },
            ]
          : []),
        {
          path: p.config,
          bytes: configBytes,
          expected: Buffer.from(JSON.stringify(plan.config, null, 2) + "\n"),
          attempted: false,
        },
      ];
      const newlyConfigured: Client[] = [];
      let attempting: Client | undefined;
      try {
        for (const snapshot of snapshots) {
          if (hash(await optionalBytes(snapshot.path)) !== hash(snapshot.bytes))
            throw new Error("Files changed during onboarding");
          snapshot.attempted = true;
          await deps.write(snapshot.path, snapshot.expected.toString("utf8"));
        }
        for (const client of plan.clients) {
          const before = await deps.preview(client, plan.config, availableKeys);
          if (before.status === "blocked")
            throw new Error("Client preflight changed during onboarding");
          attempting = before.status === "managed" ? undefined : client;
          const result = await deps.setup(client, plan.config, {
            availableKeys,
          });
          if (result.changed) newlyConfigured.push(client);
          attempting = undefined;
        }
      } catch {
        const recovery: string[] = [];
        // A rejected setup gives no ownership receipt. It may be another
        // invocation's lock/installation: never restore it speculatively.
        if (attempting) {
          const directory = join(p.state, `${attempting}-setup`);
          try {
            await lstat(directory);
            recovery.push(
              `${attempting} setup did not finish; preserve recovery state at ${directory} and inspect it before restoring`,
            );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT")
              recovery.push(`Unable to inspect ${attempting} recovery state`);
          }
        }
        for (const client of newlyConfigured.reverse()) {
          try {
            await deps.restore(client);
          } catch {
            recovery.push(
              `${client} restoration failed; preserve its setup backups`,
            );
          }
        }
        for (const snapshot of [...snapshots].reverse()) {
          if (!snapshot.attempted) continue;
          try {
            const current = hash(await optionalBytes(snapshot.path));
            if (current === hash(snapshot.bytes)) continue;
            if (current !== hash(snapshot.expected))
              throw new Error("Concurrent edit");
            if (snapshot.bytes === null) await rm(snapshot.path);
            else await deps.write(snapshot.path, utf8(snapshot.bytes));
          } catch {
            recovery.push(
              `Could not restore ${snapshot.path}; concurrent edits or a filesystem error require manual recovery`,
            );
          }
        }
        if (recovery.length) {
          try {
            await mkdir(p.dir, { recursive: true, mode: 0o700 });
            const backup = await mkdtemp(join(p.dir, "onboarding-recovery-"));
            if (configBytes !== null)
              await atomicWrite(
                join(backup, "config.json.backup"),
                utf8(configBytes),
              );
            if (credentialBytes !== null)
              await atomicWrite(
                join(backup, "credentials.env.backup"),
                utf8(credentialBytes),
              );
            recovery.push(
              `Original file snapshots saved privately at ${backup}; absent original files have no backup`,
            );
          } catch {
            recovery.push(
              "Unable to save recovery snapshots; preserve all existing backups and files",
            );
          }
        }
        throw new Error(
          `Onboarding failed; ${recovery.length ? recovery.join(". ") : "changes were rolled back"}`,
        );
      }
      if (!plan.startService) return { service: "skipped" };
      try {
        await deps.service("install");
        return { service: "started" };
      } catch {
        return {
          service: "failed",
          message:
            "Configuration was saved, but the service could not start. Run arelay service install from a logged-in user session after building arelay.",
        };
      }
    },
  };
}

export const wizardServices: WizardServices = createWizardServices();
