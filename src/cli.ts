import { execFileSync } from "node:child_process";
import {
  initConfig,
  loadConfig,
  loadCredentials,
  paths,
  saveConfig,
} from "./config.js";
import { createRelay } from "./server.js";
import { setupClient, restoreClient } from "./setup.js";
import { service } from "./service.js";
import { VERSION } from "./version.js";
import { createTerminalUI, interactiveTerminal } from "./onboarding/ui.js";
import { runWizard } from "./onboarding/wizard.js";
import { wizardServices } from "./onboarding/state.js";
import { runNativeSetup, nativeSetupServices } from "./native/setup-ui.js";
import { disconnectNativeClient } from "./native/connect.js";
import { nativeAuth } from "./native/worker.js";
import type { JsonObject } from "./types.js";
import { ensureNativeToken, readNativeToken } from "./native/access.js";

const HELP = `arelay ${VERSION} — cross-provider subagents

Usage: arelay <command>
  install                 Open setup in a terminal; otherwise start the service
  install --no-interactive Start the service without prompting
  setup                   Open the interactive native CLI connection setup
  setup --api             Advanced API keys / Azure model swapping
  delegate claude|codex TASK  Run a read-only native CLI worker in this directory
  init                    Create config without starting or changing clients
  setup claude|codex|both  Legacy API-mode setup without prompting
  unsetup claude|codex|both Restore client configs (refuses to erase later edits)
  serve                   Run the relay in the foreground
  status [--json]         Check the local service
  stats [--json]          Show work counters since startup
  doctor                  Check config, credentials and client versions
  service <action>         install|start|stop|restart|uninstall
  --version               Print version

Config: ~/.config/arelay/config.json (override with ARELAY_HOME)
Native workers use the original CLIs' own logins. No subscription tokens are copied.
API keys and Azure are optional advanced integrations.
The setup previews connections before editing client settings.
Use ARELAY_NO_TUI=1 or --no-interactive for unattended installation.
NO_COLOR disables colors. The explicit setup <client> commands are legacy API mode.
Restore clients before stopping/removing arelay, or their requests will fail.
`;

async function check(endpoint: "health" | "stats"): Promise<unknown> {
  const config = await loadConfig();
  const response = await fetch(`http://127.0.0.1:${config.port}/${endpoint}`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`Service returned HTTP ${response.status}`);
  return response.json();
}
async function onboarding(api = false): Promise<void> {
  if (!interactiveTerminal())
    throw new Error(
      "Interactive setup needs a terminal. Run arelay setup in your terminal, or use arelay setup claude|codex|both for scripted setup.",
    );
  const ui = createTerminalUI();
  const advanced = async () => {
    const result = await runWizard(ui, wizardServices);
    if (result === "service-failed") process.exitCode = 1;
  };
  if (api) await advanced();
  else await runNativeSetup(ui, nativeSetupServices, advanced);
}

