# arelay

use codex from claude code, or claude code from codex.

arelay adds a `delegate` tool that runs the other installed CLI as a worker.
your existing CLI authentication and provider stay in place, including azure-backed
codex. an already-working codex CLI doesn't need a separate chatgpt login.

## install

```sh
brew install wrsrsh/tap/arelay && arelay install
```

or, with node 22+ installed:

```sh
curl -fsSL https://raw.githubusercontent.com/wrsrsh/arelay/main/install.sh | sh
```

works on macos and linux. the curl install goes into `~/.local/bin`.
have both CLIs installed and working first.

## connect and use

choose both directions, claude → codex, or codex → claude. selecting a direction
connects the clients and starts the service. escape or ctrl+c cancels before writes.

restart the clients you connected, then explicitly ask one to use `delegate`:
“use arelay to have codex review this module.” give the worker the task context
and workspace directory; it doesn't inherit the parent's transcript.
workers are read-only by default. built-in subagents stay unchanged.

```sh
arelay setup          # connect again
arelay status
arelay stats
arelay unsetup both   # disconnect; restart the clients afterward
```

stats count work since the service started.

[API mode](docs/reference.md#advanced-api-setup) uses `arelay setup --api` and
requires provider API keys. it changes codex to direct function tools/v1 agents
and disables hosted web search, including for the main model.

see [the reference](docs/reference.md) for permissions, service controls,
configuration and recovery, or [contributing](CONTRIBUTING.md) to work on arelay.

[MIT](LICENSE), with [third-party notices](THIRD_PARTY_NOTICES.md).
