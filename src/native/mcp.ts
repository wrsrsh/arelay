import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { VERSION } from "../version.js";
import { readNativeToken } from "./access.js";
import type { NativeClient, NativeResult } from "./types.js";

export async function startNativeMcp(client: NativeClient): Promise<void> {
  if (process.env.ARELAY_NATIVE_WORKER)
    throw new Error("Nested arelay delegation is disabled");
  const target: NativeClient = client === "claude" ? "codex" : "claude";
  const server = new McpServer(
    { name: "arelay", version: VERSION },
    {
      instructions: `Use delegate when the user asks to delegate work to ${target}. This runs the installed native CLI with its own login, tools and permissions. It does not replace built-in subagents. Supply all task context explicitly. Workers are read-only unless workspace writes were explicitly enabled.`,
    },
  );
  server.registerTool(
    "delegate",
    {
      description: `Delegate a self-contained task to the native ${target} CLI. Uses that CLI's existing authentication; Codex keeps its configured provider, including Azure. No subscription tokens are copied or proxied. Pass the task context and the current workspace directory. Read-only by default.`,
      inputSchema: {
        task: z.string().min(1).max(200000),
        cwd: z.string().optional(),
        model: z.string().optional(),
        permission: z
          .enum(["read-only", "workspace-write"])
          .default("read-only"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ task, cwd, model, permission }, extra) => {
      const config = await loadConfig();
      const timeout = config.native?.timeoutMs ?? 600000;
      const signal = AbortSignal.any([
        extra.signal,
        AbortSignal.timeout(timeout + 15000),
      ]);
      let progress = 0;
      const timer = setInterval(() => {
        if (extra._meta?.progressToken !== undefined)
          void extra
            .sendNotification({
              method: "notifications/progress",
              params: {
                progressToken: extra._meta.progressToken,
                progress: ++progress,
                message: `${target} worker is running`,
              },
            })
            .catch(() => {});
      }, 15000);
      try {
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
              task,
              cwd: cwd || process.cwd(),
              model,
              permission,
            }),
            signal,
          },
        );
        const result = (await response.json()) as NativeResult & {
          error?: { message?: string };
        };
        if (!response.ok)
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: result.error?.message || "Native delegation failed",
              },
            ],
          };
        return { content: [{ type: "text", text: result.text }] };
      } catch {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: signal.aborted
                ? "Delegation cancelled or timed out"
                : "Cannot reach arelay. Run arelay service start and check arelay status.",
            },
          ],
        };
      } finally {
        clearInterval(timer);
      }
    },
  );
  await server.connect(new StdioServerTransport());
}
