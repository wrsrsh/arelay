import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test, { mock } from "node:test";
import { parse, stringify } from "smol-toml";
import { defaultConfig, paths } from "../src/config.js";
import {
  previewClientSetup,
  restoreClient,
  setupClient,
} from "../src/setup.js";
import type { Config } from "../src/types.js";

type Client = "claude" | "codex";
type Table = Record<string, unknown>;
interface Fixture {
  root: string;
  claude: string;
  codex: string;
  config: Config;
}

// Every scenario, including failures, overrides BOTH clients and ARELAY_HOME.
// Never depend on (or write to) the developer's real configuration/credentials.
const envKeys = [
  "ARELAY_HOME",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "ANTHROPIC_BASE_URL",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "ARELAY_TEST_OPENAI_KEY",
] as const;
function scenario(
  name: string,
  run: (fixture: Fixture) => Promise<void>,
): void {
  test(name, { concurrency: false }, async () => {
    const saved = new Map(envKeys.map((key) => [key, process.env[key]]));
    const root = await mkdtemp(join(tmpdir(), "arelay-setup-test-"));
    try {
      for (const key of envKeys) delete process.env[key];
      process.env.ARELAY_HOME = join(root, "arelay");
      process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
      process.env.CODEX_HOME = join(root, "codex");
      const fixture: Fixture = {
        root,
        claude: join(process.env.CLAUDE_CONFIG_DIR, "settings.json"),
        codex: join(process.env.CODEX_HOME, "config.toml"),
        config: structuredClone(defaultConfig),
      };
      await run(fixture);
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
}

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}
async function absent(path: string): Promise<void> {
  await assert.rejects(stat(path), { code: "ENOENT" });
}
async function json(path: string): Promise<Table> {
  return JSON.parse(await readFile(path, "utf8")) as Table;
}
async function toml(path: string): Promise<Table> {
  return parse(await readFile(path, "utf8"), { integersAsBigInt: "asNeeded" });
}
function stateDir(client: Client): string {
  return join(paths().state, `${client}-setup`);
}
async function roles(path: string): Promise<Record<string, Table>> {
  return (await toml(path)).agents as Record<string, Table>;
}
// Include directory modes and symlink destinations without following links.
async function filesystemSnapshot(directory: string): Promise<unknown> {
  const info = await lstat(directory);
  const mode = info.mode & 0o7777;
  if (info.isSymbolicLink()) return { mode, link: await readlink(directory) };
  if (!info.isDirectory()) return { mode, bytes: await readFile(directory) };
  const entries: Record<string, unknown> = {};
  for (const name of (await readdir(directory)).sort())
    entries[name] = await filesystemSnapshot(join(directory, name));
  return { mode, entries };
}

function assertEnvironmentUnchanged(before: NodeJS.ProcessEnv): void {
  // Do not include real shell credentials in assertion failure output.
  assert.ok(
    Object.keys(process.env).length === Object.keys(before).length &&
      Object.entries(before).every(
        ([key, value]) => process.env[key] === value,
      ),
    "process environment changed",
  );
}

async function previewWithoutChanges(
  f: Fixture,
  client: Client,
  status: "ready" | "managed" | "blocked",
  message?: RegExp,
  availableKeys?: ReadonlySet<string>,
): Promise<void> {
  const before = await filesystemSnapshot(f.root);
  const environment = { ...process.env };
  const spies = [
    mock.method(fs, "mkdir", async () => {
      throw new Error("preview called mkdir");
    }),
    mock.method(fs, "chmod", async () => {
      throw new Error("preview called chmod");
    }),
    mock.method(fs, "writeFile", async () => {
      throw new Error("preview called writeFile");
    }),
    mock.method(fs, "rename", async () => {
      throw new Error("preview called rename");
    }),
    mock.method(fs, "rm", async () => {
      throw new Error("preview called rm");
    }),
  ];
  syncBuiltinESMExports();
  try {
    const preview = await previewClientSetup(client, f.config, availableKeys);
    assert.equal(preview.status, status);
    assert.equal(typeof preview.message, "string");
    assert.ok(preview.message.trim().length > 0);
    if (message) assert.match(preview.message, message);
    for (const spy of spies) assert.equal(spy.mock.callCount(), 0);
    assertEnvironmentUnchanged(environment);
    assert.deepEqual(await filesystemSnapshot(f.root), before);
  } finally {
    for (const spy of spies) spy.mock.restore();
    syncBuiltinESMExports();
  }
}

async function snapshots(directory: string): Promise<Record<string, Buffer>> {
  const entries: Record<string, Buffer> = {};
  for (const file of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, file.name);
    if (file.isDirectory()) {
      for (const [name, bytes] of Object.entries(await snapshots(path)))
        entries[join(file.name, name)] = bytes;
    } else entries[file.name] = await readFile(path);
  }
  return entries;
}

scenario(
  "Claude preserves settings/env, installs every routing flag, and restores exact bytes",
  async (f) => {
    const original =
      '{\r\n "env": {"KEEP": "yes", "ANTHROPIC_API_KEY": "private", "ANTHROPIC_BASE_URL": "https://api.anthropic.com/v1/"},\r\n "permissions": {"allow": ["Read"]}, "model": "opus"\r\n}\r\n';
    await put(f.claude, original);
    await setupClient("claude", f.config);
    const settings = await json(f.claude);
    assert.equal(settings.model, "opus");
    assert.deepEqual(settings.permissions, { allow: ["Read"] });
    assert.deepEqual(settings.env, {
      KEEP: "yes",
      ANTHROPIC_API_KEY: "private",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${f.config.port}`,
      _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1",
      CLAUDE_CODE_SUBAGENT_MODEL: f.config.routes.claudeSubagentModel,
      CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
      ENABLE_TOOL_SEARCH: "false",
      ANTHROPIC_CUSTOM_MODEL_OPTION: f.config.routes.claudeSubagentModel,
      ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: "arelay · OpenAI subagents",
      CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
    });
    const backup = join(stateDir("claude"), "original.backup");
    assert.deepEqual(await readFile(backup), Buffer.from(original));
    assert.equal((await stat(backup)).mode & 0o777, 0o600);
    assert.equal(
      (await stat(join(stateDir("claude"), "installation.json"))).mode & 0o777,
      0o600,
    );
    assert.equal((await stat(stateDir("claude"))).mode & 0o777, 0o700);
    assert.equal((await stat(paths().state)).mode & 0o777, 0o700);
    await restoreClient("claude");
    assert.deepEqual(await readFile(f.claude), Buffer.from(original));
    await absent(stateDir("claude"));
  },
);

for (const base of [
  "https://api.anthropic.com",
  "https://api.anthropic.com/v1",
  "http://127.0.0.1:8788",
  "http://localhost:8788/v1/",
]) {
  scenario(
    `Claude accepts official or matching local base ${base}`,
    async (f) => {
      await put(
        f.claude,
        JSON.stringify({ env: { ANTHROPIC_BASE_URL: base } }),
      );
      await setupClient("claude", f.config);
      await restoreClient("claude");
    },
  );
}
for (const base of [
  "http://127.0.0.1:8787",
  "https://gateway.example/anthropic",
  "https://api.anthropic.com.evil.test",
  "https://api.anthropic.com/other",
]) {
  scenario(
    `Claude refuses a previous bridge/gateway ${base} without writes`,
    async (f) => {
      const original = JSON.stringify({ env: { ANTHROPIC_BASE_URL: base } });
      await put(f.claude, original);
      await assert.rejects(
        setupClient("claude", f.config),
        /unsetup the prior integration first/i,
      );
      assert.equal(await readFile(f.claude, "utf8"), original);
      await absent(stateDir("claude"));
    },
  );
}
scenario(
  "Claude also refuses a conflicting process environment base",
  async (f) => {
    process.env.ANTHROPIC_BASE_URL = "http://localhost:9999";
    await assert.rejects(setupClient("claude", f.config), /prior integration/i);
    await absent(f.claude);
  },
);

scenario(
  "Codex default API-key provider preserves main settings and creates model-only roles",
  async (f) => {
    process.env.OPENAI_API_KEY = "test-key-not-saved";
    const original =
      '# Exact restore keeps comments and CRLF\r\nmodel = "gpt-main"\r\nmodel_reasoning_effort = "high"\r\napproval_policy = "on-request"\r\nweb_search = "live"\r\n[features]\r\nmulti_agent = false\r\nother_feature = true\r\n[agents]\r\nmax_threads = 6\r\n[projects."/tmp/project"]\r\ntrust_level = "trusted"\r\n[mcp_servers.demo]\r\ncommand = "demo"\r\nargs = ["--stdio"]\r\n[profiles.other]\r\nmodel_provider = "other"\r\nmodel = "other-model"\r\n[model_providers.other]\r\nname = "untouched"\r\nbase_url = "https://other.example/v1"\r\n';
    await put(f.codex, original);
    const authPath = join(dirname(f.codex), "auth.json");
    const auth = '{"auth_mode":"apikey","OPENAI_API_KEY":"saved-key"}\n';
    await put(authPath, auth);
    await setupClient("codex", f.config);
    const settings = await toml(f.codex);
    const before = parse(original);
    for (const key of [
      "model",
      "model_reasoning_effort",
      "approval_policy",
      "projects",
      "mcp_servers",
      "profiles",
    ])
      assert.deepEqual(settings[key], before[key]);
    assert.deepEqual(
      { ...(settings.features as Table) },
      {
        multi_agent: true,
        other_feature: true,
      },
    );
    assert.equal(settings.web_search, "disabled");
    const catalog = JSON.parse(
      await readFile(settings.model_catalog_json as string, "utf8"),
    );
    assert.ok(
      catalog.models.some(
        (m: Table) => m.slug === f.config.routes.codexSubagentModel,
      ),
    );
    assert.ok(
      catalog.models.every(
        (m: Table) =>
          m.tool_mode === "direct" && m.use_responses_lite === false,
      ),
    );
    assert.equal(settings.model_provider, "arelay");
    const providers = settings.model_providers as Record<string, Table>;
    assert.deepEqual(
      providers.other,
      (before.model_providers as Record<string, unknown>).other,
    );
    assert.deepEqual(
      { ...providers.arelay },
      {
        name: "arelay",
        base_url: `http://127.0.0.1:${f.config.port}/v1`,
        wire_api: "responses",
        requires_openai_auth: false,
        supports_websockets: false,
      },
    );
    const agents = await roles(f.codex);
    assert.equal(agents.max_threads, 6);
    for (const name of ["default", "explorer", "worker"]) {
      const role = agents[name]!;
      assert.equal(role.model_provider, undefined);
      const path = role.config_file as string;
      assert.ok(!relative(paths().state, path).startsWith(".."));
      const overrides = await toml(path);
      assert.deepEqual(
        { ...overrides },
        {
          model: f.config.routes.codexSubagentModel,
          model_reasoning_summary: "none",
          web_search: "disabled",
        },
      );
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
    }
    assert.equal(await readFile(authPath, "utf8"), auth);
    assert.ok(
      !(await readFile(f.codex, "utf8")).includes(process.env.OPENAI_API_KEY),
    );
    await restoreClient("codex");
    assert.deepEqual(await readFile(f.codex), Buffer.from(original));
    assert.equal(await readFile(authPath, "utf8"), auth);
    await absent(stateDir("codex"));
  },
);

scenario(
  "Codex retains explicit Responses provider identity, auth, headers and unrelated TOML",
  async (f) => {
    f.config.openai.baseUrl = "https://gateway.example/v1/";
    const original = `model = "my-main-model"\nmodel_provider = "gateway"\n[model_providers.gateway]\nname = "Existing gateway"\nbase_url = "https://gateway.example/v1"\nwire_api = "responses"\nenv_key = "GATEWAY_API_KEY"\nrequires_openai_auth = false\nsupports_websockets = true\nrequest_max_retries = 8\n[model_providers.gateway.env_http_headers]\nX-Tenant = "TENANT_ENV"\n[model_providers.gateway.http_headers]\nX-Custom = "value"\n[model_providers.gateway.query_params]\napi-version = "2025-01-01"\n[other]\nbig = 9223372036854775807\nratio = 1.0\nwhen = 1979-05-27T07:32:00-08:00\n`;
    await put(f.codex, original);
    await setupClient("codex", f.config);
    const settings = await toml(f.codex);
    assert.equal(settings.model, "my-main-model");
    assert.equal(settings.model_provider, "gateway");
    const provider = (settings.model_providers as Record<string, Table>)
      .gateway;
    const expected = (
      parse(original, { integersAsBigInt: "asNeeded" })
        .model_providers as Record<string, Table>
    ).gateway!;
    assert.deepEqual(
      { ...provider },
      {
        ...expected,
        base_url: `http://127.0.0.1:${f.config.port}/v1`,
        supports_websockets: false,
      },
    );
    const after = parse(await readFile(f.codex, "utf8"), {
      integersAsBigInt: true,
    });
    assert.deepEqual(
      after.other,
      parse(original, { integersAsBigInt: true }).other,
    );
    await restoreClient("codex");
    assert.deepEqual(await readFile(f.codex), Buffer.from(original));
  },
);

scenario(
  "Codex copies built-in and custom role files preserving instructions and other overrides",
  async (f) => {
    process.env.OPENAI_API_KEY = "test";
    const originalRole =
      '# Original instructions stay byte-exact\nmodel = "old-child"\ndeveloper_instructions = "Be precise.\\nDo not edit files."\nmodel_reasoning_effort = "low"\nmodel_reasoning_summary = "auto"\nmodel_verbosity = "low"\nweb_search = "live"\n[features]\nshell_tool = false\n';
    const explorerPath = join(dirname(f.codex), "roles", "explorer.toml");
    const reviewerPath = join(f.root, "custom", "reviewer.toml");
    await put(explorerPath, originalRole);
    await put(reviewerPath, originalRole);
    await put(
      f.codex,
      stringify({
        model: "gpt-main",
        agents: {
          max_depth: 3,
          default: { description: "my default" },
          explorer: {
            description: "careful explorer",
            config_file: "roles/explorer.toml",
          },
          reviewer: { description: "reviews code", config_file: reviewerPath },
          custom_worker: { description: "without an original file" },
        },
      }),
    );
    await setupClient("codex", f.config);
    const agents = await roles(f.codex);
    for (const name of ["explorer", "reviewer"]) {
      const overrides = await toml(agents[name]!.config_file as string);
      assert.deepEqual(
        { ...overrides },
        {
          ...parse(originalRole),
          model: f.config.routes.codexSubagentModel,
          model_reasoning_summary: "none",
          web_search: "disabled",
        },
      );
      assert.equal(Object.hasOwn(overrides, "model_provider"), false);
    }
    assert.equal(agents.explorer!.description, "careful explorer");
    assert.equal(agents.reviewer!.description, "reviews code");
    assert.equal(agents.default!.description, "my default");
    assert.equal(agents.custom_worker!.description, "without an original file");
    assert.equal(
      (await toml(agents.custom_worker!.config_file as string)).model,
      f.config.routes.codexSubagentModel,
    );
    assert.equal(await readFile(explorerPath, "utf8"), originalRole);
    assert.equal(await readFile(reviewerPath, "utf8"), originalRole);
    // Later edits to an original role file are not overwritten by restoration.
    await put(reviewerPath, originalRole + "\n# a later edit\n");
    await restoreClient("codex");
    assert.equal(
      await readFile(reviewerPath, "utf8"),
      originalRole + "\n# a later edit\n",
    );
  },
);

scenario(
  "Codex uses a configured API-key env name without writing the key",
  async (f) => {
    f.config.openai.apiKeyEnv = "ARELAY_TEST_OPENAI_KEY";
    process.env.ARELAY_TEST_OPENAI_KEY = "test-secret";
    await setupClient("codex", f.config);
    const settings = await toml(f.codex);
    assert.equal(
      ((settings.model_providers as Table).arelay as Table).env_key,
      undefined,
    );
    assert.equal(
      ((settings.model_providers as Table).arelay as Table)
        .requires_openai_auth,
      false,
    );
    assert.ok(!(await readFile(f.codex, "utf8")).includes("test-secret"));
  },
);

scenario(
  "Codex active profile retains its model and routes its selected provider",
  async (f) => {
    process.env.OPENAI_API_KEY = "test";
    await put(
      f.codex,
      'profile = "work"\nmodel = "root-model"\n[profiles.work]\nmodel = "profile-model"\nmodel_provider = "openai"\n[profiles.work.features]\nmulti_agent = false\nother = true\n',
    );
    await setupClient("codex", f.config);
    const settings = await toml(f.codex);
    assert.equal(settings.model, "root-model");
    const profile = (settings.profiles as Record<string, Table>).work!;
    assert.equal(profile.model, "profile-model");
    assert.equal(profile.model_provider, "arelay");
    assert.deepEqual(
      { ...(profile.features as Table) },
      { multi_agent: true, other: true },
    );
  },
);

const rejectedCodex: [string, string, RegExp][] = [
  [
    "mismatched custom backend",
    'model_provider = "gateway"\n[model_providers.gateway]\nbase_url = "https://gateway.example/v1"\nwire_api = "responses"\n',
    /base_url must match/,
  ],
  [
    "existing codex-bridge",
    'model_provider = "codex-bridge"\n[model_providers.codex-bridge]\nbase_url = "http://127.0.0.1:8787/v1"\nwire_api = "responses"\n',
    /unsetup the prior integration first/i,
  ],
  [
    "unknown bridge provider",
    'model_provider = "codex-bridge"\n',
    /prior integration/i,
  ],
  [
    "non-Responses API",
    'model_provider = "custom"\n[model_providers.custom]\nbase_url = "https://api.openai.com/v1"\nwire_api = "chat"\n',
    /wire_api/,
  ],
  [
    "unspecified custom wire API",
    'model_provider = "custom"\n[model_providers.custom]\nbase_url = "https://api.openai.com/v1"\n',
    /wire_api/,
  ],
  [
    "forced subscription",
    'forced_login_method = "chatgpt"\n',
    /ChatGPT subscription/,
  ],
  [
    "provider collision",
    '[model_providers.arelay]\nname = "existing provider"\n',
    /already exists/,
  ],
];
for (const [label, original, error] of rejectedCodex) {
  scenario(`Codex safely rejects ${label}`, async (f) => {
    process.env.OPENAI_API_KEY = "test";
    await put(f.codex, original);
    await assert.rejects(setupClient("codex", f.config), error);
    assert.equal(await readFile(f.codex, "utf8"), original);
    await absent(stateDir("codex"));
  });
}

scenario(
  "Codex subscription/default login without environment API key is rejected",
  async (f) => {
    const auth =
      '{"auth_mode":"chatgpt","tokens":{"access_token":"subscription-token"}}';
    await put(join(dirname(f.codex), "auth.json"), auth);
    await assert.rejects(
      setupClient("codex", f.config),
      /ChatGPT subscription authentication cannot be transparently proxied/,
    );
    await absent(f.codex);
    assert.equal(
      await readFile(join(dirname(f.codex), "auth.json"), "utf8"),
      auth,
    );
  },
);
scenario(
  "Codex first-party custom provider requires explicit API-key auth",
  async (f) => {
    await put(
      f.codex,
      'model_provider = "custom"\n[model_providers.custom]\nbase_url = "https://api.openai.com/v1"\nwire_api = "responses"\nrequires_openai_auth = true\n',
    );
    const original = await readFile(f.codex, "utf8");
    await assert.rejects(
      setupClient("codex", f.config),
      /configure its env_key/,
    );
    process.env.OPENAI_API_KEY = "test";
    await assert.rejects(
      setupClient("codex", f.config),
      /Existing auth will not be replaced/,
    );
    assert.equal(await readFile(f.codex, "utf8"), original);
    await put(f.codex, original + 'env_key = "OPENAI_API_KEY"\n');
    await setupClient("codex", f.config);
    const provider = (
      (await toml(f.codex)).model_providers as Record<string, Table>
    ).custom!;
    assert.equal(provider.env_key, "OPENAI_API_KEY");
    assert.equal(provider.requires_openai_auth, true);
  },
);
scenario(
  "Codex refuses a ChatGPT backend even if configured as arelay's upstream",
  async (f) => {
    f.config.openai.baseUrl = "https://chatgpt.com/backend-api/codex";
    await put(
      f.codex,
      stringify({
        model_provider: "chatgpt",
        model_providers: {
          chatgpt: {
            base_url: f.config.openai.baseUrl,
            wire_api: "responses",
            env_key: "OPENAI_API_KEY",
          },
        },
      }),
    );
    await assert.rejects(
      setupClient("codex", f.config),
      /ChatGPT subscription endpoints/,
    );
  },
);
scenario(
  "Codex refuses a default-provider OPENAI_BASE_URL mismatch",
  async (f) => {
    process.env.OPENAI_API_KEY = "test";
    process.env.OPENAI_BASE_URL = "http://localhost:8787/v1";
    await assert.rejects(setupClient("codex", f.config), /prior integration/i);
    await absent(f.codex);
  },
);

for (const client of ["claude", "codex"] as const) {
  scenario(
    `${client} removes a newly created config, supports idempotent setup/restore`,
    async (f) => {
      process.env.OPENAI_API_KEY = "test";
      await restoreClient(client);
      assert.deepEqual(await setupClient(client, f.config), { changed: true });
      const installed = await readFile(f[client]);
      const state = await snapshots(stateDir(client));
      assert.deepEqual(await setupClient(client, structuredClone(f.config)), {
        changed: false,
      });
      assert.deepEqual(await readFile(f[client]), installed);
      assert.deepEqual(await snapshots(stateDir(client)), state);
      await restoreClient(client);
      await absent(f[client]);
      await absent(stateDir(client));
      await restoreClient(client);
    },
  );
  scenario(
    `${client} repeated setup keeps the original backup, and refuses changed parameters`,
    async (f) => {
      process.env.OPENAI_API_KEY = "test";
      const original =
        client === "claude"
          ? '{ "model": "main" }\n'
          : '# original\nmodel = "main"\n';
      await put(f[client], original);
      await setupClient(client, f.config);
      const state = await snapshots(stateDir(client));
      await setupClient(client, f.config);
      assert.deepEqual(await snapshots(stateDir(client)), state);
      f.config.port += 1;
      await assert.rejects(setupClient(client, f.config), /parameters changed/);
      await previewWithoutChanges(f, client, "blocked", /parameters changed/);
      await restoreClient(client);
      assert.deepEqual(await readFile(f[client]), Buffer.from(original));
    },
  );
  scenario(
    `${client} refuses setup and restoration after installed bytes are edited or deleted`,
    async (f) => {
      process.env.OPENAI_API_KEY = "test";
      await setupClient(client, f.config);
      const installed = await readFile(f[client]);
      const state = await snapshots(stateDir(client));
      await writeFile(f[client], Buffer.concat([installed, Buffer.from("\n")]));
      await assert.rejects(restoreClient(client), /changed since setup/);
      await assert.rejects(
        setupClient(client, f.config),
        /changed since setup/,
      );
      assert.deepEqual(await snapshots(stateDir(client)), state);
      await previewWithoutChanges(f, client, "blocked", /changed since setup/);
      await rm(f[client]);
      await previewWithoutChanges(f, client, "blocked", /changed since setup/);
      await assert.rejects(restoreClient(client), /changed since setup/);
      await writeFile(f[client], installed);
      await restoreClient(client);
      await absent(f[client]);
    },
  );
  scenario(
    `${client} refuses corrupt backups instead of erasing the installed config`,
    async (f) => {
      process.env.OPENAI_API_KEY = "test";
      await put(f[client], client === "claude" ? "{}" : "# original\n");
      await setupClient(client, f.config);
      const installed = await readFile(f[client]);
      await put(join(stateDir(client), "original.backup"), "corrupt");
      await assert.rejects(
        restoreClient(client),
        /backup is missing or corrupt/,
      );
      assert.deepEqual(await readFile(f[client]), installed);
    },
  );
}

scenario(
  "Codex refuses to erase edited generated agent configurations",
  async (f) => {
    process.env.OPENAI_API_KEY = "test";
    await setupClient("codex", f.config);
    const role = (await roles(f.codex)).worker!.config_file as string;
    const installed = await readFile(role, "utf8");
    await put(role, installed + "\n# later edit\n");
    await assert.rejects(
      restoreClient("codex"),
      /generated agent config changed/,
    );
    await assert.rejects(
      setupClient("codex", f.config),
      /generated agent config changed/,
    );
    await previewWithoutChanges(
      f,
      "codex",
      "blocked",
      /generated agent config changed/,
    );
    await put(role, installed);
    await restoreClient("codex");
    await absent(role);
  },
);

for (const [label, original] of [
  ["malformed TOML", "model = ["],
  [
    "missing role source",
    '[agents.reviewer]\nconfig_file = "does-not-exist.toml"\n',
  ],
  ["unsafe role name", '[agents."../../escape"]\ndescription = "unsafe"\n'],
  ["malformed builtin role", '[agents]\nworker = "not a table"\n'],
] as const) {
  scenario(
    `Codex prevalidates ${label} before changing the user config`,
    async (f) => {
      process.env.OPENAI_API_KEY = "test";
      await put(f.codex, original);
      await assert.rejects(setupClient("codex", f.config));
      assert.equal(await readFile(f.codex, "utf8"), original);
      await absent(stateDir("codex"));
      assert.deepEqual(await readdir(paths().state), []);
    },
  );
}
scenario(
  "Codex prevalidates every role source before writing any generated files",
  async (f) => {
    process.env.OPENAI_API_KEY = "test";
    const source = join(dirname(f.codex), "invalid.toml");
    await put(source, "model = [");
    const original = '[agents.reviewer]\nconfig_file = "invalid.toml"\n';
    await put(f.codex, original);
    await assert.rejects(setupClient("codex", f.config));
    assert.equal(await readFile(f.codex, "utf8"), original);
    assert.equal(await readFile(source, "utf8"), "model = [");
    await absent(stateDir("codex"));
  },
);
for (const original of ["[]", "null", '{"env":[]}', '{"env":null}', "{"]) {
  scenario(
    `Claude rejects invalid settings ${original} without changes`,
    async (f) => {
      await put(f.claude, original);
      await assert.rejects(setupClient("claude", f.config));
      assert.equal(await readFile(f.claude, "utf8"), original);
      await absent(stateDir("claude"));
    },
  );
}
scenario(
  "Setup refuses symlinked client files rather than replacing them",
  async (f) => {
    const source = join(f.root, "linked-settings.json");
    await put(source, "{}");
    await mkdir(dirname(f.claude), { recursive: true });
    await symlink(source, f.claude);
    await assert.rejects(setupClient("claude", f.config), /non-regular file/);
    assert.equal(await readFile(source, "utf8"), "{}");
  },
);
scenario("Restore requires the original configuration directory", async (f) => {
  await setupClient("claude", f.config);
  process.env.CLAUDE_CONFIG_DIR = join(f.root, "different-claude");
  await assert.rejects(restoreClient("claude"), /directory changed/);
  await absent(join(process.env.CLAUDE_CONFIG_DIR, "settings.json"));
  process.env.CLAUDE_CONFIG_DIR = dirname(f.claude);
  await restoreClient("claude");
});
scenario(
  "A failed final write leaves the original config and no staged installation",
  async (f) => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const original = '{ "model": "main" }\n';
    await put(f.claude, original);
    await chmod(dirname(f.claude), 0o500);
    try {
      await assert.rejects(setupClient("claude", f.config), { code: "EACCES" });
      assert.equal(await readFile(f.claude, "utf8"), original);
      await absent(stateDir("claude"));
      assert.deepEqual(await readdir(paths().state), []);
    } finally {
      await chmod(dirname(f.claude), 0o700);
    }
  },
);
scenario("Non-UTF-8 configuration cannot produce a lossy backup", async (f) => {
  await mkdir(dirname(f.claude), { recursive: true });
  const original = Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]);
  await writeFile(f.claude, original);
  await assert.rejects(setupClient("claude", f.config), /valid UTF-8/);
  assert.deepEqual(await readFile(f.claude), original);
  await absent(stateDir("claude"));
});
for (const client of ["claude", "codex"] as const) {
  scenario(
    `${client} preview is read-only for fresh and managed installations`,
    async (f) => {
      const availableKeys: ReadonlySet<string> = new Set([
        f.config.openai.apiKeyEnv,
      ]);
      await previewWithoutChanges(f, client, "ready", undefined, availableKeys);
      await absent(paths().state);
      await absent(dirname(f[client]));
      assert.deepEqual(await setupClient(client, f.config, { availableKeys }), {
        changed: true,
      });
      await chmod(paths().state, 0o755);
      await previewWithoutChanges(
        f,
        client,
        "managed",
        undefined,
        availableKeys,
      );
      assert.equal((await stat(paths().state)).mode & 0o777, 0o755);
      assert.deepEqual(await setupClient(client, f.config, { availableKeys }), {
        changed: false,
      });
    },
  );

  for (const kind of ["directory", "file", "dangling symlink"] as const) {
    scenario(
      `${client} preview safely blocks an existing ${kind} lock`,
      async (f) => {
        process.env.OPENAI_API_KEY = "test";
        await mkdir(paths().state, { recursive: true, mode: 0o755 });
        await chmod(paths().state, 0o755);
        const lock = join(paths().state, `${client}-setup.lock`);
        if (kind === "directory") await mkdir(lock);
        else if (kind === "file") await writeFile(lock, "do not remove");
        else await symlink(join(f.root, "missing-lock-target"), lock);
        await previewWithoutChanges(f, client, "blocked", /lock|running/i);
        await absent(f[client]);
      },
    );
  }

  for (const kind of ["state", "setup"] as const) {
    scenario(
      `${client} preview blocks a symlinked ${kind} directory without chmod`,
      async (f) => {
        process.env.OPENAI_API_KEY = "test";
        const outside = join(f.root, "linked-directory");
        await mkdir(outside, { mode: 0o755 });
        await put(join(outside, "keep"), "untouched");
        const link = kind === "state" ? paths().state : stateDir(client);
        await mkdir(dirname(link), { recursive: true });
        await symlink(outside, link);
        await previewWithoutChanges(f, client, "blocked", /symlink|directory/i);
        await absent(f[client]);
      },
    );
  }
}

