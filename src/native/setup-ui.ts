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
  type NativeWorkerConfig,
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
  auth(
    client: NativeClient,
    worker?: Partial<NativeWorkerConfig>,
  ): Promise<NativeAuth>;
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
  auth: (client, worker) =>
    nativeAuth(client, worker?.command, undefined, worker?.configDir),
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
): Promise<void> {
  const config = structuredClone(await deps.load());
  ui.intro();
  try {
    ui.note(
      "Adds a delegate tool using your existing CLIs.\n" +
        (config.native?.allowWrites
          ? "Starts at login."
          : "Read-only workers · starts at login."),
      "setup",
    );
    if (config.native?.allowWrites)
      ui.warn("Workspace edits are enabled in your existing settings.");
    const models = (["claude", "codex"] as const)
      .filter((client) => config.native?.[client]?.model)
      .map((client) => `${client}: ${config.native![client]!.model}`);
    if (models.length) ui.note(models.join("\n"), "saved model overrides");
    const route = await ui.select({
      message: "Connect",
      options: [
        { value: "both", label: "Both directions" },
        { value: "claude", label: "Claude → Codex" },
        { value: "codex", label: "Codex → Claude" },
      ],
      initialValue: "both",
    });
    if (!["both", "claude", "codex"].includes(route))
      throw new Error("Choose both, claude, or codex");
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
    const blocked: string[] = [];
    for (const target of targets) {
      const configDir =
        target === "codex"
          ? process.env.CODEX_HOME
          : process.env.CLAUDE_CONFIG_DIR;
      const worker = {
        ...config.native[target],
        ...(configDir ? { configDir: resolve(configDir) } : {}),
      };
      const status = await deps.auth(target, worker);
      auth.set(target, status);
      if (!status.installed) blocked.push(`${target}: ${status.message}`);
      if (status.command)
        config.native[target] = { ...worker, command: status.command };
    }
    const opts = await deps.options();
    for (const client of clients) {
      const preview = await deps.preview(client, opts);
      if (preview.status === "blocked")
        blocked.push(`${client}: ${preview.message}`);
    }
    if (blocked.length)
      throw new Error(
        `${blocked.join("\n")}\nNothing changed. Fix this, then run arelay setup.`,
      );
    await ui.progress("connecting", () => deps.apply(config, clients, opts));
    const pending = targets.filter(
      (target) => !(auth.get(target)?.ready ?? auth.get(target)?.subscription),
    );
    if (pending.length)
      ui.note(
        pending
          .map((target) => `${target}: ${auth.get(target)?.message}`)
          .join("\n"),
        "finish CLI authentication",
      );
    ui.outro("connected. restart your clients to use delegate.");
  } catch (e) {
    if (!(e instanceof WizardCancelled)) throw e;
    ui.cancel("Cancelled. No setup changes saved.");
  }
}
