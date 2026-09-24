# arelay

**OpenAI subagents in Claude Code. Claude subagents in Codex.**

arelay is a local API translator and subagent router. Keep your main model in
its usual client, and send delegated work to the other provider. The client
still executes tools and applies its own permissions—arelay never executes
model-generated commands and does not launch a second coding CLI.

```text
Claude Code ── Messages API ──┐
                             │  arelay · 127.0.0.1:8788
                             ├── Claude requests → Anthropic
                             └── OpenAI requests → OpenAI / Azure
Codex ─────── Responses API ──┘
```

[![CI](https://github.com/wrsrsh/arelay/actions/workflows/ci.yml/badge.svg)](https://github.com/wrsrsh/arelay/actions/workflows/ci.yml)

**Early release:** tested with Claude Code **2.1.281** and Codex **0.156.1**.
Native-client smoke tests exercise real subagent creation against local mock
backends. They verify routing and tool protocols, not paid-provider model access.
Read [compatibility](#compatibility) before changing an existing setup.

## Install

### Homebrew

```sh
brew install wrsrsh/tap/arelay && arelay install
```

Homebrew installs Node and the CLI; `arelay install` starts and enables its login
service. Homebrew does not auto-start background services on package installation,
so keep both parts of this command. arelay manages its own service;
**do not also run `brew services start arelay`**.

### curl

Requires **Node.js 22+**, `curl`, and `tar`. No sudo.

```sh
curl -fsSL https://raw.githubusercontent.com/wrsrsh/arelay/main/install.sh | sh
```

To inspect the installer first:

```sh
curl -fsSLo /tmp/arelay-install.sh https://raw.githubusercontent.com/wrsrsh/arelay/main/install.sh
less /tmp/arelay-install.sh
sh /tmp/arelay-install.sh
```

The installer verifies the release archive's SHA-256 checksum, installs to
`~/.local/bin/arelay`, and starts the service. Add `~/.local/bin` to your PATH
if necessary. Set `ARELAY_PREFIX` to change the installation prefix,
`ARELAY_VERSION=v0.1.0` to pin a release, or `ARELAY_NO_SERVICE=1` to skip startup.

**Both installation commands start the service but leave your client settings alone.**
Configure credentials and backends, then opt in each client below.

## Configure

```sh
arelay init
# Edit ~/.config/arelay/config.json
# Add credentials to ~/.config/arelay/credentials.env
arelay service restart
arelay doctor
```

A minimal credentials file:

```dotenv
OPENAI_API_KEY=your-openai-api-key
ANTHROPIC_API_KEY=your-anthropic-api-key
```

Create it with private permissions (`umask 077` before creating it, or
`chmod 600 ~/.config/arelay/credentials.env`). Do not put keys in the JSON
configuration or commit them. The file accepts `NAME=value`, comments, and
optionally quoted values; it is **not a shell script** and is never evaluated.

Credential lookup: process environment, then `credentials.env`, then (on macOS)
a Keychain generic-password item whose service name matches `apiKeyEnv`.
A login service does **not** inherit exports from your interactive shell.

The generated configuration contains:

```json
{
  "version": 1,
  "port": 8788,
  "openai": {
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-5.4",
    "apiKeyEnv": "OPENAI_API_KEY",
    "authHeader": "authorization"
  },
  "anthropic": {
    "baseUrl": "https://api.anthropic.com/v1",
    "model": "claude-sonnet-4-6",
    "apiKeyEnv": "ANTHROPIC_API_KEY",
    "authHeader": "x-api-key"
  },
  "routes": {
    "claudeSubagentModel": "arelay-openai",
    "codexSubagentModel": "arelay-claude"
  },
  "requestTimeoutMs": 300000,
  "maxBodyBytes": 33554432
}
```

Choose model IDs available to your account. Route aliases are local identifiers;
arelay replaces them with the backend's actual model ID. Restart the service
after changing configuration or credentials. `ARELAY_HOME` overrides the
configuration directory.

### Azure AI Foundry

Replace the `openai` block with your Responses-compatible deployment:

```json
{
  "baseUrl": "https://YOUR-RESOURCE.services.ai.azure.com/openai/v1",
  "model": "YOUR-DEPLOYMENT",
  "apiKeyEnv": "AZURE_OPENAI_API_KEY",
  "authHeader": "api-key"
}
```

Add `AZURE_OPENAI_API_KEY` to the credentials file or Keychain.
For Codex, this URL must match its existing provider's `base_url` before setup.
arelay preserves the provider's existing authentication settings for main-model
requests.

## Enable routing

### Claude → OpenAI subagents

```sh
arelay setup claude
```

Restart Claude Code. arelay sets the subagent model and
`CLAUDE_CODE_SUBAGENT_MODEL_FORCE` in the user settings. Normal Claude requests
pass through to Anthropic with their original authentication; subagent requests
are translated to the configured OpenAI/Azure backend. Claude Code remains in
charge of tool execution. Setup disables deferred tool search for the session
(`ENABLE_TOOL_SEARCH=false`) so complete tool schemas are available for translation.

Claude Code's force flag requires **2.1.257+**. Forks and skills explicitly using
`model: inherit` can still use the main model. Claude Code may emit one
`unrecognized_model` diagnostic for the local alias; the native smoke test
confirms it can still execute that subagent. This is a client catalog diagnostic,
not an arelay routing error.

### Codex → Claude subagents

```sh
arelay setup codex
```

Restart Codex. Setup keeps the main model ID and the existing Responses provider's
authentication, but points its URL at arelay. It installs a **compatibility
catalog** that registers Claude as a valid subagent target. Existing custom
catalogs are copied rather than overwritten; otherwise a bundled upstream
catalog snapshot is used.

There are deliberate changes to the routed Codex session:

- Standard Responses transport, **direct function tools**, and **v1 multi-agent
  tools** replace Responses Lite, code-mode-only tools, and v2 agent tools.
- Hosted web search is disabled for the session, including the main model.
- arelay forces the built-in `spawn_agent` call's `model` argument to its Claude
  alias. Only those arguments are rewritten; the main model stays on its original
  backend. Function-call streaming remains intact for other tools.
- Existing default/explorer/worker and custom role configs also receive model
  overrides for clients that use role-based delegation. Existing role files are
  read and copied, never edited. Built-in explorer defaults can differ when an
  explicit role config is installed.

These changes make routing deterministic without rewriting code-mode programs.
Do not enable this integration if you need the original v2/code-mode workflow.
`arelay unsetup codex` restores the exact original config.

**API keys are required for cross-provider requests.** This release does not
reuse Claude subscription credentials or proxy ChatGPT subscription sessions.
Your existing Claude login can still authenticate ordinary Claude passthrough
requests. Standard OpenAI API-key providers and custom Azure Responses providers
are supported for Codex.

### Restore

```sh
arelay unsetup claude
arelay unsetup codex
```

Restart the clients afterward. Backups live under
`~/.config/arelay/state/`. Setup and restore refuse to overwrite settings that
have changed since installation. If that happens, preserve your edits and
manually reconcile them with `original.backup`; do not delete the backup first.
TOML comments/formatting may change during setup, but restore recovers the
original bytes. `setup both` and `unsetup both` process clients sequentially and
report each completed change; a failure does not undo the other client's change.

## Background service

```sh
arelay install                 # install/start the login service
arelay status
arelay stats
arelay doctor
arelay service start
arelay service stop
arelay service restart
arelay service uninstall
```

- **macOS:** `~/Library/LaunchAgents/dev.arelay.plist`, starts at login and is
  kept alive by launchd. Logs: `~/.config/arelay/logs/service.log`.
- **Linux:** systemd user service `arelay.service`, enabled at login with
  restart-on-failure. Logs: `journalctl --user -u arelay`. To keep it running
  after logout, use `loginctl enable-linger "$USER"` if your system permits it.
- Foreground/debugging: `arelay serve`. Stop the service first to avoid a port
  conflict. Reinstall the service if you move the executable or remove the Node
  version it was installed with.

**Restore client settings before stopping or uninstalling arelay.** Once clients
point at its local URL, a stopped relay also breaks their main-model traffic.

## Compatibility

Supported across providers:

- Text and image input, system/developer context, full conversation history.
- Client function tools, tool results, and Responses tool namespaces.
- Codex free-form tools such as `apply_patch` (wrapped as a string input for
  Anthropic, then returned as a proper `custom_tool_call`).
- Non-streaming responses, live text streaming, usage and stop reasons.
- Parallel function calls without mixing their arguments. Cross-provider tool
  arguments may be buffered until the individual call completes.

Not supported across providers:

- Hosted/server tools, tool search/deferred definitions, citations, audio,
  provider file IDs, structured-output constraints, or opaque compaction blocks.
  Setup disables Claude tool search with `ENABLE_TOOL_SEARCH=false`; avoid
  overriding that setting. Unsupported payloads fail explicitly.
- Stateful Responses sessions (`previous_response_id`, stored conversations),
  automatic truncation, or `/responses/compact`. Start a fresh delegated task
  before its context fills up. Main-model compaction passes through.
- Hidden reasoning replay, cache placement, or identical token accounting.
  Thinking blocks are omitted and reasoning/effort settings are not mapped
  between providers. Codex's Claude catalog uses a conservative 200k context
  estimate; adjust it if your selected backend has a smaller limit.
- Guaranteed coverage of project/CLI overrides, newly added role configs, or
  provider-specific UI features in desktop clients. Native CLI behavior is the
  tested baseline. Re-run setup after restoring if you add roles.

Claude token-count requests for the OpenAI alias return an estimate, marked with
`x-arelay-token-count: estimate`; it is not a tokenizer-accurate budget.

## Security

The listener binds to `127.0.0.1` only. Browser-origin requests and unexpected Host
headers are rejected. There is no remote listener option or telemetry. arelay
records counters, not prompts or credentials. **Other local processes can use
the listener and incur API charges**; this is a single-user local tool, not a
multi-user authentication boundary. Do not expose its port through a tunnel.

Cross-provider requests use only the destination provider's configured key.
Source authentication and beta headers are not forwarded to the other provider.
Backends require HTTPS, except loopback addresses used for local testing.
Redirects are not followed. The selected provider receives the delegated
conversation, system instructions, and tool schemas—review what you send.

## Develop

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm dev --help
pnpm build
node dist/arelay.mjs serve
```

Run native subagent smoke tests with both clients installed:

```sh
pnpm smoke:clients
```

These use temporary client homes and local mock backends. They make no paid model
requests and do not alter your real client configuration. CI runs unit,
translation, streaming, HTTP, setup, service-generation, and packaging checks on
macOS and Linux with Node 22 and 24.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

MIT. The bundled Codex model catalog is Apache-2.0; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
