# Contributing

Use Node.js 22+, Python 3.9+ for PTY tests, and the pnpm version declared in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm check
```

Keep protocol conversion separate from networking, client setup, and service
management. Never add tests that modify real client homes, execute generated
tool calls, contact paid APIs, or require credentials. Test new wire fields in
both directions, including streaming and explicit rejection cases.

Run `pnpm smoke:clients` after changes to client integration. This requires
local Claude Code and Codex executables; it uses disposable configuration and
mock backends. Add the tested versions to `docs/reference.md` when updating support.

The setup wizard separates terminal rendering, draft selection, and configuration
writes. Cancellation before confirmation must not write files. PTY tests cover
real keyboard input, password masking, cursor restoration, and `NO_COLOR`.
The offline installer test also checks piped stdin with a controlling terminal.

Before a release:

1. Update the version in `package.json` and `src/version.ts`.
2. Run `pnpm check`, `pnpm package`, and `sh scripts/test-install.sh`.
3. Review the tracked diff for credentials, personal URLs, generated client
   state, and accidentally copied prompts or logs.
4. Push a `vX.Y.Z` tag. The release workflow creates the archive and checksums.
5. Update `Formula/arelay.rb` and `wrsrsh/homebrew-tap` with the published
   archive's SHA-256 checksum. Never regenerate the archive after calculating
   the formula checksum.

The Codex catalog snapshot is vendored with its source revision and license in
`THIRD_PARTY_NOTICES.md`. Updating it requires re-running native Codex smoke tests.
