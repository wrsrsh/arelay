import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "smol-toml";
import {
  claudeSubagent,
  codexAgentRole,
  presentation,
} from "../src/native/agents.js";

test("Claude gets a codex subagent that only wraps the delegate tool", () => {
  const text = claudeSubagent();
  const [, frontmatter, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)!;
  const fields = Object.fromEntries(
    frontmatter!
      .split("\n")
      .map((line) => line.split(/:\s(.*)/s).slice(0, 2) as [string, string]),
  );
  assert.equal(fields.name, "codex");
  assert.match(fields.description!, /Use proactively/);
  assert.equal(fields.tools, "mcp__arelay__delegate");
  assert.equal(fields.model, "haiku");
  assert.match(body!, /exactly once/);
  assert.match(body!, /verbatim/);
  assert.match(body!, /leave out anything inside <system-reminder> tags/);
  assert.ok(!/arelay/i.test(fields.description!), "no relay wording");
});

test("Codex gets a claude agent role that only wraps the delegate tool", () => {
  const role = parse(codexAgentRole()) as Record<string, unknown>;
  assert.equal(role.name, "claude");
  assert.match(String(role.description), /Use proactively/);
  assert.equal(role.sandbox_mode, undefined, "Codex roles ignore sandbox_mode");
  assert.equal(role.model_reasoning_effort, "low");
  assert.match(String(role.developer_instructions), /exactly once/);
  assert.match(String(role.developer_instructions), /verbatim/);
  assert.ok(!/arelay/i.test(String(role.description)), "no relay wording");
});

for (const client of ["claude", "codex"] as const)
  test(`${client}: MCP instructions present the other CLI as a native subagent and stay within Claude's 2048-character limit`, () => {
    const { instructions, tool } = presentation(client);
    const other = client === "claude" ? "codex" : "claude";
    assert.ok(instructions.length <= 2048 && tool.length <= 2048);
    assert.match(
      instructions,
      client === "claude"
        ? /Agent tool \(subagent_type: "codex"\)/
        : /spawn_agent \(agent_type: "claude"\)/,
    );
    assert.match(instructions, /Delegate more readily/);
    assert.match(instructions, new RegExp(`${other} subagent`));
    assert.match(instructions, /read-only/);
    assert.match(tool, /prefer launching that subagent/);
  });
