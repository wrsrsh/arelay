import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse, stringify } from "smol-toml";
import { atomicWrite, paths, validateConfig } from "./config.js";
import type { Config } from "./types.js";
import { codexCatalog } from "./catalog.js";
import type { SetupPreview } from "./onboarding/types.js";

type Client = "claude" | "codex";
type Table = Record<string, unknown>;
interface GeneratedFile {
  name: string;
  hash: string;
}
interface Installation {
  version: 1;
  client: Client;
  target: string;
  originalHash: string | null;
  installedHash: string;
  fingerprint: string;
  generated: GeneratedFile[];
}
interface Plan {
  content: string;
  generated: { name: string; content: string }[];
}

const hash = (bytes: string | Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");
const normalizedBase = (base: string): string => base.replace(/\/+$/, "");
const isTable = (value: unknown): value is Table =>
  value !== null &&
  typeof value === "object" &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

function table(value: unknown, label: string): Table {
  if (!isTable(value)) throw new Error(`${label} must be an object/table`);
  return value;
}

function childTable(parent: Table, key: string): Table {
  const value = Object.hasOwn(parent, key) ? parent[key] : undefined;
  if (value !== undefined) return table(value, key);
  const result: Table = Object.create(null) as Table;
  parent[key] = result;
  return result;
}

function clientPath(client: Client): string {
  if (client === "claude")
    return resolve(
      process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
      "settings.json",
    );
  if (client === "codex")
    return resolve(
      process.env.CODEX_HOME || join(homedir(), ".codex"),
      "config.toml",
    );
  throw new Error(`Unsupported client: ${String(client)}`);
}

// Do not replace symlinks (including dangling ones) or special files with a
// regular file. A missing file and an unreadable file are different cases.
async function optionalFile(path: string): Promise<Buffer | null> {
  try {
    if (!(await lstat(path)).isFile())
      throw new Error(`Refusing to replace a non-regular file: ${path}`);
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function text(bytes: Buffer): string {
  const value = bytes.toString("utf8");
  // atomicWrite accepts strings; reject invalid UTF-8 rather than make a lossy
  // backup. Valid UTF-8, including CRLFs and a BOM, round-trips byte for byte.
  if (!Buffer.from(value, "utf8").equals(bytes))
    throw new Error("Client configuration must be valid UTF-8");
  return value;
}

function digest(bytes: Buffer | null): string | null {
  return bytes === null ? null : hash(bytes);
}

function fingerprint(client: Client, config: Config): string {
  return hash(
    JSON.stringify(
      client === "claude"
        ? [config.port, config.routes.claudeSubagentModel]
        : [
            config.port,
            config.routes.codexSubagentModel,
            normalizedBase(config.openai.baseUrl),
            config.openai.apiKeyEnv,
          ],
    ),
  );
}

function priorIntegration(detail: string): Error {
  return new Error(
    `${detail}. Unsetup the prior integration first (including codex-bridge or any gateway); arelay will not overwrite it.`,
  );
}

function claudePlan(original: Buffer | null, config: Config): Plan {
  const settings = table(
    original === null ? {} : JSON.parse(text(original)),
    "Claude settings",
  );
  const env = childTable(settings, "env");
  const base = `http://127.0.0.1:${config.port}`;
  for (const existing of [
    env.ANTHROPIC_BASE_URL,
    process.env.ANTHROPIC_BASE_URL,
  ]) {
    if (existing === undefined) continue;
    if (typeof existing !== "string")
      throw priorIntegration("Invalid ANTHROPIC_BASE_URL");
    const normalized = normalizedBase(existing);
    if (
      ![
        "https://api.anthropic.com",
        "https://api.anthropic.com/v1",
        base,
        `${base}/v1`,
        `http://localhost:${config.port}`,
        `http://localhost:${config.port}/v1`,
        `http://[::1]:${config.port}`,
        `http://[::1]:${config.port}/v1`,
      ].includes(normalized)
    )
      throw priorIntegration(
        "Existing ANTHROPIC_BASE_URL is not Anthropic or this arelay port",
      );
  }
  Object.assign(env, {
    ANTHROPIC_BASE_URL: base,
    _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1",
    CLAUDE_CODE_SUBAGENT_MODEL: config.routes.claudeSubagentModel,
    CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
    ENABLE_TOOL_SEARCH: "false",
    ANTHROPIC_CUSTOM_MODEL_OPTION: config.routes.claudeSubagentModel,
    ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: "arelay · OpenAI subagents",
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
  });
  return { content: JSON.stringify(settings, null, 2) + "\n", generated: [] };
}

function requireApiKey(
  config: Config,
  availableKeys?: ReadonlySet<string>,
): void {
  const key = config.openai.apiKeyEnv;
  if (!availableKeys?.has(key) && !process.env[key]?.trim())
    throw new Error(
      `Codex requires an API-key provider: set ${key} in the environment or configure it for arelay. ChatGPT subscription authentication cannot be transparently proxied.`,
    );
}

function assertUpstream(base: unknown, config: Config): void {
  if (
    typeof base !== "string" ||
    normalizedBase(base) !== normalizedBase(config.openai.baseUrl)
  )
    throw priorIntegration(
      "The current Codex provider base_url must match arelay's openai.baseUrl",
    );
  const url = new URL(base);
  if (["chatgpt.com", "chat.openai.com"].includes(url.hostname))
    throw new Error(
      "ChatGPT subscription endpoints cannot be proxied; configure an OpenAI API-key Responses provider first.",
    );
}

async function codexPlan(
  original: Buffer | null,
  target: string,
  directory: string,
  config: Config,
  availableKeys?: ReadonlySet<string>,
): Promise<Plan> {
  // Preserve dates and large integers as well as unrelated tables/settings.
  const settings: Table =
    original === null ? {} : parse(text(original), { integersAsBigInt: true });
  let active = settings;
  if (settings.profile !== undefined) {
    if (typeof settings.profile !== "string")
      throw new Error("Codex profile must be a string");
    const profiles = table(settings.profiles, "profiles");
    active = table(profiles[settings.profile], "active profile");
    if (active.agents !== undefined)
      throw new Error(
        "Profile-specific agents are not supported; configure roles at the top level first.",
      );
  }
  const providerName =
    active.model_provider ?? settings.model_provider ?? "openai";
  if (typeof providerName !== "string")
    throw new Error("Codex model_provider must be a string");
  const providers = childTable(settings, "model_providers");
  const existing = Object.hasOwn(providers, providerName)
    ? providers[providerName]
    : undefined;
  const localBase = `http://127.0.0.1:${config.port}/v1`;
  if (
    (active.forced_login_method ?? settings.forced_login_method) === "chatgpt"
  )
    throw new Error(
      "Codex forces ChatGPT subscription login; configure API-key authentication first.",
    );

  if (existing !== undefined) {
    const provider = table(existing, `model_providers.${providerName}`);
    if (provider.wire_api !== "responses")
      throw new Error(
        "Codex's current provider must use wire_api = 'responses'",
      );
    assertUpstream(provider.base_url, config);
    if (
      provider.env_key !== undefined &&
      (typeof provider.env_key !== "string" || !provider.env_key.trim())
    )
      throw new Error(
        "Codex provider env_key must name an API-key environment variable",
      );
    // An explicit env_key bypasses Codex's first-party (potentially ChatGPT)
    // auth path. Do not silently replace a custom provider's login credentials
    // with another key, even when OPENAI_API_KEY happens to be in our process.
    if (
      provider.requires_openai_auth === true &&
      provider.env_key === undefined
    )
      throw new Error(
        "Custom Codex provider uses first-party/ChatGPT subscription authentication; configure its env_key for API-key authentication before setup. Existing auth will not be replaced.",
      );
    provider.base_url = localBase;
    provider.supports_websockets = false;
  } else {
    if (providerName !== "openai")
      throw priorIntegration(`Unknown current Codex provider ${providerName}`);
    assertUpstream(
      process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      config,
    );
    requireApiKey(config, availableKeys);
    if (Object.hasOwn(providers, "arelay"))
      throw priorIntegration("A Codex provider named arelay already exists");
    providers.arelay = {
      name: "arelay",
      base_url: localBase,
      requires_openai_auth: false,
      wire_api: "responses",
      supports_websockets: false,
    };
    // Change the effective selector without modifying the main model or any
    // inactive profile. Explicit custom providers keep their original identity.
    if (active !== settings && active.model_provider !== undefined)
      active.model_provider = "arelay";
    else settings.model_provider = "arelay";
  }

  const catalog = await codexCatalog(
    config,
    active.model_catalog_json ?? settings.model_catalog_json,
    target,
  );
  settings.model_catalog_json = join(directory, "agents", "models.json");
  if (active !== settings && active.model_catalog_json !== undefined)
    active.model_catalog_json = settings.model_catalog_json;
  // Hosted search has provider-specific state and cannot cross the protocol boundary.
  // This affects the routed Codex session, including its main model, and is reversible.
  settings.web_search = "disabled";
  if (active !== settings && active.web_search !== undefined)
    active.web_search = "disabled";
  childTable(settings, "features").multi_agent = true;
  if (active !== settings && active.features !== undefined)
    childTable(active, "features").multi_agent = true;
  const agents = childTable(settings, "agents");
  const roles = new Set(["default", "explorer", "worker"]);
  for (const [name, value] of Object.entries(agents)) {
    // Non-table entries are agent-wide settings, not roles. Leave even unknown
    // settings intact for forward compatibility with newer Codex versions.
    if (isTable(value)) roles.add(name);
  }
  const generated: Plan["generated"] = [
    { name: "models.json", content: catalog },
  ];
  for (const name of roles) {
    if (!/^[A-Za-z0-9_-]+$/.test(name))
      throw new Error(`Unsafe Codex agent role name: ${name}`);
    const role = childTable(agents, name);
    if (role.description === undefined)
      role.description = `Use the ${name} subagent for delegated tasks, routed through arelay.`;
    let overrides: Table = {};
    if (role.config_file !== undefined) {
      if (typeof role.config_file !== "string" || !role.config_file.trim())
        throw new Error(`agents.${name}.config_file must be a nonempty path`);
      // These files are read-only inputs, never edited or restored by arelay.
      const source = resolve(dirname(target), role.config_file);
      overrides = parse(text(await readFile(source)), {
        integersAsBigInt: true,
      });
    }
    overrides.model = config.routes.codexSubagentModel;
    overrides.model_reasoning_summary = "none";
    // Best effort: Codex versions whose AgentRoleOverrides omit web_search
    // ignore this. We do NOT set model_provider: roles inherit the main provider.
    overrides.web_search = "disabled";
    const filename = `role-${hash(name)}.toml`;
    generated.push({
      name: filename,
      content: stringify(overrides, { numbersAsFloat: true }),
    });
    role.config_file = join(directory, "agents", filename);
  }
  return { content: stringify(settings, { numbersAsFloat: true }), generated };
}

function metadataPath(directory: string): string {
  return join(directory, "installation.json");
}

async function installation(directory: string): Promise<Installation | null> {
  await optionalDirectory(directory, "Setup state");
  const bytes = await optionalFile(metadataPath(directory));
  if (bytes === null) {
    // An incomplete/private directory is not permission to replace a backup.
    try {
      await lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    throw new Error(
      `Incomplete setup state at ${directory}; preserve its backups and recover it before retrying`,
    );
  }
  const data = table(JSON.parse(text(bytes)), "Setup metadata");
  const validHash = (value: unknown): value is string =>
    typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  if (
    data.version !== 1 ||
    !["claude", "codex"].includes(String(data.client)) ||
    typeof data.target !== "string" ||
    !(data.originalHash === null || validHash(data.originalHash)) ||
    !validHash(data.installedHash) ||
    !validHash(data.fingerprint) ||
    !Array.isArray(data.generated) ||
    !data.generated.every(
      (entry: unknown) =>
        isTable(entry) &&
        typeof entry.name === "string" &&
        /^(?:role-[a-f0-9]{64}\.toml|models\.json)$/.test(entry.name) &&
        validHash(entry.hash),
    )
  )
    throw new Error(`Invalid setup metadata at ${directory}`);
  return data as unknown as Installation;
}

async function verifyInstallation(
  saved: Installation,
  client: Client,
  target: string,
  directory: string,
): Promise<void> {
  if (saved.client !== client || saved.target !== target)
    throw new Error(
      "Client configuration directory changed since setup; use the original directory to restore",
    );
  if (digest(await optionalFile(target)) !== saved.installedHash)
    throw new Error(
      `Refusing to overwrite ${target}: it changed since setup. Preserve your edits and restore the installed bytes before retrying.`,
    );
  if (saved.generated.length)
    await optionalDirectory(join(directory, "agents"), "Generated agent state");
  for (const file of saved.generated) {
    if (
      digest(await optionalFile(join(directory, "agents", file.name))) !==
      file.hash
    )
      throw new Error(
        "A generated agent config changed since setup; refusing to erase edits",
      );
  }
}

async function optionalDirectory(path: string, label: string): Promise<void> {
  try {
    if (!(await lstat(path)).isDirectory())
      throw new Error(
        `${label} must be a real directory, not a symlink: ${path}`,
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

// Unlike withStateLock, this check never creates state or changes permissions.
// lstat also detects dangling symlinks without following them.
async function checkPreviewState(client: Client): Promise<void> {
  const state = paths().state;
  await optionalDirectory(state, "arelay state");
  const lock = join(state, `${client}-setup.lock`);
  try {
    await lstat(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(
    `Setup/restore is already running, or left a stale lock at ${lock}`,
  );
}

async function planSetup(
  client: Client,
  config: Config,
  target: string,
  directory: string,
  availableKeys?: ReadonlySet<string>,
): Promise<{ original: Buffer | null; plan: Plan } | null> {
  const saved = await installation(directory);
  if (saved !== null) {
    await verifyInstallation(saved, client, target, directory);
    if (saved.fingerprint !== fingerprint(client, config))
      throw new Error(
        "arelay setup parameters changed; restore this client before setting it up again",
      );
    return null; // Never back up an already-managed configuration.
  }
  const original = await optionalFile(target);
  const plan =
    client === "claude"
      ? claudePlan(original, config)
      : await codexPlan(original, target, directory, config, availableKeys);
  return { original, plan };
}

export async function previewClientSetup(
  client: Client,
  config: Config,
  availableKeys?: ReadonlySet<string>,
): Promise<SetupPreview> {
  try {
    validateConfig(config);
    const target = clientPath(client);
    await checkPreviewState(client);
    const planned = await planSetup(
      client,
      config,
      target,
      join(paths().state, `${client}-setup`),
      availableKeys,
    );
    // A preview is advisory, but do not report ready if setup acquired a lock
    // while the client/role/catalog inputs were being read.
    await checkPreviewState(client);
    return planned === null
      ? {
          status: "managed",
          message: `${client} is already managed by arelay.`,
        }
      : { status: "ready", message: `${client} is ready for arelay setup.` };
  } catch (error) {
    return {
      status: "blocked",
      message:
        error instanceof Error &&
        (error.name === "SyntaxError" || error.name === "TomlError")
          ? "Client configuration is not valid JSON/TOML. Fix it before applying setup."
          : error instanceof Error
            ? error.message
            : "Client configuration could not be checked",
    };
  }
}

async function withStateLock(
  client: Client,
  action: (directory: string) => Promise<void>,
): Promise<void> {
  const state = paths().state;
  await mkdir(state, { recursive: true, mode: 0o700 });
  if (!(await lstat(state)).isDirectory())
    throw new Error("arelay state must be a real directory, not a symlink");
  await chmod(state, 0o700);
  const lock = join(state, `${client}-setup.lock`);
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        `Setup/restore is already running, or left a stale lock at ${lock}`,
      );
    throw error;
  }
  try {
    await action(join(state, `${client}-setup`));
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

/**
 * Route the currently configured roles, not roles added in the future.
 * Installing an explicit explorer config can replace Codex's built-in explorer
 * defaults. Role web_search support is Codex-version-dependent. CLI/project
 * overrides and inactive profiles are outside this user-config integration.
 */
export async function setupClient(
  client: Client,
  config: Config,
  options?: { availableKeys?: ReadonlySet<string> },
): Promise<{ changed: boolean }> {
  validateConfig(config);
  const target = clientPath(client);
  let changed = false;
  await withStateLock(client, async (directory) => {
    const planned = await planSetup(
      client,
      config,
      target,
      directory,
      options?.availableKeys,
    );
    if (planned === null) return;
    const { original, plan } = planned;
    // Every parse, provider/auth check, role read, and serialization completes
    // before writing any backup/generated files or changing the user config.
    const metadata: Installation = {
      version: 1,
      client,
      target,
      originalHash: digest(original),
      installedHash: hash(plan.content),
      fingerprint: fingerprint(client, config),
      generated: plan.generated.map((file) => ({
        name: file.name,
        hash: hash(file.content),
      })),
    };
    await mkdir(directory, { mode: 0o700 });
    try {
      if (original !== null)
        await atomicWrite(join(directory, "original.backup"), text(original));
      for (const file of plan.generated)
        await atomicWrite(join(directory, "agents", file.name), file.content);
      // Persist recovery data BEFORE the atomic user-file replacement. A crash
      // after replacement still leaves a complete, usable backup and manifest.
      await atomicWrite(
        metadataPath(directory),
        JSON.stringify(metadata, null, 2) + "\n",
      );
      if (digest(await optionalFile(target)) !== metadata.originalHash)
        throw new Error(
          "Client configuration changed during setup; refusing to overwrite it",
        );
      await atomicWrite(target, plan.content);
      changed = true;
    } catch (error) {
      // Only discard staging when the target provably still matches the
      // original. Drift, a successful rename, or an unreadable target must
      // retain recovery data; cleanup must not mask the original failure.
      try {
        if (digest(await optionalFile(target)) === metadata.originalHash)
          await rm(directory, { recursive: true, force: true });
      } catch {
        throw new Error(
          `Setup failed and cleanup could not be verified; preserve recovery data at ${directory} and inspect the client configuration before retrying`,
        );
      }
      throw error;
    }
  });
  return { changed };
}

export async function restoreClient(client: Client): Promise<void> {
  const target = clientPath(client);
  await withStateLock(client, async (directory) => {
    const saved = await installation(directory);
    if (saved === null) return;
    await verifyInstallation(saved, client, target, directory);
    const backup = await optionalFile(join(directory, "original.backup"));
    if (digest(backup) !== saved.originalHash)
      throw new Error(
        "Original client backup is missing or corrupt; refusing to restore",
      );
    const restored = backup === null ? null : text(backup);
    // Recheck after reading recovery data, as close to replacement as possible.
    await verifyInstallation(saved, client, target, directory);
    if (restored === null) await rm(target);
    else await atomicWrite(target, restored);
    await rm(directory, { recursive: true, force: true });
  });
}
