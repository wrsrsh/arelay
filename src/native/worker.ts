import { execFile, spawn } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type {
  NativeAuth,
  NativeClient,
  NativeConfig,
  NativeResult,
  NativeTask,
} from "./types.js";

const exec = promisify(execFile);
const LIMIT = 4 * 1024 * 1024;

export function workerEnvironment(
  command: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SHELL",
    "TERM",
    "TZ",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
  ])
    if (source[name]) env[name] = source[name];
  env.HOME ??= homedir();
  env.PATH = [
    dirname(command),
    dirname(process.execPath),
    join(homedir(), ".local/bin"),
    "/opt/homebrew/bin",
    source.PATH || "/usr/local/bin:/usr/bin:/bin",
  ].join(delimiter);
  env.ARELAY_NATIVE_WORKER = "1";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  return env;
}

export async function findNativeCli(
  client: NativeClient,
): Promise<string | undefined> {
  const dirs = [
    ...(process.env.PATH || "").split(delimiter),
    join(homedir(), ".local/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const dir of dirs) {
    if (!dir || !isAbsolute(dir)) continue;
    const path = join(dir, client);
    try {
      await access(path, constants.X_OK);
      if ((await stat(path)).isFile()) return path;
    } catch {
      /* Try the next path. */
    }
  }
  return undefined;
}

export async function nativeAuth(
  client: NativeClient,
  configured?: string,
  signal?: AbortSignal,
): Promise<NativeAuth> {
  const command = configured || (await findNativeCli(client));
  if (!command)
    return {
      installed: false,
      loggedIn: false,
      subscription: false,
      message: `Install the ${client} CLI first.`,
    };
  try {
    const { stdout, stderr } = await exec(
      command,
      client === "codex" ? ["login", "status"] : ["auth", "status", "--json"],
      {
        env: workerEnvironment(command),
        timeout: 10000,
        maxBuffer: 256 * 1024,
        signal,
      },
    );
    let loggedIn = false,
      subscription = false;
    if (client === "codex") {
      loggedIn =
        /logged in/i.test(stdout + stderr) &&
        !/not logged in/i.test(stdout + stderr);
      subscription =
        loggedIn &&
        /chatgpt/i.test(stdout + stderr) &&
        !/api key/i.test(stdout + stderr);
    } else {
      const data = JSON.parse(stdout);
      loggedIn = data.loggedIn === true;
      subscription =
        loggedIn &&
        data.authMethod === "claude.ai" &&
        (data.apiProvider === undefined || data.apiProvider === "firstParty");
    }
    return {
      installed: true,
      command,
      loggedIn,
      subscription,
      message: subscription
        ? "CLI login ready"
        : loggedIn
          ? "API authentication detected; native mode requires the CLI subscription login"
          : `Run ${client === "claude" ? "claude auth login" : "codex login"} in your terminal.`,
    };
  } catch {
    return {
      installed: true,
      command,
      loggedIn: false,
      subscription: false,
      message: `Run ${client === "claude" ? "claude auth login" : "codex login"} in your terminal, then retry.`,
    };
  }
}

export function buildWorkerInvocation(
  task: NativeTask,
  config: NativeConfig,
  command: string,
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  if (!["claude", "codex"].includes(task.target))
    throw new Error("Choose a Claude or Codex worker");
  if (
    typeof task.task !== "string" ||
    !task.task.trim() ||
    Buffer.byteLength(task.task) > 200000
  )
    throw new Error("Task must contain 1–200000 bytes");
  if (!isAbsolute(command) || /[\x00-\x1f]/.test(command))
    throw new Error("CLI command must be an absolute path");
  const model = task.model || config[task.target]?.model;
  if (model !== undefined && !/^[\w][\w.:/-]{0,199}$/.test(model))
    throw new Error("Invalid model override");
  if (
    task.permission &&
    !["read-only", "workspace-write"].includes(task.permission)
  )
    throw new Error("Invalid worker permission");
  const write = task.permission === "workspace-write";
  if (write && !config.allowWrites)
    throw new Error(
      "Workspace writes are disabled. Enable native.allowWrites explicitly in arelay's config to allow them.",
    );
  const args =
    task.target === "codex"
      ? [
          "exec",
          "--json",
          "--ephemeral",
          "--skip-git-repo-check",
          "--ignore-user-config",
          "-C",
          task.cwd,
          "-s",
          write ? "workspace-write" : "read-only",
          "-c",
          'approval_policy="never"',
          "-c",
          'model_provider="openai"',
          "-c",
          'forced_login_method="chatgpt"',
          ...(model ? ["--model", model] : []),
          "-",
        ]
      : [
          "-p",
          "--output-format",
          "json",
          "--no-session-persistence",
          "--setting-sources",
          "",
          "--strict-mcp-config",
          "--mcp-config",
          '{"mcpServers":{}}',
          "--permission-prompts",
          "none",
          "--permission-mode",
          write ? "acceptEdits" : "plan",
          "--tools",
          write ? "Read,Glob,Grep,Edit,Write" : "Read,Glob,Grep",
          "--settings",
          JSON.stringify({
            env: {
              ANTHROPIC_BASE_URL: "https://api.anthropic.com",
              ANTHROPIC_API_KEY: "",
              ANTHROPIC_AUTH_TOKEN: "",
              CLAUDE_CODE_SUBAGENT_MODEL: "inherit",
              CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "0",
            },
          }),
          ...(model ? ["--model", model] : []),
        ];
  return { command, args, env: workerEnvironment(command) };
}

export function parseWorkerOutput(target: NativeClient, text: string): string {
  if (target === "claude") {
    let result;
    try {
      result = JSON.parse(text);
    } catch {
      throw new Error("Claude CLI returned invalid result JSON");
    }
    if (
      result.is_error ||
      result.type !== "result" ||
      typeof result.result !== "string"
    )
      throw new Error(
        "Claude CLI did not complete the task successfully; check its login and permissions",
      );
    return result.result;
  }
  let completed = false;
  const messages: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error("Codex CLI returned invalid event JSON");
    }
    if (event.type === "turn.failed" || event.type === "error")
      throw new Error(
        "Codex CLI failed the task; check its login, model access, and permissions",
      );
    if (event.type === "turn.completed") completed = true;
    if (
      event.type === "item.completed" &&
      event.item?.type === "agent_message" &&
      typeof event.item.text === "string"
    )
      messages.push(event.item.text);
  }
  if (!completed)
    throw new Error("Codex CLI ended without completing the task");
  return (
    messages.join("\n\n") || "Task completed without a final text response."
  );
}