for (const source of ["availableKeys", "environment"] as const) {
  scenario(
    `Codex generated provider accepts only its configured key from ${source} without environment mutation`,
    async (f) => {
      f.config.openai.apiKeyEnv = "ARELAY_TEST_OPENAI_KEY";
      const availableKeys: ReadonlySet<string> = new Set(
        source === "availableKeys" ? [f.config.openai.apiKeyEnv] : [],
      );
      if (source === "environment")
        process.env.ARELAY_TEST_OPENAI_KEY = "secret-not-saved";
      const environment = { ...process.env };
      await previewWithoutChanges(
        f,
        "codex",
        "ready",
        undefined,
        availableKeys,
      );
      assert.deepEqual(
        await setupClient("codex", f.config, { availableKeys }),
        { changed: true },
      );
      assertEnvironmentUnchanged(environment);
      assert.deepEqual(
        [...availableKeys],
        source === "availableKeys" ? [f.config.openai.apiKeyEnv] : [],
      );
      const provider = (
        (await toml(f.codex)).model_providers as Record<string, Table>
      ).arelay!;
      assert.equal(Object.hasOwn(provider, "env_key"), false);
      assert.equal(provider.requires_openai_auth, false);
      for (const bytes of Object.values(await snapshots(f.root)))
        assert.equal(bytes.includes("secret-not-saved"), false);
    },
  );
}

