# arelay

use codex from claude code, or claude code from codex.

arelay adds a `delegate` tool to each client. it runs the other installed CLI as
a worker, using that CLI's own authentication and tools. codex keeps its configured
provider, including azure. an already-working codex CLI doesn't need a separate
chatgpt login.

## install

```sh
brew install wrsrsh/tap/arelay && arelay install
```

or, with node 22+ installed:

```sh
curl -fsSL https://raw.githubusercontent.com/wrsrsh/arelay/main/install.sh | sh
```

works on macos and linux. the curl install goes into `~/.local/bin`.

## setup

if your CLIs already work, keep their existing setup. for subscription sign-in,
use `codex login` or `claude auth login` in the original CLI. then run:

```sh
arelay setup
```

choose a direction, then connect. it uses each CLI's default model, leaves your model providers alone, and starts arelay at login.
model overrides and workspace edits are optional. workers are read-only by default.

```text
arelay

  ● both directions
  ○ claude → codex
  ○ codex → claude
  ○ advanced: API keys / azure
```

restart the clients you connected, then ask one to use arelay's `delegate` tool.
for example: “use arelay to have codex review this module.” give the worker the
task context and workspace directory; it doesn't inherit the parent's transcript.

this is explicit delegation, not a silent replacement for every built-in
subagent. the worker has its own tools and permissions. arelay doesn't copy
subscription tokens or use them as API keys; sign-in stays in the unmodified CLI.

## using it

```sh
arelay status
arelay stats
arelay doctor
arelay delegate claude "review this directory without changing files"
```

stats count work since the service started. polling stats doesn't count as work.
use `--json` with `status` or `stats` if you want the raw data.

to remove a connection:

```sh
arelay unsetup claude
arelay unsetup codex
```

restart the affected clients afterward. stopping arelay makes its delegate tool
unavailable. API-mode clients also need their proxy settings restored before you
stop the service.

## API keys and azure

```sh
arelay setup --api
```

API mode swaps subagent models while keeping the parent's tool loop. it requires
provider API keys. azure is under advanced settings and asks for your OpenAI v1
endpoint and deployment ID; nothing is hardcoded to a particular deployment.
an existing azure-backed codex CLI also works directly in native mode. its declared
credential variables can come from the environment, arelay's credentials file,
or their named macos keychain items.

API mode changes codex to direct function tools/v1 agents and disables hosted web
search. it also disables claude's deferred tool search. hosted tools,
cross-provider compaction and reasoning replay aren't supported in that mode.

## other details

`arelay install --no-interactive` starts the service without setup prompts.
`NO_COLOR=1` disables colors. configuration lives in `~/.config/arelay/`.

native workers require an automatically generated local service key. other
processes running as your user can still use it. don't expose the listener through
a tunnel. subscription quotas and the original CLIs' permissions still apply.

[the reference](docs/reference.md) covers permissions, login isolation, API
configuration, service behavior and recovery.

```sh
pnpm install --frozen-lockfile
pnpm check
```

terminal tests need python 3.9+. see [contributing](CONTRIBUTING.md).

MIT, with third-party notices [here](THIRD_PARTY_NOTICES.md).