async function collect(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  task: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let size = 0,
      reason: string | undefined,
      exited = false;
    let hardKill: NodeJS.Timeout | undefined;
    const kill = (sig: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        /* Group already exited. */
      }
    };
    const stop = (message: string) => {
      if (reason || exited) return;
      reason = message;
      kill("SIGTERM");
      // Keep this deadline even if the parent exits first: clean up its process group.
      hardKill = setTimeout(() => kill("SIGKILL"), 300);
    };
    const abort = () => stop("Native task cancelled");
    const timeout = setTimeout(() => stop("Native task timed out"), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > LIMIT) stop("Native task exceeded its output limit");
      else if (!reason) chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > LIMIT) stop("Native task exceeded its output limit");
    });
    child.stdin.on("error", () => {});
    child.on("error", () => {
      reason = "Unable to start the native CLI; check its executable path";
    });
    child.on("close", (code) => {
      exited = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      const finish = () => {
        if (reason) reject(new Error(reason));
        else if (code !== 0)
          reject(
            new Error(
              "Native CLI exited unsuccessfully; run it directly to check login, permissions, or model access",
            ),
          );
        else resolve(Buffer.concat(chunks).toString("utf8"));
      };
      if (hardKill) setTimeout(finish, 320);
      else finish();
    });
    child.stdin.end(task);
    if (signal?.aborted) abort();
  });
}

export async function runNativeTask(
  task: NativeTask,
  config: NativeConfig,
  signal?: AbortSignal,
): Promise<NativeResult> {
  if (!config.enabled)
    throw new Error("Native delegation is not configured. Run arelay setup.");
  if (!isAbsolute(task.cwd) || !(await stat(task.cwd)).isDirectory())
    throw new Error("Task cwd must be an existing absolute directory");
  signal?.throwIfAborted();
  const auth = await nativeAuth(
    task.target,
    config[task.target]?.command,
    signal,
  );
  signal?.throwIfAborted();
  if (!auth.subscription || !auth.command) throw new Error(auth.message);
  const invocation = buildWorkerInvocation(task, config, auth.command);
  const started = Date.now();
  const stdout = await collect(
    invocation.command,
    invocation.args,
    task.cwd,
    invocation.env,
    task.task,
    config.timeoutMs,
    signal,
  );
  return {
    target: task.target,
    text: parseWorkerOutput(task.target, stdout),
    durationMs: Date.now() - started,
  };
}
