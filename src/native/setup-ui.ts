import { readFile, realpath, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  atomicWrite,
  defaultConfig,
  loadConfig,
  paths,
  saveConfig,
} from "../config.js";
import type { Config } from "../types.js";
import type { WizardUI } from "../onboarding/types.js";
import { WizardCancelled } from "../onboarding/types.js";
import {
  defaultNativeConfig,
  type NativeAuth,
  type NativeClient,
} from "./types.js";
import { nativeAuth } from "./worker.js";
import {
  connectNativeClient,
  disconnectNativeClient,
  previewNativeClient,
  type ConnectionOptions,
} from "./connect.js";
import { service } from "../service.js";

export interface NativeSetupDeps {
  load(): Promise<Config>;
  auth(client: NativeClient): Promise<NativeAuth>;
  options(): Promise<ConnectionOptions>;
  preview: typeof previewNativeClient;
  apply(
    config: Config,
    clients: NativeClient[],
    opts: ConnectionOptions,
  ): Promise<void>;
}
export const nativeSetupServices: NativeSetupDeps = {
  async load() {
    try {
      return await loadConfig();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      return structuredClone(defaultConfig);
    }
  },
  auth: (client) => nativeAuth(client),
  async options() {
    const cli = resolve(process.argv[1] || "");
    if (!(await realpath(cli)).endsWith(".mjs"))
      throw new Error(
        "Build arelay before connecting clients: pnpm build; node dist/arelay.mjs setup",
      );
    return { node: process.execPath, cli, home: paths().dir };
  },
  preview: previewNativeClient,
  async apply(config, clients, opts) {
    const before = await readFile(paths().config, "utf8").catch(
      (e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT") throw e;
        return undefined;
      },
    );
    const created: NativeClient[] = [];
    for (const client of clients) {
      const p = await previewNativeClient(client, opts);
      if (p.status === "blocked") throw new Error(p.message);
    }
    try {
      await saveConfig(config);
      for (const client of clients) {
        const pre = await previewNativeClient(client, opts);
        await connectNativeClient(client, opts);
        if (pre.status === "ready") created.push(client);
      }
    } catch (error) {
      const failed: string[] = [];
      for (const client of created.reverse())
        try {
          await disconnectNativeClient(client);
        } catch {
          failed.push(client);
        }
      const installed = JSON.stringify(config, null, 2) + "\n";
      try {
        const current = await readFile(paths().config, "utf8");
        if (current === installed) {
          if (before === undefined) await rm(paths().config);
          else await atomicWrite(paths().config, before);
        } else if (current !== before)
          failed.push("config changed concurrently");
      } catch {
        failed.push("config");
      }
      if (failed.length)
        throw new Error(
          `Setup stopped; preserve recovery state for ${failed.join(", ")}`,
        );
      throw error;
    }
    try {
      await service("install");
    } catch {
      throw new Error(
        "Clients are connected, but the service did not start. Run arelay service install; do not repeat setup to fix the service.",
      );
    }
  },
};

