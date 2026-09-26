import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultConfig } from "../src/config.js";
import { VERSION } from "../src/version.js";
const exec = promisify(execFile);
const cli = resolve("src/cli.ts");

async function isolated(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "arelay-ui-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv & {
    ARELAY_HOME: string;
    CLAUDE_CONFIG_DIR: string;
    CODEX_HOME: string;
  } = {
    ...process.env,
    ARELAY_HOME: join(dir, "arelay"),
    CLAUDE_CONFIG_DIR: join(dir, "claude"),
    CODEX_HOME: join(dir, "codex"),
  };
  delete env.ARELAY_PTY_OPENAI_KEY;
  delete env.ARELAY_PTY_ANTHROPIC_KEY;
  return { dir, env };
}

test("Non-TTY help/version never start a wizard or create configuration", async (t) => {
  const { dir, env } = await isolated(t);
  const help = await exec(process.execPath, ["--import", "tsx", cli], { env });
  assert.match(help.stdout, /Connect your CLIs/);
  assert.ok(!help.stdout.includes("\x1b"));
  const version = await exec(
    process.execPath,
    ["--import", "tsx", cli, "--version"],
    { env },
  );
  assert.equal(version.stdout.trim(), VERSION);
  assert.deepEqual(await readdir(dir), []);
});
test("Non-TTY setup exits promptly with a useful error and makes no changes", async (t) => {
  const { dir, env } = await isolated(t);
  await assert.rejects(
    exec(process.execPath, ["--import", "tsx", cli, "setup"], { env }),
    (error: unknown) => {
      assert.match((error as { stderr: string }).stderr, /needs a terminal/);
      return true;
    },
  );
  assert.deepEqual(await readdir(dir), []);
});
test("Invalid install arguments are rejected before installing a service", async (t) => {
  const { dir, env } = await isolated(t);
  await assert.rejects(
    exec(process.execPath, ["--import", "tsx", cli, "install", "--unknown"], {
      env,
    }),
    /Usage: arelay install/,
  );
  assert.deepEqual(await readdir(dir), []);
});
for (const mode of ["escape", "ctrl-c", "no-color", "secret"])
  test(
    `Real PTY wizard: ${mode}, safe cancellation and terminal restoration`,
    { timeout: 50000 },
    async (t) => {
      const { dir, env } = await isolated(t);
      if (mode === "no-color") {
        env.NO_COLOR = "1";
        delete env.FORCE_COLOR;
      } else delete env.NO_COLOR;
      let original: string | undefined;
      if (mode === "secret") {
        const config = structuredClone(defaultConfig);
        config.openai.apiKeyEnv = "ARELAY_PTY_OPENAI_KEY";
        config.anthropic.apiKeyEnv = "ARELAY_PTY_ANTHROPIC_KEY";
        await mkdir(env.ARELAY_HOME, { recursive: true });
        original = JSON.stringify(config);
        await writeFile(join(env.ARELAY_HOME, "config.json"), original);
      }
      const result = await exec(
        "python3",
        [
          resolve("scripts/test-wizard-pty.py"),
          mode,
          process.execPath,
          "--import",
          "tsx",
          cli,
          "setup",
          ...(mode === "secret" ? ["--api"] : []),
        ],
        { env, timeout: 45000, maxBuffer: 100000 },
      );
      assert.match(result.stdout, /"passed": true/);
      if (original !== undefined) {
        assert.equal(
          await readFile(join(env.ARELAY_HOME, "config.json"), "utf8"),
          original,
        );
        assert.deepEqual(await readdir(env.ARELAY_HOME), ["config.json"]);
      } else assert.deepEqual(await readdir(dir), []);
    },
  );
