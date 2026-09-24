import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../src/config.js";
import {
  runWizard,
  validateEndpoint,
  validateModel,
} from "../src/onboarding/wizard.js";
import { interactiveTerminal } from "../src/onboarding/ui.js";
import { banner, routePreview, terminalText } from "../src/onboarding/theme.js";
import {
  WizardCancelled,
  type SelectQuestion,
  type WizardPlan,
  type WizardServices,
  type WizardUI,
} from "../src/onboarding/types.js";

function fixture(
  options: {
    selection?: string;
    key?: string;
    blocked?: boolean;
    missing?: boolean;
    service?: boolean;
    action?: string;
    confirm?: boolean;
    cancelAt?: string;
    customModel?: string;
    env?: boolean;
    serviceFailed?: boolean;
    edit?: boolean;
  } = {},
) {
  const captured: WizardPlan[] = [];
  const output: string[] = [];
  const questions: SelectQuestion[] = [];
  let review = 0;
  const ui: WizardUI = {
    intro() {
      output.push("intro");
    },
    async select(q) {
      questions.push(q);
      if (options.cancelAt && q.message.includes(options.cancelAt))
        throw new WizardCancelled();
      if (q.message.includes("01 /")) return options.selection ?? "both";
      if (q.message.includes("02 /")) return "keep";
      if (q.message.includes("03 /"))
        return options.customModel ? "__custom_model__" : q.initialValue!;
      if (q.message.includes("04 /"))
        return options.missing
          ? "later"
          : options.key
            ? "paste"
            : options.env
              ? "store-env"
              : "keep";
      if (q.message.includes("06 /")) {
        review++;
        if (options.edit && review === 1) return "edit";
        return options.action ?? q.initialValue!;
      }
      throw new Error(`Unexpected prompt ${q.message}`);
    },
    async text(q) {
      const value = options.customModel ?? q.initialValue!;
      assert.equal(q.validate?.(value), undefined);
      return value;
    },
    async password(q) {
      assert.ok(options.key);
      assert.equal(q.validate?.(options.key), undefined);
      return options.key!;
    },
    async confirm(message) {
      return message.startsWith("05 /")
        ? (options.service ?? true)
        : (options.confirm ?? true);
    },
    note(message) {
      output.push(message);
    },
    warn(message) {
      output.push(message);
    },
    preview(config, clients, service) {
      output.push(routePreview(config, clients, service));
    },
    async progress(_message, action) {
      return action();
    },
    outro(message) {
      output.push(message);
    },
    cancel(message) {
      output.push(message);
    },
  };
  const services: WizardServices = {
    async load() {
      return { config: structuredClone(defaultConfig), existing: true };
    },
    async credential() {
      return options.missing || options.key
        ? undefined
        : {
            source: options.env ? "environment" : "Keychain",
            persistent: !options.env,
          };
    },
    async preview() {
      return options.blocked
        ? {
            status: "blocked",
            message: "An existing bridge is configured. Restore it first.",
          }
        : { status: "ready", message: "ready" };
    },
    async apply(plan) {
      captured.push(structuredClone(plan));
      return options.serviceFailed
        ? { service: "failed", message: "saved, but service failed" }
        : { service: plan.startService ? "started" : "skipped" };
    },
  };
  return { ui, services, captured, output, questions };
}

test("Wizard previews and applies both directions with current models and persistent credentials", async () => {
  const f = fixture();
  assert.equal(await runWizard(f.ui, f.services), "saved");
  assert.deepEqual(f.captured[0]!.clients, ["claude", "codex"]);
  assert.deepEqual(f.captured[0]!.credentials, {});
  assert.equal(f.captured[0]!.config.openai.model, defaultConfig.openai.model);
  assert.equal(f.captured[0]!.startService, true);
  assert.match(f.output.join("\n"), /direct function tools/);
});
test("Claude-only setup asks for no Anthropic credential and leaves its backend untouched", async () => {
  const f = fixture({ selection: "claude" });
  await runWizard(f.ui, f.services);
  assert.deepEqual(f.captured[0]!.clients, ["claude"]);
  assert.ok(!f.questions.some((q) => q.message.includes("ANTHROPIC_API_KEY")));
  assert.deepEqual(f.captured[0]!.config.anthropic, defaultConfig.anthropic);
});
test("Custom model versions are accepted and shown in the preview", async () => {
  const f = fixture({ selection: "claude", customModel: "my-deployment-v42" });
  await runWizard(f.ui, f.services);
  assert.equal(f.captured[0]!.config.openai.model, "my-deployment-v42");
  assert.match(f.output.join("\n"), /my-deployment-v42/);
});
test("New keys are only passed to apply; previews and messages never contain secrets", async () => {
  const key = "secret-NEVER-render-this";
  const f = fixture({ key });
  await runWizard(f.ui, f.services);
  assert.equal(f.captured[0]!.credentials.OPENAI_API_KEY, key);
  assert.equal(f.captured[0]!.credentials.ANTHROPIC_API_KEY, key);
  assert.ok(!JSON.stringify(f.output).includes(key));
  assert.ok(!JSON.stringify(f.questions).includes(key));
});
test("An environment key is only copied after an explicit selection and final confirmation", async () => {
  const f = fixture({ env: true });
  await runWizard(f.ui, f.services, {
    environment: {
      OPENAI_API_KEY: "env-openai",
      ANTHROPIC_API_KEY: "env-anthropic",
    },
  });
  assert.deepEqual(f.captured[0]!.credentials, {
    OPENAI_API_KEY: "env-openai",
    ANTHROPIC_API_KEY: "env-anthropic",
  });
  assert.ok(!f.output.join("\n").includes("env-openai"));
});
for (const cancelAt of ["01 /", "02 /", "03 /", "04 /", "06 /"])
  test(`Cancel at ${cancelAt} does not apply configuration`, async () => {
    const f = fixture({ cancelAt });
    assert.equal(await runWizard(f.ui, f.services), "cancelled");
    assert.equal(f.captured.length, 0);
  });