async function main(): Promise<void> {
  const [command = interactiveTerminal() ? "setup" : "help", ...args] =
    process.argv.slice(2);
  if (["help", "--help", "-h"].includes(command)) {
    console.log(HELP);
    return;
  }
  if (command === "--version") {
    console.log(VERSION);
    return;
  }
  if (command === "mcp") {
    if (
      args.length !== 2 ||
      args[0] !== "--client" ||
      !["claude", "codex"].includes(args[1]!)
    )
      throw new Error("Usage: arelay mcp --client claude|codex");
    await (
      await import("./native/mcp.js")
    ).startNativeMcp(args[1] as "claude" | "codex");
    return;
  }
  if (command === "delegate") {
    const [target, ...task] = args;
    if (!target || !["claude", "codex"].includes(target) || !task.length)
      throw new Error('Usage: arelay delegate claude|codex "task"');
    const config = await loadConfig();
    const response = await fetch(
      `http://127.0.0.1:${config.port}/native/delegate`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await readNativeToken()}`,
        },
        body: JSON.stringify({
          target,
          task: task.join(" "),
          cwd: process.cwd(),
          permission: "read-only",
        }),
        signal: AbortSignal.timeout(
          (config.native?.timeoutMs ?? 600000) + 15000,
        ),
      },
    );
    const result = (await response.json()) as JsonObject;
    if (!response.ok)
      throw new Error(result.error?.message || "Native delegation failed");
    console.log(result.text);
    return;
  }
  if (command === "init") {
    await initConfig();
    console.log(paths().config);
    return;
  }
  if (command === "install") {
    if (
      args.some(
        (arg) => !["--no-interactive", "--interactive"].includes(arg),
      ) ||
      args.length > 1
    )
      throw new Error("Usage: arelay install [--no-interactive|--interactive]");
    if (
      args[0] === "--interactive" ||
      (args[0] !== "--no-interactive" && interactiveTerminal())
    ) {
      await onboarding();
      return;
    }
    await initConfig();
    await service("install");
    console.log(
      `arelay installed and started. It will run at login.\nRun arelay setup in your terminal to choose providers, models, and routes.\nConfig: ${paths().config}\nOn Linux, keep it running after logout with: loginctl enable-linger "$USER"`,
    );
    return;
  }
  if (command === "service") {
    if (args.length !== 1)
      throw new Error(
        "Usage: arelay service install|start|stop|restart|uninstall",
      );
    if (args[0] === "install") await initConfig();
    if (["stop", "uninstall"].includes(args[0]!))
      console.error(
        "Restore clients with arelay unsetup before stopping the service.",
      );
    await service(args[0]!);
    console.log(`Service: ${args[0]}`);
    return;
  }
  if (
    command === "setup" &&
    (args.length === 0 || (args.length === 1 && args[0] === "--api"))
  ) {
    await onboarding(args[0] === "--api");
    return;
  }
  if (command === "setup" || command === "unsetup") {
    if (args.length !== 1 || !["claude", "codex", "both"].includes(args[0]!))
      throw new Error(`Usage: arelay ${command} claude|codex|both`);
    const clients: ("claude" | "codex")[] =
      args[0] === "both"
        ? ["claude", "codex"]
        : [args[0] as "claude" | "codex"];
    const config = command === "setup" ? await initConfig() : undefined;
    if (config) await loadCredentials(config);
    for (const client of clients) {
      if (config) await setupClient(client, config);
      else {
        await disconnectNativeClient(client);
        await restoreClient(client);
      }
      console.log(
        `${client}: ${command === "setup" ? "configured" : "restored"}`,
      );
    }
    if (config) {
      config.mode = "api";
      await saveConfig(config);
    }
    console.log(
      "Restart affected clients. For API setup, also run arelay service restart.",
    );
    return;
  }
  if (command === "status" || command === "stats") {
    if (args.some((arg) => arg !== "--json") || args.length > 1)
      throw new Error(`Usage: arelay ${command} [--json]`);
    const data = (await check(
      command === "stats" ? "stats" : "health",
    )) as JsonObject;
    if (args[0] === "--json") console.log(JSON.stringify(data, null, 2));
    else if (command === "status")
      console.log(`arelay ${data.version} · running`);
    else {
      console.log(
        `Codex workers  ${data.nativeCodex ?? 0}\nClaude workers ${data.nativeClaude ?? 0}\nActive         ${data.active}\nErrors         ${data.errors}`,
      );
      const api =
        data.claudeToOpenAI +
        data.codexToClaude +
        data.anthropicPassthrough +
        data.openaiPassthrough;
      if (api) console.log(`API requests   ${api}`);
      if (!(data.nativeCodex || data.nativeClaude || api))
        console.log(
          "\nNo work since startup. Ask your client to use arelay's delegate tool.",
        );
    }
    return;
  }
  if (command === "doctor") {
    const config = await loadConfig();
    if (config.mode !== "native") await loadCredentials(config);
    console.log(`Config: ${paths().config}\nNode: ${process.version}`);
    for (const client of ["claude", "codex"]) {
      try {
        console.log(
          `${client}: ${execFileSync(client, ["--version"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim()}`,
        );
      } catch {
        console.log(`${client}: not found`);
      }
    }
    if (config.mode === "native") {
      for (const client of ["claude", "codex"] as const)
        console.log(
          `${client}: ${(await nativeAuth(client, config.native?.[client]?.command)).message}`,
        );
    } else
      for (const backend of [config.openai, config.anthropic])
        console.log(
          `${backend.apiKeyEnv}: ${process.env[backend.apiKeyEnv] ? "available" : "MISSING"}`,
        );
    try {
      await check("health");
      console.log("Service: healthy");
    } catch {
      console.log("Service: not reachable");
      process.exitCode = 1;
    }
    return;
  }
  if (command === "serve") {
    const config = await initConfig();
    if (config.mode !== "native") await loadCredentials(config);
    const nativeToken = config.native?.enabled
      ? await ensureNativeToken()
      : undefined;
    const server = createRelay(config, undefined, undefined, nativeToken);
    server.on("error", (error: NodeJS.ErrnoException) => {
      console.error(
        `arelay: cannot listen (${error.code || "server error"}); check for a port conflict`,
      );
      process.exitCode = 1;
    });
    server.listen(config.port, "127.0.0.1", () =>
      console.log(`arelay listening on http://127.0.0.1:${config.port}`),
    );
    const shutdown = () => {
      server.emit("arelay:shutdown");
      const timeout = setTimeout(() => {
        server.closeAllConnections();
        process.exit(0);
      }, 8000);
      timeout.unref();
      server.close(() => {
        clearTimeout(timeout);
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    return;
  }
  throw new Error(`Unknown command: ${command}. Run arelay --help.`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unexpected error";
  // Configuration errors never include credential values; do not dump environment or stacks.
  console.error(`arelay: ${message}`);
  process.exitCode = 1;
});
