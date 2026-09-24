# Security policy

Only the latest release is supported. arelay is an early-stage, single-user local
tool, not a hosted gateway or a sandbox.

Report vulnerabilities through the repository's **Security → Report a
vulnerability** feature when available. If private reporting is unavailable,
open an issue requesting a private contact channel without publishing exploit
details, credentials, or private request data.

Do not include API keys, auth files, full prompts, or unredacted client logs in
issues. Other processes running on the same machine can access the local port
and spend the configured API keys. Do not expose the listener remotely.

Client settings contain credentials in some installations. arelay's backups
therefore use private permissions. Restoring settings before removing the relay
is necessary to avoid leaving clients pointed at a dead proxy.
