# arelay reference

For installation and the interactive setup, start with the [README](../README.md).

## Native CLI setup (default)

`arelay setup` has two normal choices: select the clients, then connect. Running
`arelay` without arguments does the same in a terminal, or prints help when input
or output is redirected. Model overrides and workspace edits are optional actions
on the confirmation screen. API configuration is an explicit advanced option.

Native mode registers a stdio MCP server named `arelay`. Each selected client gets
a `delegate` tool targeting the other CLI. It does not intercept built-in agents,
change main-model providers, translate subscription requests, or copy login tokens.
The parent must call arelay's tool and supply a self-contained task and workspace
path. Native workers do not receive the parent's transcript automatically.

Sign in using `codex login` or `claude auth login` in the original CLI. arelay only
checks the CLI's reported login status. It does not offer its own Claude.ai OAuth
flow or read credential/token files. Native CLI usage remains subject to the
provider's terms and subscription quotas. This is an end-user CLI delegation
workflow, not a subscription-backed API service.

The selected worker binaries must be installed. You can register connections
before signing in, but delegation will refuse to run until the target CLI reports
a subscription login. API credentials are not silently substituted.

### Permissions and isolation

Workers are read-only by default. To allow edits, explicitly enable workspace edits
in setup; the parent must also request `permission: "workspace-write"` on that call.
Codex uses its read-only/workspace-write sandbox with approval requests denied.
Claude uses plan/acceptEdits mode, a restricted set of file tools, and denies
permission requests that would require interactive approval. Permission bypass
flags are never enabled. These workers are not an unrestricted copy of every
interactive CLI capability.

The worker process does not inherit API keys, OAuth token environment overrides,
or unrelated secrets from the daemon. The CLI itself reads its own login. User API
provider settings are not inherited: Codex uses the OpenAI/ChatGPT provider and
Claude uses the first-party endpoint. Nested arelay MCP delegation is disabled.
This intentionally avoids billing an accidentally inherited Azure/API key and
prevents recursive workers. Project context should be included explicitly.

Each task has a timeout, a 4MB captured-output limit, and a concurrency cap. Worker
process groups are terminated on cancellation/timeout. The daemon returns final
text rather than complete internal transcripts. Native worker requests require a
random local service key in `native-token` (owner-only permissions). The MCP tool
and `arelay delegate` read this file; it is unrelated to provider credentials.
Processes running as your user can read it, so this is not a sandbox against
untrusted programs running under the same account.

Native settings live in the existing config's `native` block. Setup records
absolute CLI paths, optional model overrides, `allowWrites` (false by default),
`timeoutMs` (600000), and `maxConcurrent` (3). Reconnect after moving/removing CLI
executables. Run `arelay doctor` to check login status.

### Connections and migration

Claude's MCP entry is in `~/.claude.json` or `$CLAUDE_CONFIG_DIR/.claude.json`.
Codex's entry is in `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`).
Only arelay's owned MCP entry is removed by native disconnect; unrelated edits
are preserved. No complete account/config snapshot is stored in native metadata.

If arelay previously installed API routing, run `arelay unsetup claude` and/or
`arelay unsetup codex` before connecting those clients in native mode. Existing
unowned MCP entries are never overwritten. Other bridges are not removed;
any built-in-agent routing they installed remains separate from arelay's tool.

## Advanced API setup

`arelay setup --api` retains the API-backed model-swapping integration. Standard
OpenAI/Anthropic APIs are listed first. Azure is an advanced choice that asks for
your versioned endpoint and deployment name. Existing personal endpoints do not
choose the default integration mode.

This setup can save keys privately, configure clients, or save backends only. It
preflights changes and asks before writing. Missing API keys or an incompatible
bridge prevent activation but still allow saving the draft. A key present only
in your shell is not available to a login service unless you explicitly save it.
Unselected clients are not disabled; existing routes can be affected by changed
backend settings. Suggested models are not checked against your account.

### Unattended installation

Use `arelay install --no-interactive` or `ARELAY_NO_TUI=1` to skip prompts. CI,
redirected input/output, and `TERM=dumb` are noninteractive. Explicit
`arelay setup claude|codex|both` commands keep their legacy noninteractive API-mode behavior; use bare `arelay setup` for native CLI connections.
`NO_COLOR=1` removes colors without disabling keyboard navigation.

