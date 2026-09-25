import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../src/config.js";
import {
  runNativeSetup,
  type NativeSetupDeps,
} from "../src/native/setup-ui.js";
import type { WizardUI } from "../src/onboarding/types.js";

test("Normal native setup needs two choices, no key prompts, and keeps CLI default models", async () => {
  const questions: string[] = [];
  let applied = false;
  const ui: WizardUI = {
    intro() {},
    async select(q) {
      questions.push(q.message);
      return questions.length === 1 ? "both" : "connect";
    },
    async text() {
      assert.fail("Unexpected model prompt");
    },
    async password() {
      assert.fail("No API keys in native setup");
    },
    async confirm() {
      assert.fail("No extra confirmation steps");
    },
    note() {},
    warn() {},
    preview() {
      assert.fail("No API route preview");
    },
    async progress(_message, action) {
      return action();
    },
    outro() {},
    cancel() {},
  };
  const deps: NativeSetupDeps = {
    async load() {
      return structuredClone(defaultConfig);
    },
    async auth(client) {
      return {
        installed: true,
        loggedIn: true,
        subscription: true,
        command: `/bin/${client}`,
        message: "CLI login ready",
      };
    },
    async options() {
      return { node: "/bin/node", cli: "/bin/arelay.mjs", home: "/tmp/arelay" };
    },
    async preview() {
      return { status: "ready", message: "Ready" };
    },
    async apply(config, clients) {
      applied = true;
      assert.equal(config.mode, "native");
      assert.deepEqual(clients, ["claude", "codex"]);
      assert.equal(config.native?.allowWrites, false);
      assert.equal(config.native?.codex?.model, undefined);
    },
  };
  await runNativeSetup(ui, deps, async () => {
    assert.fail("Advanced setup should not run");
  });
  assert.equal(questions.length, 2);
  assert.equal(applied, true);
});
test("Advanced APIs are explicit and do not become the default from existing Azure configuration", async () => {
  let advanced = false;
  const config = structuredClone(defaultConfig);
  config.openai.baseUrl = "https://resource.services.ai.azure.com/openai/v1";
  const ui = {
    intro() {},
    async select(q: { initialValue?: string; options: { value: string }[] }) {
      assert.equal(q.initialValue, "both");
      assert.equal(q.options[0]!.value, "both");
      return "api";
    },
  } as unknown as WizardUI;
  await runNativeSetup(
    ui,
    {
      async load() {
        return config;
      },
    } as NativeSetupDeps,
    async () => {
      advanced = true;
    },
  );
  assert.equal(advanced, true);
});
