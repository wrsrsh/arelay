import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { defaultConfig } from "../src/config.js";
import { defaultNativeConfig } from "../src/native/types.js";
import { createRelay } from "../src/server.js";

test(
  "Real MCP client discovers and calls native delegation through the daemon",
  { timeout: 20000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "arelay-mcp-"));
    const config = structuredClone(defaultConfig);
    config.native = { ...defaultNativeConfig, enabled: true };
    const token = "a".repeat(64);
    const relay = createRelay(
      config,
      undefined,
      async (task) => {
        assert.equal(task.target, "codex");
        assert.equal(task.permission, "read-only");
        return {
          target: task.target,
          text: `worker received: ${task.task}`,
          durationMs: 1,
        };
      },
      token,
    );
    await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
    config.port = (relay.address() as { port: number }).port;
    await writeFile(join(dir, "config.json"), JSON.stringify(config));
    await writeFile(join(dir, "native-token"), token, { mode: 0o600 });
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    env.ARELAY_HOME = dir;
    delete env.ARELAY_NATIVE_WORKER;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        resolve("src/cli.ts"),
        "mcp",
        "--client",
        "claude",
      ],
      env,
      stderr: "pipe",
    });
    const client = new Client({ name: "arelay-test", version: "1" });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      assert.equal(tools.tools[0]!.name, "delegate");
      const result = await client.callTool({
        name: "delegate",
        arguments: { task: "inspect this", cwd: dir },
      });
      assert.notEqual(result.isError, true);
      assert.deepEqual(result.content, [
        { type: "text", text: "worker received: inspect this" },
      ]);
    } finally {
      await client.close();
      await transport.close();
      relay.closeAllConnections();
      await new Promise<void>((r) => relay.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
