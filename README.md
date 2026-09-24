# arelay

use codex models for claude code's subagents, or claude for codex's.

arelay runs locally. your main model stays in its client, and that client still
runs the tools and handles permissions. you choose where the delegated work goes.

## install

with homebrew:

```sh
brew install wrsrsh/tap/arelay && arelay install
```

or with curl, if you already have node 22+:

```sh
curl -fsSL https://raw.githubusercontent.com/wrsrsh/arelay/main/install.sh | sh
```

works on macos and linux. the curl install goes into `~/.local/bin`.

## setup

the installer opens a terminal setup wizard. you can run it again whenever you want:

```sh
arelay setup
```

pick a direction, provider and model. use the suggested model versions or enter
your own model or azure deployment name.

```text
◆  which clients do you want to configure?
│  ● both directions
│  ○ claude code → openai subagents
│  ○ codex → claude subagents
│  ○ backends only
```

the wizard finds existing settings, masks API keys, and shows the routing before
you confirm. it can start the background service and keep it running at login.
press escape or ctrl+c before saving to leave your configuration alone.

you'll need API keys for the providers you route to. claude and chatgpt
subscriptions aren't used for cross-provider requests. keys you save stay in
`~/.config/arelay/credentials.env` with owner-only permissions; macos keychain is
also supported. the wizard doesn't test your keys or model access.

if another bridge already manages a client, arelay asks you to restore that setup
first. choosing “backends only” leaves client settings as they are; it doesn't
disable routes you've already enabled.

## using it

```sh
arelay status             # is the service running?
arelay stats              # which direction are requests taking?
arelay doctor             # config, credentials and client versions
arelay service restart
```

to undo the client changes:

```sh
arelay unsetup claude
arelay unsetup codex
```

restart the affected clients afterward. restore their settings before stopping
or removing arelay, otherwise they'll keep sending requests to a stopped service.

for scripts or CI, skip the wizard:

```sh
arelay install --no-interactive
arelay setup claude       # configure one client using saved settings
arelay setup codex
```

redirected installs are noninteractive too. `ARELAY_NO_TUI=1` disables the wizard;
`NO_COLOR=1` turns off colors.

## a few limits

- codex routing uses direct function tools and v1 agents. hosted web search is
  disabled for that session, including its main model.
- claude's deferred tool search is disabled so the full tool definitions can be
  translated.
- hosted tools, cross-provider compaction and reasoning replay aren't supported.
- the listener is local, but other processes on your machine can use it and spend
  the configured API keys. don't expose the port through a tunnel.

[the reference](docs/reference.md) covers configuration, azure, service behavior,
compatibility and recovery. tested client versions are listed there too.

## development

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm smoke:clients
```

the tests use temporary settings and mock backends, not paid API calls. terminal
tests also need python 3.9+. see [contributing](CONTRIBUTING.md) for release steps.

MIT, with third-party notices [here](THIRD_PARTY_NOTICES.md).
