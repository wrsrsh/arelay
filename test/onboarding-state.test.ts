import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { parse } from "smol-toml";
import { atomicWrite, defaultConfig, paths } from "../src/config.js";
import {
  createWizardServices,
  mergeCredentials,
  validateCredential,
} from "../src/onboarding/state.js";
import { setupClient } from "../src/setup.js";
import type { WizardPlan } from "../src/onboarding/types.js";

const envKeys = [
  "ARELAY_HOME",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_BASE_URL",
  "ANTHROPIC_BASE_URL",
];
function scenario(name: string, run: (root: string) => Promise<void>): void {
  test(name, { concurrency: false }, async () => {
    const saved = envKeys.map((key) => [key, process.env[key]] as const);
    const root = await mkdtemp(join(tmpdir(), "arelay-onboarding-"));
    try {
      for (const key of envKeys) delete process.env[key];
      process.env.ARELAY_HOME = join(root, "arelay");
      process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
      process.env.CODEX_HOME = join(root, "codex");
      await run(root);
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
}
const services = () =>
  createWizardServices({
    platform: "darwin",
    keychain: async () => false,
    service: async () => {
      throw new Error("A test must explicitly inject a service runner");
    },
  });
const plan = (): WizardPlan => ({
  config: structuredClone(defaultConfig),
  credentials: {
    OPENAI_API_KEY: "new-openai-secret",
    ANTHROPIC_API_KEY: "new-anthropic-secret",
  },
  clients: ["claude", "codex"],
  startService: false,
});
async function put(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
}
async function absent(path: string): Promise<void> {
  await assert.rejects(stat(path), { code: "ENOENT" });
}

scenario(
  "load and preview/cancel create no directories or environment changes",
  async (root) => {
    const api = services();
    const initial = await api.load();
    assert.equal(initial.existing, false);
    initial.config.port++;
    assert.equal((await api.load()).config.port, defaultConfig.port);
    assert.equal(
      (await api.preview("claude", defaultConfig, new Set())).status,
      "ready",
    );
    assert.equal(
      (await api.preview("codex", defaultConfig, new Set(["OPENAI_API_KEY"])))
        .status,
      "ready",
    );
    assert.equal(
      (await api.preview("codex", defaultConfig, new Set())).status,
      "blocked",
    );
    assert.equal(await api.credential("OPENAI_API_KEY"), undefined);
    assert.deepEqual(await readdir(root), []);
    assert.equal(process.env.OPENAI_API_KEY, undefined);
  },
);
scenario(
  "load preserves existing config, modes, and rejects invalid config instead of replacing it",
  async () => {
    const config = structuredClone(defaultConfig);
    config.port = 9123;
    const original = JSON.stringify(config);
    await put(paths().config, original);
    await chmod(paths().config, 0o640);
    const initial = await services().load();
    assert.equal(initial.existing, true);
    assert.deepEqual(initial.config, config);
    await services().preview("claude", config, new Set());
    assert.equal((await stat(paths().config)).mode & 0o777, 0o640);
    assert.equal(await readFile(paths().config, "utf8"), original);
    await put(paths().config, "{");
    await assert.rejects(services().load());
    assert.equal(await readFile(paths().config, "utf8"), "{");
    await absent(paths().state);
  },
);
scenario(
  "Codex discovery honors active profile and imports no auth/header secrets",
  async () => {
    await put(
      join(process.env.CODEX_HOME!, "config.toml"),
      'profile = "work"\nmodel = "root-model"\nmodel_provider = "unused"\n[profiles.work]\nmodel = "profile-model"\nmodel_provider = "gateway"\n[model_providers.gateway]\nbase_url = "https://gateway.example/v1"\nwire_api = "responses"\nenv_key = "GATEWAY_KEY"\n[model_providers.gateway.http_headers]\nAuthorization = "never-import-this"\n',
    );
    assert.deepEqual((await services().load()).codexBackend, {
      baseUrl: "https://gateway.example/v1",
      model: "profile-model",
      apiKeyEnv: "GATEWAY_KEY",
      authHeader: "authorization",
    });
    await absent(paths().dir);
  },
);
scenario(
  "credential metadata prefers persistent file/Keychain over env, never leaks or chmods",
  async () => {
    process.env.OPENAI_API_KEY = "environment-secret";
    let lookups = 0;
    const api = createWizardServices({
      platform: "darwin",
      keychain: async (name) => {
        lookups++;
        return name === "OPENAI_API_KEY";
      },
      service: async () => {},
    });
    assert.deepEqual(await api.credential("OPENAI_API_KEY"), {
      source: "Keychain",
      persistent: true,
    });
    assert.equal(lookups, 1);
    assert.deepEqual(await services().credential("OPENAI_API_KEY"), {
      source: "environment",
      persistent: false,
    });
    await put(
      paths().credentials,
      '# keep\nOTHER=untouched\nOPENAI_API_KEY="file-secret"\n',
    );
    await chmod(paths().credentials, 0o644);
    assert.deepEqual(await api.credential("OPENAI_API_KEY"), {
      source: "credentials file",
      persistent: true,
    });
    assert.equal(lookups, 1);
    assert.equal((await stat(paths().credentials)).mode & 0o777, 0o644);
    assert.equal(process.env.OPENAI_API_KEY, "environment-secret");
  },
);
test("dotenv merges preserve comments/unrelated lines and collapse duplicates without evaluation", () => {
  const original =
    '# keep\r\nOTHER="keep me"\r\nOPENAI_API_KEY=old\r\nOPENAI_API_KEY=duplicate\r\n# tail';
  assert.equal(
    mergeCredentials(original, {
      OPENAI_API_KEY: "$(touch-not-run);x",
      ANTHROPIC_API_KEY: "new",
    }),
    '# keep\r\nOTHER="keep me"\r\nOPENAI_API_KEY=$(touch-not-run);x\r\n# tail\r\nANTHROPIC_API_KEY=new\r\n',
  );
  for (const value of [
    "",
    "bad secret",
    "bad\rsecret",
    "bad\nsecret",
    "bad\0secret",
    'bad"secret',
    "bad'secret",
  ]) {
    assert.throws(
      () => validateCredential("OPENAI_API_KEY", value),
      (error) => error instanceof Error && !error.message.includes("bad"),
    );
  }
});
scenario(
  "successful apply persists private credentials, never emits secrets in config/client/metadata",
  async () => {
    let installed = 0;
    const api = createWizardServices({
      platform: "linux",
      keychain: async () => false,
      service: async (action) => {
        assert.equal(action, "install");
        installed++;
      },
    });
    await put(
      paths().credentials,
      "# keep\nUNRELATED=keep\nOPENAI_API_KEY=old\nOPENAI_API_KEY=older\n",
    );
    const input = plan();
    input.startService = true;
    assert.deepEqual(await api.apply(input), { service: "started" });
    assert.equal(installed, 1);
    assert.equal((await stat(paths().credentials)).mode & 0o777, 0o600);
    assert.equal(
      await readFile(paths().credentials, "utf8"),
      "# keep\nUNRELATED=keep\nOPENAI_API_KEY=new-openai-secret\nANTHROPIC_API_KEY=new-anthropic-secret\n",
    );
    for (const path of [
      paths().config,
      join(paths().state, "codex-setup", "installation.json"),
      join(paths().state, "claude-setup", "installation.json"),
      join(process.env.CODEX_HOME!, "config.toml"),
    ]) {
      const content = await readFile(path, "utf8");
      for (const value of Object.values(input.credentials))
        assert.ok(!content.includes(value));
    }
    const codex = parse(
      await readFile(join(process.env.CODEX_HOME!, "config.toml"), "utf8"),
    );
    const provider = (
      codex.model_providers as Record<string, Record<string, unknown>>
    ).arelay!;
    assert.equal(provider.env_key, undefined);
    assert.equal(provider.requires_openai_auth, false);
    assert.equal(process.env.OPENAI_API_KEY, undefined);
    assert.equal(
      (await api.preview("codex", input.config, new Set())).status,
      "managed",
    );
  },
);
for (const managed of [false, true])
  scenario(
    `second-client failure restores only newly configured clients (previously managed=${managed})`,
    async () => {
      const input = plan();
      const original = JSON.stringify(defaultConfig) + "\n";
      await put(paths().config, original);
      await put(paths().credentials, "# original\nOPENAI_API_KEY=old\n");
      if (managed) await setupClient("claude", input.config);
      const claudePath = join(process.env.CLAUDE_CONFIG_DIR!, "settings.json");
      const claude = managed ? await readFile(claudePath) : null;
      const api = createWizardServices({
        platform: "linux",
        keychain: async () => false,
        service: async () => {},
        setup: async (client, config, options) => {
          if (client === "codex") throw new Error("new-openai-secret");
          return setupClient(client, config, options);
        },
      });
      await assert.rejects(api.apply(input), /changes were rolled back/);
      if (claude) assert.deepEqual(await readFile(claudePath), claude);
      else await absent(claudePath);
      assert.equal(await readFile(paths().config, "utf8"), original);
      assert.equal(
        await readFile(paths().credentials, "utf8"),
        "# original\nOPENAI_API_KEY=old\n",
      );
      await absent(join(process.env.CODEX_HOME!, "config.toml"));
    },
  );
scenario(
  "rollback removes new config/credentials after a committed write reports failure",
  async () => {
    let writes = 0;
    const api = createWizardServices({
      platform: "linux",
      keychain: async () => false,
      service: async () => {},
      write: async (path, content) => {
        await atomicWrite(path, content);
        if (++writes === 2) throw new Error("post-rename failure");
      },
    });
    await assert.rejects(api.apply(plan()), /rolled back/);
    await absent(paths().config);
    await absent(paths().credentials);
  },
);
scenario(
  "rollback preserves concurrent file edits and explicit private recovery backups",
  async () => {
    await put(paths().config, JSON.stringify(defaultConfig));
    await put(paths().credentials, "OPENAI_API_KEY=original-secret\n");
    const api = createWizardServices({
      platform: "linux",
      keychain: async () => false,
      service: async () => {},
      setup: async () => {
        await writeFile(
          paths().credentials,
          "OPENAI_API_KEY=concurrent-secret\n",
        );
        throw new Error("sensitive failure");
      },
    });
    await assert.rejects(
      api.apply(plan()),
      (error) =>
        error instanceof Error &&
        /Could not restore/.test(error.message) &&
        /snapshots saved privately/.test(error.message) &&
        !error.message.includes("secret"),
    );
    assert.equal(
      await readFile(paths().credentials, "utf8"),
      "OPENAI_API_KEY=concurrent-secret\n",
    );
    const backup = (await readdir(paths().dir)).find((name) =>
      name.startsWith("onboarding-recovery-"),
    )!;
    assert.equal(
      await readFile(
        join(paths().dir, backup, "credentials.env.backup"),
        "utf8",
      ),
      "OPENAI_API_KEY=original-secret\n",
    );
    assert.equal(
      (await stat(join(paths().dir, backup, "credentials.env.backup"))).mode &
        0o777,
      0o600,
    );
  },
);
scenario(
  "service failure is separate and does not roll back committed files",
  async () => {
    const input = plan();
    input.startService = true;
    const result = await services().apply(input);
    assert.equal(result.service, "failed");
    assert.match(result.message!, /Configuration was saved/);
    assert.ok(!result.message!.includes("explicitly inject"));
    assert.equal(
      (await services().preview("claude", input.config, new Set())).status,
      "managed",
    );
    assert.deepEqual(
      JSON.parse(await readFile(paths().config, "utf8")),
      input.config,
    );
  },
);
