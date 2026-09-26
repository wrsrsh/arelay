import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import {
  agentPath,
  connectNativeClient,
  disconnectNativeClient,
  previewNativeClient,
} from "../src/native/connect.js";
import { claudeSubagent, codexAgentRole } from "../src/native/agents.js";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "arelay-connect-"));
  const before = {
    ARELAY_HOME: process.env.ARELAY_HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    CODEX_HOME: process.env.CODEX_HOME,
  };
  process.env.ARELAY_HOME = join(root, "arelay");
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
  process.env.CODEX_HOME = join(root, "codex");
  t.after(async () => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    opts: {
      node: "/usr/bin/node",
      cli: "/opt/arelay.mjs",
      home: process.env.ARELAY_HOME,
    },
    claude: join(process.env.CLAUDE_CONFIG_DIR, ".claude.json"),
    codex: join(process.env.CODEX_HOME, "config.toml"),
  };
}
for (const client of ["claude", "codex"] as const)
  test(`${client} native registration is reversible and preserves unrelated settings`, async (t) => {
    const f = await fixture(t),
      path = f[client];
    await mkdir(join(f.root, client), { recursive: true });
    await writeFile(
      path,
      client === "claude"
        ? JSON.stringify({
            oauthAccount: { private: "DONT_COPY_ME" },
            mcpServers: { other: { command: "other" } },
          })
        : 'model="original"\n[model_providers.keep]\nname="original-provider"\n',
    );
    assert.equal((await previewNativeClient(client, f.opts)).status, "ready");
    assert.deepEqual(await connectNativeClient(client, f.opts), {
      changed: true,
    });
    assert.deepEqual(await connectNativeClient(client, f.opts), {
      changed: false,
    });
    const parseFile = async () =>
      client === "claude"
        ? JSON.parse(await readFile(path, "utf8"))
        : parse(await readFile(path, "utf8"));
    const data = await parseFile();
    const key = client === "claude" ? "mcpServers" : "mcp_servers";
    assert.deepEqual(data[key].arelay.args, [
      "/opt/arelay.mjs",
      "mcp",
      "--client",
      client,
    ]);
    assert.ok(
      !(
        await readFile(
          join(f.opts.home, "state", `native-${client}.json`),
          "utf8",
        )
      ).includes("DONT_COPY_ME"),
    );
    const agent = agentPath(client);
    assert.equal(
      agent,
      join(
        f.root,
        client,
        "agents",
        client === "claude" ? "codex.md" : "claude.toml",
      ),
    );
    assert.equal(
      await readFile(agent, "utf8"),
      client === "claude" ? claudeSubagent() : codexAgentRole(),
    );
    assert.equal(
      (await previewNativeClient(client, f.opts)).message,
      "Connected",
    );
    data.new_setting = "later edit";
    await writeFile(
      path,
      client === "claude" ? JSON.stringify(data) : stringify(data),
    );
    await disconnectNativeClient(client);
    const restored = await parseFile();
    assert.equal(restored.new_setting, "later edit");
    assert.equal(restored[key]?.arelay, undefined);
    await assert.rejects(readFile(agent), { code: "ENOENT" });
    if (client === "claude")
      assert.equal(restored.oauthAccount.private, "DONT_COPY_ME");
    else assert.equal(restored.model, "original");
  });
test("Preview is read-only and refuses unowned servers or an existing API setup", async (t) => {
  const f = await fixture(t);
  assert.equal((await previewNativeClient("claude", f.opts)).status, "ready");
  assert.deepEqual(await readdir(f.root), []);
  await mkdir(join(f.root, "claude"));
  await writeFile(
    f.claude,
    '{"mcpServers":{"arelay":{"command":"someone-else"}}}',
  );
  assert.equal((await previewNativeClient("claude", f.opts)).status, "blocked");
  await mkdir(join(f.opts.home, "state", "codex-setup"), { recursive: true });
  assert.match(
    (await previewNativeClient("codex", f.opts)).message,
    /unsetup codex/,
  );
});
test("Disconnect refuses to erase an edited owned entry", async (t) => {
  const f = await fixture(t);
  await connectNativeClient("claude", f.opts);
  const data = JSON.parse(await readFile(f.claude, "utf8"));
  data.mcpServers.arelay.command = "changed";
  await writeFile(f.claude, JSON.stringify(data));
  await assert.rejects(disconnectNativeClient("claude"), /refusing to remove/);
});

test("A version 1 connection gains the subagent definition on reconnect", async (t) => {
  const f = await fixture(t);
  await connectNativeClient("claude", f.opts);
  const meta = join(f.opts.home, "state", "native-claude.json");
  const saved = JSON.parse(await readFile(meta, "utf8"));
  assert.equal(saved.version, 2);
  delete saved.agent;
  saved.version = 1;
  await writeFile(meta, JSON.stringify(saved));
  await rm(agentPath("claude"));
  assert.match(
    (await previewNativeClient("claude", f.opts)).message,
    /will be updated/,
  );
  assert.deepEqual(await connectNativeClient("claude", f.opts), {
    changed: true,
  });
  assert.equal(await readFile(agentPath("claude"), "utf8"), claudeSubagent());
  assert.equal(JSON.parse(await readFile(meta, "utf8")).version, 2);
});
for (const client of ["claude", "codex"] as const)
  test(`${client}: an unowned agent definition is never overwritten or removed`, async (t) => {
    const f = await fixture(t);
    await mkdir(join(f.root, client, "agents"), { recursive: true });
    await writeFile(agentPath(client), "user's own agent");
    const preview = await previewNativeClient(client, f.opts);
    assert.equal(preview.status, "blocked");
    assert.match(preview.message, /unowned file/);
    await assert.rejects(connectNativeClient(client, f.opts), /unowned file/);
    assert.equal(await readFile(agentPath(client), "utf8"), "user's own agent");
    await rm(agentPath(client));
    await connectNativeClient(client, f.opts);
    await writeFile(agentPath(client), "edited by the user");
    assert.equal((await previewNativeClient(client, f.opts)).status, "blocked");
    await assert.rejects(disconnectNativeClient(client), /refusing to remove/);
    assert.equal(
      await readFile(agentPath(client), "utf8"),
      "edited by the user",
    );
  });
