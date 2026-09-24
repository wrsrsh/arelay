import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { atomicWrite, paths } from "./config.js";

const exec = promisify(execFile);
const LABEL = "dev.arelay";
export interface ServiceSpec {
  node: string;
  cli: string;
  home: string;
  logs: string;
}
const xml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
const unit = (s: string) =>
  '"' +
  s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/%/g, "%%")
    .replace(/\$/g, () => "$$") +
  '"';
function safe(spec: ServiceSpec): void {
  for (const value of Object.values(spec))
    if (/[\r\n\0]/.test(value) || !value.startsWith("/"))
      throw new Error(
        "Service paths must be absolute and contain no control characters",
      );
}
export function launchAgent(spec: ServiceSpec): string {
  safe(spec);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array><string>${xml(spec.node)}</string><string>${xml(spec.cli)}</string><string>serve</string></array>
<key>EnvironmentVariables</key><dict><key>ARELAY_HOME</key><string>${xml(spec.home)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>5</integer>
<key>StandardOutPath</key><string>${xml(join(spec.logs, "service.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(spec.logs, "service.log"))}</string>
</dict></plist>
`;
}
export function systemdUnit(spec: ServiceSpec): string {
  safe(spec);
  // Environment= has no shell expansion; double dollars are only for ExecStart.
  const env =
    '"ARELAY_HOME=' +
    spec.home.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%") +
    '"';
  return `[Unit]
Description=arelay — cross-provider subagent router
After=network.target

[Service]
Type=simple
ExecStart=${unit(spec.node)} ${unit(spec.cli)} serve
Environment=${env}
Restart=on-failure
RestartSec=5
TimeoutStopSec=10
UMask=0077

[Install]
WantedBy=default.target
`;
}

function serviceFile(): string {
  if (process.platform === "darwin")
    return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
  if (process.platform === "linux")
    return join(
      process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
      "systemd",
      "user",
      "arelay.service",
    );
  throw new Error(
    "Persistent services support macOS launchd and Linux systemd --user only",
  );
}
async function run(
  command: string,
  args: string[],
  ignoreFailure = false,
): Promise<void> {
  try {
    await exec(command, args, { timeout: 15000 });
  } catch {
    if (!ignoreFailure)
      throw new Error(
        `${command} ${args.join(" ")} failed. On Linux, a running systemd user session is required; on macOS, run from your logged-in user session.`,
      );
  }
}
/** bootout can return before launchd releases a registration. Retry only the
 * idempotent bootstrap operation; never repeat file writes or client changes. */
export async function bootstrapWithRetry(
  operation: () => Promise<void>,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await operation();
      return;
    } catch (error) {
      if (attempt === 4) throw error;
      await sleep(150 * 2 ** attempt);
    }
  }
}

export async function service(action: string): Promise<void> {
  const file = serviceFile();
  const domain = `gui/${process.getuid?.()}`;
  const target = `${domain}/${LABEL}`;
  if (action === "install") {
    const cli = await realpath(resolve(process.argv[1] || ""));
    if (!cli.endsWith(".mjs"))
      throw new Error(
        "Build arelay first, then run node dist/arelay.mjs install",
      );
    const node = await realpath(process.execPath);
    const spec = { node, cli, home: paths().dir, logs: paths().logs };
    await mkdir(spec.logs, { recursive: true, mode: 0o700 });
    await mkdir(dirname(file), { recursive: true });
    if (process.platform === "darwin")
      await run("launchctl", ["bootout", target], true);
    await atomicWrite(
      file,
      process.platform === "darwin" ? launchAgent(spec) : systemdUnit(spec),
    );
    if (process.platform === "darwin") {
      await run("launchctl", ["enable", target]);
      await bootstrapWithRetry(() =>
        run("launchctl", ["bootstrap", domain, file]),
      );
    } else {
      await run("systemctl", ["--user", "daemon-reload"]);
      await run("systemctl", ["--user", "enable", "--now", "arelay.service"]);
      await run("systemctl", ["--user", "restart", "arelay.service"]);
    }
    return;
  }
  if (!["start", "stop", "restart", "uninstall"].includes(action))
    throw new Error(
      "Usage: arelay service install|start|stop|restart|uninstall",
    );
  if (action !== "uninstall") await readFile(file);
  if (process.platform === "darwin") {
    if (action === "stop" || action === "uninstall") {
      await run("launchctl", ["bootout", target], action === "uninstall");
    } else if (action === "restart")
      await run("launchctl", ["kickstart", "-k", target]);
    else {
      try {
        await exec("launchctl", ["print", target], { timeout: 5000 });
        await run("launchctl", ["kickstart", target]);
      } catch {
        await bootstrapWithRetry(() =>
          run("launchctl", ["bootstrap", domain, file]),
        );
      }
    }
  } else {
    await run(
      "systemctl",
      [
        "--user",
        action === "uninstall" ? "disable" : action,
        ...(action === "uninstall" ? ["--now"] : []),
        "arelay.service",
      ],
      action === "uninstall",
    );
  }
  if (action === "uninstall") {
    await rm(file, { force: true });
    if (process.platform === "linux")
      await run("systemctl", ["--user", "daemon-reload"]);
  }
}
