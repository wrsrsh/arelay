import { execFileSync } from "node:child_process";
import { initConfig, loadConfig, loadCredentials, paths } from "./config.js";
import { createRelay } from "./server.js";
import { setupClient, restoreClient } from "./setup.js";
import { service } from "./service.js";
import { VERSION } from "./version.js";
import { createTerminalUI, interactiveTerminal } from "./onboarding/ui.js";
import { runWizard } from "./onboarding/wizard.js";
import { wizardServices } from "./onboarding/state.js";

const HELP = `arelay ${VERSION} — cross-provider subagents

Usage: arelay <command>
  install                 Open setup in a terminal; otherwise start the service
  install --no-interactive Start the service without prompting
  setup                   Open the interactive provider/model/routing wizard
  init                    Create config without starting or changing clients
  setup claude|codex|both  Back up and configure clients without prompting
  unsetup claude|codex|both Restore client configs (refuses to erase later edits)
  serve                   Run the relay in the foreground
  status                  Check the local service
  stats                   Show routing counters since startup
  doctor                  Check config, credentials and client versions
  service <action>         install|start|stop|restart|uninstall
  --version               Print version

Config: ~/.config/arelay/config.json (override with ARELAY_HOME)
Credentials: ~/.config/arelay/credentials.env; or macOS Keychain by env name
The wizard previews changes and asks before editing client settings.
Use ARELAY_NO_TUI=1 or --no-interactive for unattended installation.
NO_COLOR disables colors. Existing explicit setup commands remain noninteractive.
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
async function onboarding(): Promise<void> {
  if (!interactiveTerminal())
    throw new Error(
      "Interactive setup needs a terminal. Run arelay setup in your terminal, or use arelay setup claude|codex|both for scripted setup.",
    );
  const result = await runWizard(createTerminalUI(), wizardServices);
  if (result === "service-failed") process.exitCode = 1;
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
  if (command === "setup" && args.length === 0) {
    await onboarding();
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
      else await restoreClient(client);
      console.log(
        `${client}: ${command === "setup" ? "configured" : "restored"}`,
      );
    }
    console.log(
      "Restart existing client sessions. Project/CLI overrides can take precedence over user settings.",
    );
    return;
  }
  if (command === "status" || command === "stats") {
    console.log(
      JSON.stringify(
        await check(command === "stats" ? "stats" : "health"),
        null,
        2,
      ),
    );
    return;
  }
  if (command === "doctor") {
    const config = await loadConfig();
    await loadCredentials(config);
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
    for (const backend of [config.openai, config.anthropic])
      console.log(
        `${backend.apiKeyEnv}: ${process.env[backend.apiKeyEnv] ? "available" : "MISSING (that cross-provider direction will fail)"}`,
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
    await loadCredentials(config);
    const server = createRelay(config);
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
