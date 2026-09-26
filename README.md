# arelay

use codex from claude code, or claude code from codex.

after setup, `codex` shows up in claude code as one of its own subagents, and
`claude` shows up in codex as one of its own agents. each runs the other
installed CLI as a worker. your existing CLI authentication and provider stay
in place, including azure-backed codex. an already-working codex CLI doesn't
need a separate chatgpt login.

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

restart the clients you connected. then just ask: “have a codex subagent review
this module,” or in codex, “spawn a claude agent to check this.” both clients are
also told to delegate more readily than usual, so they will reach for these
subagents on their own for reviews, research, and parallel work. no arelay
wording is needed. the worker only sees the prompt it is given, so the parent
passes the task context and workspace directory. workers are read-only by
default. built-in subagents stay unchanged.

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
