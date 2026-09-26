import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../src/config.js";
import {
  runNativeSetup,
  type NativeSetupDeps,
} from "../src/native/setup-ui.js";
import {
  WizardCancelled,
  type SelectQuestion,
  type WizardUI,
} from "../src/onboarding/types.js";
import type { Config } from "../src/types.js";
import type { NativeClient, NativeWorkerConfig } from "../src/native/types.js";

function fixture(t: TestContext, route = "both") {
  for (const key of ["CODEX_HOME", "CLAUDE_CONFIG_DIR"]) {
    const before = process.env[key];
    delete process.env[key];
    t.after(() => {
      if (before === undefined) delete process.env[key];
      else process.env[key] = before;
    });
  }
  const config = structuredClone(defaultConfig);
  const questions: SelectQuestion[] = [];
  const messages: string[] = [];
  const calls: string[] = [];
  const authenticated: {
    client: NativeClient;
    worker?: Partial<NativeWorkerConfig>;
  }[] = [];
  const applied: { config: Config; clients: NativeClient[] }[] = [];
  const ui: WizardUI = {
    intro() {},
    async select(question) {
      questions.push(question);
      calls.push("select");
      return route;
    },
    async text() {
      assert.fail("No model prompts in default setup");
    },
    async password() {
      assert.fail("No key prompts in native setup");
    },
    async confirm() {
      assert.fail("No second confirmation");
    },
    note(message) {
      messages.push(message);
      calls.push("note");
    },
    warn(message) {
      messages.push(message);
      calls.push("warn");
    },
    preview() {
      assert.fail("No API preview in native setup");
    },
    async progress(_message, action) {
      return action();
    },
    outro(message) {
      messages.push(message);
      calls.push("outro");
    },
    cancel(message) {
      messages.push(message);
      calls.push("cancel");
    },
  };
  const deps: NativeSetupDeps = {
    async load() {
      return config;
    },
    async auth(client, worker) {
      authenticated.push({ client, worker });
      return {
        installed: true,
        loggedIn: true,
        subscription: true,
        ready: true,
        command: worker?.command || `/bin/${client}`,
        message: "CLI login ready",
      };
    },
    async options() {
      return { node: "/bin/node", cli: "/bin/arelay.mjs", home: "/tmp/arelay" };
    },
    async preview(client) {
      calls.push(`preview:${client}`);
      return { status: "ready", message: "Ready" };
    },
    async apply(value, clients) {
      calls.push("apply");
      applied.push({ config: value, clients });
    },
  };
  return {
    config,
    questions,
    messages,
    calls,
    authenticated,
    applied,
    ui,
    deps,
  };
}

for (const [route, clients, targets] of [
  ["both", ["claude", "codex"], ["codex", "claude"]],
  ["claude", ["claude"], ["codex"]],
  ["codex", ["codex"], ["claude"]],
] as const)
  test(`${route}: one choice connects selected clients after preflight`, async (t) => {
    const f = fixture(t, route);
    const before = structuredClone(f.config);
    await runNativeSetup(f.ui, f.deps);
    assert.equal(f.questions.length, 1);
    assert.equal(f.questions[0]!.message, "Connect");
    assert.equal(f.questions[0]!.initialValue, "both");
    assert.deepEqual(
      f.questions[0]!.options.map((o) => o.value),
      ["both", "claude", "codex"],
    );
    assert.deepEqual(
      f.authenticated.map((a) => a.client),
      targets,
    );
    assert.deepEqual(f.applied[0]!.clients, clients);
    assert.equal(f.applied[0]!.config.mode, "native");
    assert.equal(f.applied[0]!.config.native?.allowWrites, false);
    assert.equal(f.applied[0]!.config.native?.codex?.model, undefined);
    assert.ok(f.messages.some((m) => m.includes("Read-only")));
    assert.ok(
      f.calls.indexOf("apply") > f.calls.indexOf(`preview:${clients.at(-1)}`),
    );
    assert.equal(f.calls.at(-1), "outro");
    assert.deepEqual(
      f.config,
      before,
      "the saved config is not mutated while preparing setup",
    );
  });