The curl installer reopens `/dev/tty` only when output is a terminal and CI and
opt-out flags are absent. This lets `curl | sh` accept keyboard input without
reading the installation script as answers. Cancelling leaves the binary
installed, but does not save wizard configuration or install a service.

Installer options:

| Variable                | Purpose                                                      |
| ----------------------- | ------------------------------------------------------------ |
| `ARELAY_PREFIX`         | Installation prefix; defaults to `~/.local`                  |
| `ARELAY_VERSION=v0.3.0` | Pin a release instead of downloading the latest              |
| `ARELAY_NO_SERVICE=1`   | Install the binary only; skip setup and service installation |
| `ARELAY_NO_TUI=1`       | Install/start the service without opening the wizard         |

Homebrew installs the CLI and Node. `arelay install` is the second part of the
Homebrew installation command. Do not also use `brew services` for arelay.

## API configuration

Files live under `~/.config/arelay/`; `ARELAY_HOME` overrides that directory.
`arelay init` creates a default config without starting a service or editing clients.

```json
{
  "version": 1,
  "mode": "api",
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

`baseUrl` includes the version path, usually `/v1`. Route aliases are local
identifiers; arelay replaces them with the backend's model ID. Changing an alias
or a client's routing parameters may require restoring that client before setup.
Restart the service after editing config or credentials outside the wizard.

### Credentials

```dotenv
OPENAI_API_KEY=your-openai-api-key
ANTHROPIC_API_KEY=your-anthropic-api-key
```

Save keys in `credentials.env`, not `config.json`. Use `umask 077` before creating
the file, or `chmod 600 ~/.config/arelay/credentials.env` afterward. The file
accepts `NAME=value`, comments, and optionally quoted values. It is never evaluated
as a shell script. Wizard-entered keys cannot contain whitespace or quotes.

Runtime lookup order is process environment, `credentials.env`, then macOS
Keychain. A Keychain generic-password item's service name must match `apiKeyEnv`.
The wizard identifies persistent credentials without reading Keychain passwords.

Generated Codex providers send unauthenticated requests to the loopback relay.
When no client authentication is supplied, arelay adds its configured OpenAI
backend key. This allows keys saved by the wizard to work without exporting them
again in Codex's shell. Existing explicit custom-provider authentication remains
unchanged. Claude main-model requests keep their existing client authentication.

### Azure AI Foundry

Choose Azure in the wizard, or use this `openai` block:

```json
{
  "baseUrl": "https://YOUR-RESOURCE.services.ai.azure.com/openai/v1",
  "model": "YOUR-DEPLOYMENT",
  "apiKeyEnv": "AZURE_OPENAI_API_KEY",
  "authHeader": "api-key"
}
```

The model is your deployment name. Add `AZURE_OPENAI_API_KEY` through the wizard,
credentials file, or Keychain. For Codex, this URL must match the current provider's
upstream `base_url` before setup. The wizard can suggest a compatible backend
from your existing Codex config; it does not copy arbitrary custom headers.

## API-mode client integration

### Claude Code

The setup sets `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_SUBAGENT_MODEL`, and
`CLAUDE_CODE_SUBAGENT_MODEL_FORCE` in the user settings. Non-alias requests pass
through to Anthropic. Alias requests are translated to the OpenAI backend.
`ENABLE_TOOL_SEARCH=false` disables deferred tool definitions for the session.

The force flag requires Claude Code 2.1.257+. Forks and skills explicitly using
`model: inherit` can still use the main model. Claude Code can emit a one-time
`unrecognized_model` diagnostic for arelay's alias; native smoke tests verify
that those subagents still execute.

### Codex

Codex supports per-role model overrides, but not per-role providers. Setup points
its existing Responses provider at arelay and installs a compatibility catalog.
Existing custom catalogs are copied; otherwise a bundled upstream snapshot is used.
The original files are not edited.

The compatibility catalog registers the Claude alias and changes the routed
session to standard Responses transport, direct function tools, and v1 agents.
Hosted web search is disabled, including for the main model. arelay rewrites only
the built-in `spawn_agent` model argument to select Claude. The main model ID stays
on its original backend. This replaces Responses Lite, code-mode-only tools, and
v2 agent tools; do not opt in if you need those workflows.

Existing default/explorer/worker and custom role configs also receive model
overrides. Their source files are read and copied. Explicit explorer configuration
can replace some built-in defaults. Newly added roles, project/CLI overrides,
and inactive profiles are not guaranteed coverage.

API keys are required for cross-provider requests. Claude subscription credentials
are not reused and ChatGPT subscription endpoints are not proxied.

## Recovery

`arelay unsetup claude` and `arelay unsetup codex` restore the original config.
Restart the affected clients afterward. Backups are in `state/` under arelay's
config directory. Restoration refuses to erase settings edited after setup.
Preserve your edits and reconcile them with `original.backup`; do not delete the
backup first. TOML formatting can change during setup, but restore recovers the
original bytes.

Interactive setup preflights every selected client before writing. If a later
client fails, it attempts to roll back only changes made by that invocation.
Concurrent edits and uncertain partial installs are preserved for recovery,
not overwritten. This is not a crash-atomic multi-file transaction. Any private
recovery snapshots and incomplete setup paths are reported in the error.

Service activation happens after config/client writes. A service failure is
reported separately; the successful file changes remain saved. Explicit scripted
`setup both` and `unsetup both` process clients sequentially, without the wizard's
batch rollback.

Restore clients before stopping or uninstalling the relay. Their main-model
traffic also fails when they point at a stopped arelay.

## Background service

```sh
arelay service install
arelay service start
arelay service stop
arelay service restart
arelay service uninstall
arelay serve                 # foreground; stop the service first
```

- macOS uses `~/Library/LaunchAgents/dev.arelay.plist`, with startup at login and
  launchd keepalive. Logs are in `~/.config/arelay/logs/service.log`.
- Linux uses the systemd user service `arelay.service`. Read logs with
  `journalctl --user -u arelay`. To keep it running after logout, enable lingering
  with `loginctl enable-linger "$USER"` if your system permits it.
- Reinstall the service if you move its executable or remove its Node version.
  `arelay status` checks the listener; `arelay doctor` checks local prerequisites,
  not provider account access.

## API protocol limits

Text, images, full conversation history, function tools/results, Responses tool
namespaces, and Codex free-form tools such as `apply_patch` are supported.
Text streams live. Tool arguments may be buffered until a call finishes to avoid
mixing parallel calls across incompatible streaming formats.

Cross-provider requests reject hosted/server tools, deferred tool search,
citations, audio, provider file IDs, structured-output constraints, and opaque
compaction blocks. Stateful Responses sessions, stored conversations,
`previous_response_id`, automatic truncation, and `/responses/compact` are not
supported. Start a fresh delegated task before its context fills up. Main-model
compaction passes through.

Thinking blocks are omitted. Reasoning settings, cache placement, and token
accounting are not equivalent across providers. The Claude alias uses a 200k
context estimate; adjust it if your chosen backend has a smaller limit. Claude
count-token requests for the OpenAI alias return an estimate marked with
`x-arelay-token-count: estimate`.

## Security and verification

The listener binds only to `127.0.0.1`. Unexpected Host headers and browser-origin
requests are rejected. There is no telemetry, and counters do not contain prompts
or credentials. Other local processes can access the listener and spend your API
keys. Do not expose it through a tunnel or treat it as a multi-user auth boundary.

Only destination credentials are used for translated requests. Source auth and
beta headers are not sent to the other provider. Backends require HTTPS except
loopback test servers. Redirects are not followed. The destination receives the
delegated conversation, system instructions, and tool definitions.

Tests cover fake native CLIs, auth-state parsing, process cancellation, read-only
permissions, real MCP client/server communication, configuration preservation,
and the separate API routing implementation. Claude Code 2.1.281 and Codex 0.156.1
are the tested native command interfaces. A read-only Claude worker was also
verified manually with an existing Max login; CI never uses real credentials.
The CI matrix covers macOS/Linux and Node 22/24. PTY tests exercise keyboard input,
API-key masking, cancellation, cursor restoration, `NO_COLOR`, and piped install.

`arelay stats` counts native task attempts separately from API requests. Counters
reset when the daemon restarts. Status/stats polling does not increment active
work. All-zero counters mean no delegation/API work has reached this daemon; for
native mode, restart connected clients and explicitly ask them to use `delegate`.

See [SECURITY.md](../SECURITY.md) for reporting vulnerabilities.
