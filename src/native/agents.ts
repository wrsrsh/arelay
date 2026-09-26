import { stringify } from "smol-toml";
import type { NativeClient } from "./types.js";

/**
 * How each connected client sees the other CLI: as one of its own subagents.
 * Claude Code gets a `codex` subagent (Agent tool); Codex gets a `claude`
 * agent role (spawn_agent). Both wrap arelay's `delegate` tool, so the parent
 * never has to mention arelay.
 */
export const target = (client: NativeClient): NativeClient =>
  client === "claude" ? "codex" : "claude";
const label: Record<NativeClient, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

const DELEGATION_BIAS = (who: NativeClient) =>
  `Delegate more readily than you otherwise would. Whenever a piece of work is self-contained, such as a code review, a second opinion, research or a codebase question, a spike, an independent implementation slice, or anything that can run in parallel with your own work, hand it to a subagent instead of doing it inline, and use the ${who} subagent for this as freely as your built-in ones. Give every subagent the full context it needs: the goal, relevant paths, constraints, and the workspace directory. Nothing is inherited from your transcript.`;

export function presentation(client: NativeClient): {
  instructions: string;
  tool: string;
} {
  const other = target(client);
  const launch =
    client === "claude"
      ? `A \`${other}\` subagent is installed. Launch it with the Agent tool (subagent_type: "${other}") exactly like any other subagent; it runs ${label[other]} with its own login and returns its final answer.`
      : `A \`${other}\` agent is installed. Spawn it with spawn_agent (agent_type: "${other}") exactly like any other agent; it runs ${label[other]} with its own login and reports back its final answer.`;
  return {
    instructions: `${launch}\n${DELEGATION_BIAS(other)}\nOnly call the delegate tool directly if the ${other} subagent type is unavailable. Workers are read-only unless workspace writes were explicitly enabled.`,
    tool: `Run a self-contained task in a ${label[other]} worker and return its final answer. This is what the ${other} subagent uses; prefer launching that subagent instead of calling this directly. Uses the ${label[other]} CLI's own login and provider. Pass the complete task and the workspace directory. Read-only by default.`,
  };
}

/** The Claude Code subagent definition for Codex (~/.claude/agents/codex.md). */
export function claudeSubagent(): string {
  return `---
name: codex
description: OpenAI Codex running as a subagent. Use proactively for code review, second opinions, research, codebase questions, spikes, and independent implementation slices, and to run work in parallel with your own. It only receives the prompt you give it, so include the goal, relevant paths, constraints, and the workspace directory.
tools: mcp__arelay__delegate
model: haiku
---

You are a thin wrapper around a Codex worker. You do not do the task yourself.

1. Call \`mcp__arelay__delegate\` exactly once. Put the task you were given in \`task\`, complete and unchanged, but leave out anything inside <system-reminder> tags and any other harness or environment context; those are not part of the task. Pass \`cwd\` only when the task names a workspace directory. Use \`permission: "workspace-write"\` only when the task explicitly asks for file edits.
2. Return the tool result as your final message, verbatim and complete. Do not summarize, reformat, or add commentary.
3. If the tool reports an error, return that error text as-is.
`;
}

/** The Codex agent role for Claude Code ($CODEX_HOME/agents/claude.toml). */
export function codexAgentRole(): string {
  return stringify({
    name: "claude",
    description:
      "Claude Code running as an agent. Use proactively for code review, second opinions, research, codebase questions, spikes, and independent implementation slices, and to run work in parallel with your own. It only receives the prompt you give it, so include the goal, relevant paths, constraints, and the workspace directory.",
    nickname_candidates: ["Claude", "Claude Code"],
    model_reasoning_effort: "low",
    developer_instructions: `You are a thin wrapper around a Claude Code worker. You do not do the task yourself.
1. Call the arelay MCP tool \`delegate\` exactly once. Put the task you were given in \`task\`, complete and unchanged, but leave out any harness or environment context that is not part of the task. Pass \`cwd\` only when the task names a workspace directory. Use \`permission: "workspace-write"\` only when the task explicitly asks for file edits.
2. Return the tool result as your final message, verbatim and complete. Do not summarize, reformat, or add commentary.
3. If the tool reports an error, return that error text as-is.`,
  });
}