test("Declining final confirmation and explicit cancel leave configuration untouched", async () => {
  for (const options of [{ confirm: false }, { action: "cancel" }]) {
    const f = fixture(options);
    assert.equal(await runWizard(f.ui, f.services), "cancelled");
    assert.equal(f.captured.length, 0);
  }
});
test("Missing credentials and conflicting clients disable activation but allow saving backends", async () => {
  for (const options of [{ missing: true }, { blocked: true }]) {
    const f = fixture(options);
    await runWizard(f.ui, f.services);
    assert.deepEqual(f.captured[0]!.clients, []);
    const review = f.questions.find((q) => q.message.includes("06 /"))!;
    assert.equal(
      review.options.find((o) => o.value === "activate")!.disabled,
      true,
    );
  }
});
test("Skipping service changes does not stop an existing service", async () => {
  const f = fixture({ service: false, action: "save" });
  await runWizard(f.ui, f.services);
  assert.equal(f.captured[0]!.startService, false);
  assert.match(f.output.join("\n"), /not stopped or restarted/);
});
test("Review can return to editing without saving the first draft", async () => {
  const f = fixture({ edit: true });
  await runWizard(f.ui, f.services);
  assert.equal(f.questions.filter((q) => q.message.includes("01 /")).length, 2);
  assert.equal(f.captured.length, 1);
});
test("Service errors are distinct from successful configuration", async () => {
  const f = fixture({ serviceFailed: true });
  assert.equal(await runWizard(f.ui, f.services), "service-failed");
  assert.match(f.output.join("\n"), /service needs attention/);
});
test("Background activation is blocked for keys kept only in the shell", async () => {
  const f = fixture();
  f.services.credential = async () => ({
    source: "environment",
    persistent: false,
  });
  await runWizard(f.ui, f.services);
  assert.deepEqual(f.captured[0]!.clients, []);
  assert.match(f.output.join("\n"), /Not ready for background requests/);
});
test("Endpoint and model validation reject secrets, loops and terminal controls", () => {
  assert.ok(
    validateEndpoint("https://secret@host/v1", defaultConfig, "openai"),
  );
  assert.ok(
    validateEndpoint("http://127.0.0.1:8788/v1", defaultConfig, "openai"),
  );
  assert.ok(validateEndpoint("https://host", defaultConfig, "openai"));
  assert.equal(
    validateEndpoint("https://host/openai/v1", defaultConfig, "openai"),
    undefined,
  );
  assert.ok(validateModel("bad\nmodel"));
  assert.ok(validateModel("bad\x1b[2J"));
  assert.equal(validateModel("provider/my-model:v2"), undefined);
});
test("Terminal gating keeps CI, redirection and explicit opt-outs noninteractive", () => {
  assert.equal(interactiveTerminal(true, true, { TERM: "xterm" }), true);
  assert.equal(interactiveTerminal(false, true, {}), false);
  assert.equal(interactiveTerminal(true, false, {}), false);
  for (const env of [{ CI: "true" }, { ARELAY_NO_TUI: "1" }, { TERM: "dumb" }])
    assert.equal(interactiveTerminal(true, true, env), false);
  assert.equal(
    interactiveTerminal(true, true, {
      CI: "false",
      ARELAY_NO_TUI: "0",
      NO_COLOR: "1",
    }),
    true,
  );
});
test("The preview is readable without colors and strips terminal control injection", () => {
  assert.ok(!banner(80, false).includes("\x1b"));
  assert.match(banner(30, false), /a r e l a y/);
  assert.match(banner(80, true), /\x1b\[36m/);
  assert.equal(terminalText("hello\x1b[2J\nworld"), "hello world");
  const config = structuredClone(defaultConfig);
  config.openai.model = "gpt\x1b[2Jmodel";
  assert.ok(!routePreview(config, ["claude"], true).includes("\x1b"));
});