scenario(
  "Codex generated provider never falls back to OPENAI_API_KEY for a different configured env",
  async (f) => {
    f.config.openai.apiKeyEnv = "ARELAY_TEST_OPENAI_KEY";
    process.env.OPENAI_API_KEY = "wrong-key";
    process.env.ARELAY_TEST_OPENAI_KEY = "  ";
    const availableKeys: ReadonlySet<string> = new Set(["OPENAI_API_KEY"]);
    const environment = { ...process.env };
    await previewWithoutChanges(
      f,
      "codex",
      "blocked",
      /ARELAY_TEST_OPENAI_KEY/,
      availableKeys,
    );
    await absent(paths().state);
    await assert.rejects(
      setupClient("codex", f.config, { availableKeys }),
      /ARELAY_TEST_OPENAI_KEY/,
    );
    assertEnvironmentUnchanged(environment);
    await absent(f.codex);
    await absent(stateDir("codex"));
  },
);

scenario(
  "A failed final write with target drift preserves recovery data and later edits",
  async (f) => {
    const original = '{ "model": "main" }\n';
    const drift = '{ "model": "concurrent edit" }\n';
    await put(f.claude, original);
    const rename = fs.rename;
    const write = fs.writeFile;
    let injected = false;
    const spy = mock.method(
      fs,
      "rename",
      async (...args: Parameters<typeof fs.rename>) => {
        if (String(args[1]) === f.claude) {
          injected = true;
          await write(f.claude, drift);
          throw Object.assign(new Error("injected final write failure"), {
            code: "EIO",
          });
        }
        return rename(...args);
      },
    );
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        setupClient("claude", f.config),
        /injected final write failure/,
      );
    } finally {
      spy.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(injected, true);
    assert.equal(await readFile(f.claude, "utf8"), drift);
    assert.equal(
      await readFile(join(stateDir("claude"), "original.backup"), "utf8"),
      original,
    );
    assert.ok(
      (await json(join(stateDir("claude"), "installation.json"))).installedHash,
    );
    await absent(join(paths().state, "claude-setup.lock"));
    const before = await filesystemSnapshot(f.root);
    await previewWithoutChanges(f, "claude", "blocked", /changed since setup/);
    await assert.rejects(
      setupClient("claude", f.config),
      /changed since setup/,
    );
    await assert.rejects(restoreClient("claude"), /changed since setup/);
    assert.deepEqual(await filesystemSnapshot(f.root), before);
  },
);

scenario("Client installations and restores are independent", async (f) => {
  process.env.OPENAI_API_KEY = "test";
  await setupClient("claude", f.config);
  await setupClient("codex", f.config);
  const codex = await readFile(f.codex);
  await restoreClient("claude");
  assert.deepEqual(await readFile(f.codex), codex);
  await restoreClient("codex");
  await absent(f.claude);
  await absent(f.codex);
});