test("Escape/Ctrl+C before selection makes no auth, connection or service changes", async (t) => {
  const f = fixture(t);
  f.ui.select = async () => {
    throw new WizardCancelled();
  };
  f.deps.options = async () => {
    assert.fail("No connection work after cancellation");
  };
  await runNativeSetup(f.ui, f.deps);
  assert.deepEqual(f.applied, []);
  assert.deepEqual(f.authenticated, []);
  assert.equal(f.calls.at(-1), "cancel");
  assert.match(f.messages.at(-1)!, /No setup changes saved/);
});

test("Existing Azure settings do not add provider/model menus or change the default", async (t) => {
  const f = fixture(t);
  f.config.openai.baseUrl = "https://resource.services.ai.azure.com/openai/v1";
  await runNativeSetup(f.ui, f.deps);
  assert.equal(f.questions.length, 1);
  assert.ok(!f.questions[0]!.options.some((o) => o.value === "api"));
  assert.deepEqual(f.applied[0]!.config.openai, f.config.openai);
});

test("Saved model, permissions and worker paths survive setup and are visible before selection", async (t) => {
  const f = fixture(t, "claude");
  f.config.native = {
    enabled: true,
    allowWrites: true,
    timeoutMs: 12345,
    maxConcurrent: 2,
    codex: {
      command: "/custom/codex",
      configDir: "/custom/codex-home",
      model: "custom-model",
    },
  };
  await runNativeSetup(f.ui, f.deps);
  assert.deepEqual(f.applied[0]!.config.native, f.config.native);
  assert.deepEqual(f.authenticated[0]!.worker, f.config.native.codex);
  assert.ok(f.calls.indexOf("warn") < f.calls.indexOf("select"));
  assert.ok(f.messages.some((m) => m.includes("custom-model")));
  assert.ok(f.messages.some((m) => m.includes("Workspace edits are enabled")));
});

test("Explicit client homes are used in readiness checks and saved for the service", async (t) => {
  const f = fixture(t, "claude");
  process.env.CODEX_HOME = "/selected/codex-home";
  await runNativeSetup(f.ui, f.deps);
  assert.equal(f.authenticated[0]!.worker?.configDir, "/selected/codex-home");
  assert.equal(
    f.applied[0]!.config.native?.codex?.configDir,
    "/selected/codex-home",
  );
});

test("Missing CLI stops setup without writes or a redundant menu", async (t) => {
  const f = fixture(t, "claude");
  f.deps.auth = async () => ({
    installed: false,
    loggedIn: false,
    subscription: false,
    message: "Install Codex first",
  });
  await assert.rejects(
    runNativeSetup(f.ui, f.deps),
    /Install Codex first[\s\S]*Nothing changed/,
  );
  assert.equal(f.questions.length, 1);
  assert.deepEqual(f.applied, []);
});

test("Blocked clients are preflighted before any changes", async (t) => {
  const f = fixture(t);
  f.deps.preview = async (client) => ({
    status: client === "codex" ? "blocked" : "ready",
    message: "Existing connection must be restored",
  });
  await assert.rejects(
    runNativeSetup(f.ui, f.deps),
    /Existing connection must be restored/,
  );
  assert.deepEqual(f.applied, []);
});

test("Missing login gives a focused next step without claiming login is ready", async (t) => {
  const f = fixture(t, "codex");
  f.deps.auth = async () => ({
    installed: true,
    loggedIn: false,
    subscription: false,
    ready: false,
    command: "/bin/claude",
    message: "Run claude auth login",
  });
  await runNativeSetup(f.ui, f.deps);
  assert.equal(f.applied.length, 1);
  assert.ok(f.messages.some((m) => m.includes("Run claude auth login")));
  assert.ok(!f.messages.some((m) => m.includes("login ready")));
});

test("Apply failures do not print success or a misleading cancellation message", async (t) => {
  const f = fixture(t);
  f.deps.apply = async () => {
    throw new Error("Service did not start");
  };
  await assert.rejects(runNativeSetup(f.ui, f.deps), /Service did not start/);
  assert.ok(!f.calls.includes("outro"));
  assert.ok(!f.calls.includes("cancel"));
});

test("Unknown directions cannot reach config writes", async (t) => {
  const f = fixture(t, "api");
  await assert.rejects(
    runNativeSetup(f.ui, f.deps),
    /Choose both, claude, or codex/,
  );
  assert.deepEqual(f.applied, []);
});
