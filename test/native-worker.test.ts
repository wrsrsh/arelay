import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildWorkerInvocation,
  nativeAuth,
  parseWorkerOutput,
  runNativeTask,
  workerEnvironment,
} from "../src/native/worker.js";
import { defaultNativeConfig } from "../src/native/types.js";

async function fake(
  t: { after: (fn: () => Promise<void>) => void },
  client: "claude" | "codex",
  mode = "ok",
) {
  const dir = await mkdtemp(join(tmpdir(), "arelay-worker-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const command = join(dir, client);
  await writeFile(
    command,
    `#!/usr/bin/env node
const args=process.argv.slice(2);
if(args[0]==='login'||args[0]==='auth') {
 if(${JSON.stringify(client)}==='codex') console.error(${JSON.stringify(mode === "api" ? "Logged in using an API key" : "Logged in using ChatGPT")});
 else console.log(JSON.stringify({loggedIn:true,authMethod:${JSON.stringify(mode === "api" ? "api_key" : "claude.ai")},email:'private@example.test'}));
} else {
 let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
 if(${JSON.stringify(mode)}==='hang') {setInterval(()=>{},1000);return;}
 if(${JSON.stringify(mode)}==='fail') {console.error('DO_NOT_LEAK');process.exit(1);}
 if(${JSON.stringify(mode)}==='flood') {process.stdout.write('x'.repeat(5*1024*1024));return;}
 if(${JSON.stringify(client)}==='claude') console.log(JSON.stringify({type:'result',is_error:false,result:'done '+input}));
 else {console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'done '+input}}));console.log(JSON.stringify({type:'turn.completed'}));}
 });
}
`,
  );
  await chmod(command, 0o755);
  return {
    dir,
    command,
    config: {
      ...defaultNativeConfig,
      enabled: true,
      [client]: { command, configDir: dir },
    },
  };
}
for (const target of ["claude", "codex"] as const) {
  test(`${target} checks CLI auth without exposing account details`, async (t) => {
    const f = await fake(t, target);
    const status = await nativeAuth(target, f.command, undefined, f.dir);
    assert.equal(status.subscription, true);
    assert.ok(!JSON.stringify(status).includes("private@example"));
  });
  test(`${target} uses native login and returns only final text`, async (t) => {
    const f = await fake(t, target);
    const result = await runNativeTask(
      { target, task: "hello", cwd: f.dir },
      f.config,
    );
    assert.equal(result.text, "done hello");
    assert.equal(result.target, target);
  });
  test(`${target} respects its supported native authentication`, async (t) => {
    const f = await fake(t, target, "api");
    if (target === "codex") {
      const result = await runNativeTask(
        { target, task: "hi", cwd: f.dir },
        f.config,
      );
      assert.equal(result.text, "done hi");
    } else
      await assert.rejects(
        runNativeTask({ target, task: "hi", cwd: f.dir }, f.config),
        /subscription login/,
      );
  });
}
test("Native worker environment excludes credentials, provider overrides and recursive session guards", () => {
  const env = workerEnvironment("/path/codex", {
    HOME: "/home",
    PATH: "/bin",
    OPENAI_API_KEY: "secret",
    ANTHROPIC_API_KEY: "secret",
    CLAUDE_CODE_OAUTH_TOKEN: "secret",
    ANTHROPIC_BASE_URL: "http://proxy",
    CLAUDECODE: "1",
    GITHUB_TOKEN: "private",
    CODEX_HOME: "/codex",
  });
  assert.equal(env.HOME, "/home");
  assert.equal(env.CODEX_HOME, "/codex");
  assert.equal(env.ARELAY_NATIVE_WORKER, "1");
  assert.ok(!JSON.stringify(env).includes("secret"));
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.CLAUDECODE, undefined);
});
test("Invocation keeps task out of argv and never bypasses permissions", () => {
  for (const target of ["claude", "codex"] as const) {
    const invocation = buildWorkerInvocation(
      { target, task: "secret task", cwd: "/tmp" },
      defaultNativeConfig,
      `/bin/${target}`,
    );
    assert.ok(!invocation.args.join(" ").includes("secret task"));
    assert.ok(!invocation.args.join(" ").includes("bypass"));
    assert.ok(!invocation.args.includes("--bare"));
    if (target === "codex") {
      assert.ok(!invocation.args.includes("--ignore-user-config"));
      assert.ok(
        !invocation.args.some(
          (arg) =>
            arg.includes("model_provider=") ||
            arg.includes("forced_login_method="),
        ),
      );
    }
    assert.throws(
      () =>
        buildWorkerInvocation(
          { target, task: "hi", cwd: "/tmp", permission: "workspace-write" },
          defaultNativeConfig,
          `/bin/${target}`,
        ),
      /disabled/,
    );
  }
});
test("Timeout, cancellation, exit errors and output limits are bounded and sanitized", async (t) => {
  const f = await fake(t, "codex", "hang");
  await assert.rejects(
    runNativeTask(
      { target: "codex", task: "hi", cwd: f.dir },
      { ...f.config, timeoutMs: 100 },
    ),
    /timed out/,
  );
  const controller = new AbortController();
  const pending = runNativeTask(
    { target: "codex", task: "hi", cwd: f.dir },
    f.config,
    controller.signal,
  );
  setTimeout(() => controller.abort(), 200);
  await assert.rejects(pending, /cancelled|abort/i);
  const bad = await fake(t, "claude", "fail");
  await assert.rejects(
    runNativeTask({ target: "claude", task: "hi", cwd: bad.dir }, bad.config),
    (e) => {
      assert.ok(!(e as Error).message.includes("DO_NOT_LEAK"));
      return true;
    },
  );
  const flood = await fake(t, "claude", "flood");
  await assert.rejects(
    runNativeTask(
      { target: "claude", task: "hi", cwd: flood.dir },
      flood.config,
    ),
    /output limit/,
  );
});
test("Malformed or failed native results are not reported as success", () => {
  assert.throws(
    () => parseWorkerOutput("codex", '{"type":"turn.failed"}'),
    /failed/,
  );
  assert.throws(() => parseWorkerOutput("codex", "{}"), /without completing/);
  assert.throws(
    () => parseWorkerOutput("claude", '{"type":"result","is_error":true}'),
    /not complete/,
  );
});
