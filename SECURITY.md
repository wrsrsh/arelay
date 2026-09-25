# Security policy

Only the latest release is supported. arelay is an early-stage, single-user local
tool, not a hosted gateway or a sandbox.

Report vulnerabilities through the repository's **Security → Report a
vulnerability** feature when available. If private reporting is unavailable,
open an issue requesting a private contact channel without publishing exploit
details, credentials, or private request data.

Do not include API keys, auth files, full prompts, or unredacted client logs in
issues. Native worker requests require an owner-only local service key. Processes
running as your user can read it and invoke the workers. Native mode launches the
original CLIs, defaults to read-only, and never copies subscription tokens.

The optional API proxy remains a single-user loopback service; other local
processes can use configured API keys through it. Do not expose the listener
remotely or use it as a boundary between untrusted local accounts.

Client settings contain credentials in some installations. arelay's backups
therefore use private permissions. Restoring settings before removing the relay
is necessary to avoid leaving clients pointed at a dead proxy.