export async function runNativeSetup(
  ui: WizardUI,
  deps: NativeSetupDeps,
  advanced: () => Promise<void>,
): Promise<void> {
  const config = structuredClone(await deps.load());
  ui.intro();
  try {
    const route = await ui.select({
      message: "Use native CLI workers",
      options: [
        {
          value: "both",
          label: "Both directions",
          hint: "Claude → Codex · Codex → Claude",
        },
        {
          value: "claude",
          label: "Claude → Codex",
          hint: "use your Codex login",
        },
        {
          value: "codex",
          label: "Codex → Claude",
          hint: "use your Claude Code login",
        },
        {
          value: "api",
          label: "Advanced: API keys / Azure",
          hint: "model swapping, not native CLI workers",
        },
      ],
      initialValue: "both",
    });
    if (route === "api") {
      await advanced();
      return;
    }
    const clients: NativeClient[] =
      route === "both" ? ["claude", "codex"] : [route as NativeClient];
    const targets = clients.map((client): NativeClient =>
      client === "claude" ? "codex" : "claude",
    );
    config.mode = "native";
    config.native = {
      ...structuredClone(defaultNativeConfig),
      ...config.native,
      enabled: true,
    };
    const auth = new Map<NativeClient, NativeAuth>();
    for (const target of targets) {
      const status = await deps.auth(target);
      auth.set(target, status);
      if (status.command)
        config.native[target] = {
          command: status.command,
          ...((
            target === "codex"
              ? process.env.CODEX_HOME
              : process.env.CLAUDE_CONFIG_DIR
          )
            ? {
                configDir: resolve(
                  (target === "codex"
                    ? process.env.CODEX_HOME
                    : process.env.CLAUDE_CONFIG_DIR)!,
                ),
              }
            : {}),
          ...(config.native[target]?.model
            ? { model: config.native[target]!.model }
            : {}),
        };
    }
    const opts = await deps.options();
    const blocked: string[] = [];
    for (const client of clients) {
      const p = await deps.preview(client, opts);
      if (p.status === "blocked") blocked.push(`${client}: ${p.message}`);
    }
    for (;;) {
      ui.note(
        targets
          .map(
            (target) =>
              `${target}: ${auth.get(target)?.subscription ? "login ready" : auth.get(target)?.message}\nmodel: ${config.native?.[target]?.model || "CLI default"}`,
          )
          .join("\n\n"),
        "native workers",
      );
      ui.note(
        "Adds an arelay delegate tool to the selected clients. Built-in agents and model providers stay as they are. Workers use their own tools, not the parent's tool loop.",
        "connection",
      );
      for (const message of blocked) ui.warn(message);
      const missing = targets.some((target) => !auth.get(target)?.installed);
      const action = await ui.select({
        message: "Connect and start at login?",
        options: [
          {
            value: "connect",
            label: "Connect",
            hint: "restart your clients afterward",
            disabled: missing || blocked.length > 0,
          },
          {
            value: "models",
            label: "Change worker models",
            hint: "optional; CLI defaults are recommended",
          },
          {
            value: "writes",
            label: config.native.allowWrites
              ? "Workspace edits: on"
              : "Workspace edits: off",
            hint: "toggle; read-only is the default",
          },
          { value: "cancel", label: "Cancel" },
        ],
        initialValue: missing || blocked.length ? "cancel" : "connect",
      });
      if (action === "cancel") throw new WizardCancelled();
      if (action === "writes") {
        config.native.allowWrites = !config.native.allowWrites;
        continue;
      }
      if (action === "models") {
        for (const target of targets) {
          const model = await ui.text({
            message: `${target} model (blank = CLI default)`,
            initialValue: config.native[target]?.model || "",
            validate: (value) =>
              !value || /^[\w][\w.:/-]{0,199}$/.test(value)
                ? undefined
                : "Use a model ID without spaces",
          });
          if (config.native[target]) {
            if (model) config.native[target]!.model = model;
            else delete config.native[target]!.model;
          }
        }
        continue;
      }
      if (missing || blocked.length)
        throw new Error("Selected connection is not ready");
      await ui.progress("connecting", () => deps.apply(config, clients, opts));
      const pending = targets.filter(
        (target) =>
          !(auth.get(target)?.ready ?? auth.get(target)?.subscription),
      );
      if (pending.length)
        ui.note(
          pending
            .map(
              (target) =>
                `${target}: ${auth.get(target)?.message || "Check the original CLI authentication"}`,
            )
            .join("\n"),
          "finish CLI authentication",
        );
      ui.outro(
        "connected · restart your clients and ask them to use arelay's delegate tool",
      );
      return;
    }
  } catch (e) {
    if (!(e instanceof WizardCancelled)) throw e;
    ui.cancel("Cancelled. No setup changes saved.");
  }
}
