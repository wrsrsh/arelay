import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRelay } from "../src/server.js";
import { defaultConfig } from "../src/config.js";
import { defaultNativeConfig } from "../src/native/types.js";
const listen = (s: http.Server) =>
  new Promise<number>((r) =>
    s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)),
  );
async function close(s: http.Server) {
  s.closeAllConnections();
  await new Promise<void>((r) => s.close(() => r()));
}

test("Status/stats requests do not count as active model work", async (t) => {
  const relay = createRelay(structuredClone(defaultConfig));
  const port = await listen(relay);
  t.after(() => close(relay));
  for (let i = 0; i < 4; i++) {
    await fetch(`http://127.0.0.1:${port}/health`);
    const stats = await (await fetch(`http://127.0.0.1:${port}/stats`)).json();
    assert.equal(stats.active, 0);
    assert.equal(stats.errors, 0);
  }
});
test("Native tasks update worker counters and active work; polling does not", async (t) => {
  let finish!: () => void;
  const gate = new Promise<void>((r) => {
    finish = r;
  });
  const config = structuredClone(defaultConfig);
  config.native = { ...defaultNativeConfig, enabled: true, maxConcurrent: 1 };
  const relay = createRelay(
    config,
    undefined,
    async (task) => {
      await gate;
      return { target: task.target, text: "done", durationMs: 1 };
    },
    "test-token",
  );
  const port = await listen(relay);
  t.after(() => close(relay));
  const call = () =>
    fetch(`http://127.0.0.1:${port}/native/delegate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-token",
      },
      body: JSON.stringify({ target: "codex", cwd: "/tmp", task: "read" }),
    });
  const unauthenticated = await fetch(
    `http://127.0.0.1:${port}/native/delegate`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
  );
  assert.equal(unauthenticated.status, 401);
  const first = call();
  let stats;
  for (let i = 0; i < 30; i++) {
    stats = await (await fetch(`http://127.0.0.1:${port}/stats`)).json();
    if (stats.active === 1) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(stats.active, 1);
  assert.equal(stats.nativeCodex, 1);
  assert.equal((await call()).status, 429);
  finish();
  assert.equal((await first).status, 200);
  stats = await (await fetch(`http://127.0.0.1:${port}/stats`)).json();
  assert.equal(stats.active, 0);
});
