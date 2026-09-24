# arelay reference

For installation and the interactive setup, start with the [README](../README.md).

## Terminal setup

`arelay setup` opens the wizard. Running `arelay` without arguments does the same
in a terminal, or prints help when output/input is redirected.

The wizard loads your current config without changing it. It lets you choose:

1. Clients to configure: both directions, Claude Code, Codex, or backends only.
2. OpenAI, Azure AI Foundry, Anthropic, or a compatible custom API endpoint.
3. Suggested model IDs or a model/deployment ID you enter yourself.
4. Existing credentials, masked new keys, or setup later.
5. Whether to install/restart the login service.
6. Save and activate, save backends only, edit selections, or cancel.

No configuration or credential files are written until the final confirmation.
The wizard checks client conflicts before enabling activation. Missing keys or
an existing incompatible bridge leave “save backends only” available. Model
suggestions are not an availability check; setup makes no provider API requests.

Unselected clients are not restored or disabled. Saving backends can affect any
clients that already point at arelay. Declining service startup leaves an existing
service running with its loaded settings until you restart it.

A key found only in the shell environment is not available to a login service.
The wizard offers to save it privately, but only after you select that option and
confirm. The input and routing preview never display the key.

### Unattended installation

Use `arelay install --no-interactive` or `ARELAY_NO_TUI=1` to skip prompts. CI,
redirected input/output, and `TERM=dumb` are noninteractive. Explicit
`arelay setup claude|codex|both` commands keep their noninteractive behavior.
`NO_COLOR=1` removes colors without disabling keyboard navigation.

The curl installer reopens `/dev/tty` only when output is a terminal and CI and
opt-out flags are absent. This lets `curl | sh` accept keyboard input without
reading the installation script as answers. Cancelling leaves the binary
installed, but does not save wizard configuration or install a service.

Installer options:

| Variable                | Purpose                                                      |
| ----------------------- | ------------------------------------------------------------ |
| `ARELAY_PREFIX`         | Installation prefix; defaults to `~/.local`                  |
| `ARELAY_VERSION=v0.2.1` | Pin a release instead of downloading the latest              |
| `ARELAY_NO_SERVICE=1`   | Install the binary only; skip setup and service installation |
| `ARELAY_NO_TUI=1`       | Install/start the service without opening the wizard         |

Homebrew installs the CLI and Node. `arelay install` is the second part of the
Homebrew installation command. Do not also use `brew services` for arelay.

## Configuration

Files live under `~/.config/arelay/`; `ARELAY_HOME` overrides that directory.
`arelay init` creates a default config without starting a service or editing clients.

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

## Client integration

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

## Protocol limits

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

Native subagent creation is tested with Claude Code 2.1.281 and Codex 0.156.1
against local mock backends. These tests check routing, not paid-provider access.
The CI matrix covers macOS/Linux and Node 22/24. PTY tests exercise masked input,
arrow keys, cancellation, cursor restoration, `NO_COLOR`, and piped installation.

See [SECURITY.md](../SECURITY.md) for reporting vulnerabilities.
