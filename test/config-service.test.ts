import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  atomicWrite,
  defaultConfig,
  initConfig,
  validateConfig,
} from "../src/config.js";
import {
  bootstrapWithRetry,
  launchAgent,
  systemdUnit,
} from "../src/service.js";
import { codexCatalog } from "../src/catalog.js";

for (const [name, edit] of Object.entries({
  port: (c: typeof defaultConfig) => {
    c.port = 0;
  },
  http: (c: typeof defaultConfig) => {
    c.openai.baseUrl = "http://remote.example/v1";
  },
  credentials: (c: typeof defaultConfig) => {
    c.openai.baseUrl = "https://user:secret@api.example/v1";
  },
  loop: (c: typeof defaultConfig) => {
    c.openai.baseUrl = `http://127.0.0.1:${c.port}/v1`;
  },
  aliases: (c: typeof defaultConfig) => {
    c.routes.codexSubagentModel = c.routes.claudeSubagentModel;
  },
  limit: (c: typeof defaultConfig) => {
    c.maxBodyBytes = -1;
  },
  env: (c: typeof defaultConfig) => {
    c.openai.apiKeyEnv = "secret-value";
  },
}))
  test(`Config rejects invalid ${name}`, () => {
    const c = structuredClone(defaultConfig);
    edit(c);
    assert.throws(() => validateConfig(c));
  });
test("Private atomic config initialization is idempotent and never stores keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "arelay-config-"));
  const before = process.env.ARELAY_HOME;
  process.env.ARELAY_HOME = dir;
  try {
    await initConfig();
    const file = join(dir, "config.json");
    const original = await readFile(file, "utf8");
    await initConfig();
    assert.equal(await readFile(file, "utf8"), original);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    await atomicWrite(file, original);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), defaultConfig);
  } finally {
    if (before === undefined) delete process.env.ARELAY_HOME;
    else process.env.ARELAY_HOME = before;
    await rm(dir, { recursive: true, force: true });
  }
});
test("LaunchAgent uses foreground process, auto-restart and correctly escaped paths", async () => {
  const spec = {
    node: "/path with space/node",
    cli: "/app/a&b/arelay.mjs",
    home: "/home/arelay",
    logs: "/home/logs",
  };
  const output = launchAgent(spec);
  assert.match(output, /a&amp;b/);
  assert.match(output, /<key>KeepAlive<\/key><true\/>/);
  assert.ok(!output.includes("nohup"));
  if (process.platform === "darwin") {
    const dir = await mkdtemp(join(tmpdir(), "arelay-plist-"));
    try {
      const path = join(dir, "test.plist");
      await writeFile(path, output);
      execFileSync("plutil", ["-lint", path]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});
test("systemd unit escapes path expansion and uses a user login service", () => {
  const output = systemdUnit({
    node: "/node/$path%/bin/node",
    cli: '/app/quoted"/arelay.mjs',
    home: "/home/$dollar%/arelay",
    logs: "/logs",
  });
  assert.match(output, /\$\$path%%/);
  assert.match(output, /Environment="ARELAY_HOME=\/home\/\$dollar%%/);
  assert.match(output, /Restart=on-failure/);
  assert.match(output, /WantedBy=default.target/);
  assert.throws(
    () =>
      launchAgent({
        node: "/node\nmalicious",
        cli: "/app",
        home: "/home",
        logs: "/logs",
      }),
    /control characters/,
  );
});
test("launchd registration retries transient teardown failures without repeating successful work", async () => {
  let calls = 0;
  const delays: number[] = [];
  await bootstrapWithRetry(
    async () => {
      calls++;
      if (calls < 3) throw new Error("registration not released");
    },
    async (ms) => {
      delays.push(ms);
    },
  );
  assert.equal(calls, 3);
  assert.deepEqual(delays, [150, 300]);
});

test("launchd registration preserves permanent errors after bounded retries", async () => {
  let calls = 0;
  const failure = new Error("invalid agent");
  await assert.rejects(
    bootstrapWithRetry(
      async () => {
        calls++;
        throw failure;
      },
      async () => {},
    ),
    (error) => error === failure,
  );
  assert.equal(calls, 5);
});

test("successful launchd registration is not retried", async () => {
  let calls = 0;
  await bootstrapWithRetry(
    async () => {
      calls++;
    },
    async () => {
      assert.fail("unexpected retry");
    },
  );
  assert.equal(calls, 1);
});

test("Codex catalog preserves custom main metadata and registers a routable Claude model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "arelay-catalog-"));
  try {
    const path = join(dir, "models.json");
    await writeFile(
      path,
      JSON.stringify({
        models: [
          {
            slug: "my-main",
            custom_flag: true,
            tool_mode: "code_mode_only",
            use_responses_lite: true,
          },
        ],
      }),
    );
    const result = JSON.parse(
      await codexCatalog(
        defaultConfig,
        "models.json",
        join(dir, "config.toml"),
      ),
    );
    assert.equal(result.models[0].slug, "my-main");
    assert.equal(result.models[0].custom_flag, true);
    assert.equal(result.models[0].tool_mode, "direct");
    assert.equal(
      result.models[1].slug,
      defaultConfig.routes.codexSubagentModel,
    );
    assert.equal(result.models[1].apply_patch_tool_type, "freeform");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
