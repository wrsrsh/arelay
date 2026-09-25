import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureNativeToken,
  nativeAuthorized,
  nativeTokenPath,
  readNativeToken,
} from "../src/native/access.js";

test("Native worker access uses a private stable local key, not provider credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "arelay-access-")),
    old = process.env.ARELAY_HOME;
  process.env.ARELAY_HOME = dir;
  try {
    const token = await ensureNativeToken();
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.equal(await ensureNativeToken(), token);
    assert.equal((await stat(nativeTokenPath())).mode & 0o777, 0o600);
    assert.equal(nativeAuthorized(`Bearer ${token}`, token), true);
    assert.equal(nativeAuthorized(undefined, token), false);
    assert.equal(nativeAuthorized("Bearer wrong", token), false);
    await chmod(nativeTokenPath(), 0o644);
    await assert.rejects(readNativeToken(), /private regular file/);
  } finally {
    if (old === undefined) delete process.env.ARELAY_HOME;
    else process.env.ARELAY_HOME = old;
    await rm(dir, { recursive: true, force: true });
  }
});
