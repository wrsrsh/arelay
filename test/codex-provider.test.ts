import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  codexProvider,
  codexProviderEnvironment,
  providerCredential,
} from "../src/native/codex-provider.js";
import { nativeAuth, runNativeTask } from "../src/native/worker.js";
import { defaultNativeConfig } from "../src/native/types.js";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "arelay-provider-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
test("Configured Azure provider works without ChatGPT login and is not overridden", async (t) => {
  const dir = await fixture(t);
  const keyName = "ARELAY_TEST_PROVIDER_KEY",
    previous = process.env[keyName];
  process.env[keyName] = "test-provider-value";
  t.after(() => {
    if (previous === undefined) delete process.env[keyName];
    else process.env[keyName] = previous;
  });
  await writeFile(
    join(dir, "config.toml"),
    `model="deployment-name"\nmodel_provider="azure"\n[model_providers.azure]\nname="Azure fixture"\nbase_url="https://azure.example/openai/v1"\nwire_api="responses"\nenv_key="${keyName}"\n[model_providers.azure.env_http_headers]\napi-key="${keyName}"\n[mcp_servers.arelay]\ncommand="arelay"\n`,
  );
  const command = join(dir, "codex");
  await writeFile(
    command,
    `#!/usr/bin/env node
const args=process.argv.slice(2);
if(args[0]==='login') { console.error('Not logged in'); process.exit(1); }
if(args.includes('--ignore-user-config')||args.some(a=>a.includes('model_provider=')||a.includes('forced_login_method='))) process.exit(2);
if(!args.includes('mcp_servers.arelay.enabled=false')||process.env.${keyName}!=='test-provider-value') process.exit(3);
process.stdin.resume(); process.stdin.on('end',()=>{console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'configured provider used'}}));console.log(JSON.stringify({type:'turn.completed'}));});
`,
  );
  await chmod(command, 0o755);
  const status = await nativeAuth("codex", command, undefined, dir);
  assert.equal(status.ready, true);
  assert.equal(status.subscription, false);
  assert.equal(status.authKind, "configured-provider");
  assert.ok(!JSON.stringify(status).includes("test-provider-value"));
  const result = await runNativeTask(
    { target: "codex", task: "test", cwd: dir },
    {
      ...defaultNativeConfig,
      enabled: true,
      codex: { command, configDir: dir },
    },
  );
  assert.equal(result.text, "configured provider used");
});
test("Only selected provider variables are discovered and credential precedence is explicit", async (t) => {
  const dir = await fixture(t),
    file = join(dir, "credentials.env");
  await writeFile(
    file,
    "# private\nSELECTED_KEY='from-file'\nOTHER_KEY=ignored\n",
  );
  let lookups = 0;
  const opts = {
    credentialFile: file,
    environment: { SELECTED_KEY: "from-env" },
    keychain: async () => {
      lookups++;
      return "from-keychain";
    },
  };
  assert.equal(await providerCredential("SELECTED_KEY", opts), "from-env");
  assert.equal(
    await providerCredential("SELECTED_KEY", { ...opts, environment: {} }),
    "from-file",
  );
  assert.equal(
    await providerCredential("MISSING_KEY", { ...opts, environment: {} }),
    "from-keychain",
  );
  assert.equal(lookups, 1);
  await assert.rejects(providerCredential("invalid-name", opts), /Invalid/);
  const provider = await codexProvider(dir);
  assert.equal(provider.id, "openai");
  assert.equal(provider.configured, false);
  assert.deepEqual(provider.envNames, []);
  const env = await codexProviderEnvironment(provider, dir);
  assert.equal(env.CODEX_HOME, dir);
  assert.equal(env.OTHER_KEY, undefined);
});
test("Profile-selected provider metadata is preserved without exposing inline credentials", async (t) => {
  const dir = await fixture(t);
  await writeFile(
    join(dir, "config.toml"),
    'profile="work"\nmodel_provider="openai"\n[profiles.work]\nmodel_provider="custom"\n[model_providers.custom]\nname="Work"\nbase_url="https://example.test/v1"\n[model_providers.custom.http_headers]\napi-key="INLINE_PRIVATE_VALUE"\n',
  );
  const provider = await codexProvider(dir);
  assert.equal(provider.id, "custom");
  assert.equal(provider.requiresLogin, false);
  assert.ok(!JSON.stringify(provider).includes("INLINE_PRIVATE_VALUE"));
});
