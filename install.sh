#!/bin/sh
# Install the latest release without sudo. Inspect this script before running it.
set -eu
umask 077

REPO="wrsrsh/arelay"
PREFIX="${ARELAY_PREFIX:-$HOME/.local}"
VERSION="${ARELAY_VERSION:-latest}"
case "$(uname -s)" in Darwin|Linux) ;; *) echo 'arelay supports macOS and Linux.' >&2; exit 1 ;; esac
command -v curl >/dev/null 2>&1 || { echo 'curl is required.' >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo 'Node.js 22+ is required. On macOS: brew install node' >&2; exit 1; }
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' || { echo 'Node.js 22+ is required.' >&2; exit 1; }
case "$PREFIX" in /*) ;; *) echo 'ARELAY_PREFIX must be an absolute path.' >&2; exit 1 ;; esac
case "$VERSION" in latest) BASE="https://github.com/$REPO/releases/latest/download" ;; v[0-9]*) BASE="https://github.com/$REPO/releases/download/$VERSION" ;; *) echo 'ARELAY_VERSION must be latest or a v-prefixed release tag.' >&2; exit 1 ;; esac

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
curl --proto '=https' --tlsv1.2 -fsSL "$BASE/arelay.tar.gz" -o "$TMP/arelay.tar.gz"
curl --proto '=https' --tlsv1.2 -fsSL "$BASE/SHA256SUMS" -o "$TMP/SHA256SUMS"
(
  cd "$TMP"
  # Only verify the expected archive. Never let a checksum file select local paths.
  awk '$2 == "arelay.tar.gz" && length($1) == 64 && $1 !~ /[^0-9a-f]/ { print; found++ } END { if (found != 1) exit 1 }' SHA256SUMS > expected.sha256
  if command -v sha256sum >/dev/null 2>&1; then sha256sum -c expected.sha256
  else shasum -a 256 -c expected.sha256; fi
)
# Reject unexpected archive paths/types before extracting a downloaded release.
tar -tzf "$TMP/arelay.tar.gz" > "$TMP/entries"
awk 'seen[$0]++ { exit 1 } END { if (NR != 5) exit 1 }' "$TMP/entries"
tar -tvzf "$TMP/arelay.tar.gz" | awk 'substr($0, 1, 1) != "-" { exit 1 }'
while IFS= read -r entry; do
  case "$entry" in arelay.mjs|LICENSE|README.md|THIRD_PARTY_NOTICES.md|LICENSE.openai-codex) ;; *) echo "Unexpected archive entry: $entry" >&2; exit 1 ;; esac
done < "$TMP/entries"
mkdir "$TMP/unpack"
tar -xzf "$TMP/arelay.tar.gz" -C "$TMP/unpack"
for file in arelay.mjs LICENSE README.md THIRD_PARTY_NOTICES.md LICENSE.openai-codex; do
  [ -f "$TMP/unpack/$file" ] && [ ! -L "$TMP/unpack/$file" ] || { echo "Invalid release file: $file" >&2; exit 1; }
done
ACTUAL=$(node "$TMP/unpack/arelay.mjs" --version)
case "$ACTUAL" in *[!0-9.]*|'') echo 'Invalid release version.' >&2; exit 1 ;; esac
TARGET="$PREFIX/share/arelay/versions/$ACTUAL"
mkdir -p "$TARGET" "$PREFIX/bin"
if [ -e "$PREFIX/bin/arelay" ] || [ -L "$PREFIX/bin/arelay" ]; then
  [ -L "$PREFIX/bin/arelay" ] && [ "$(readlink "$PREFIX/bin/arelay")" = "$PREFIX/share/arelay/current/arelay.mjs" ] || { echo "$PREFIX/bin/arelay already exists and is not managed by this installer." >&2; exit 1; }
fi
cp "$TMP/unpack/"* "$TARGET/"
chmod 755 "$TARGET/arelay.mjs"
# -n avoids following an existing current-directory symlink on macOS and Linux.
ln -sfn "$TARGET" "$PREFIX/share/arelay/current"
ln -sfn "$PREFIX/share/arelay/current/arelay.mjs" "$PREFIX/bin/arelay"
if [ "${ARELAY_NO_SERVICE:-0}" != 1 ]; then
  # curl | sh owns stdin. Give the wizard the controlling terminal, not the script pipe.
  # Keep redirected output, CI and explicit opt-outs fully noninteractive.
  case "${CI:-}" in ''|0|false|FALSE) IN_CI=0 ;; *) IN_CI=1 ;; esac
  case "${ARELAY_NO_TUI:-}" in ''|0|false|FALSE) NO_TUI=0 ;; *) NO_TUI=1 ;; esac
  if [ -t 1 ] && [ "$IN_CI" = 0 ] && [ "$NO_TUI" = 0 ] && [ "${TERM:-}" != dumb ] && ( : </dev/tty ) 2>/dev/null; then
    "$PREFIX/bin/arelay" install --interactive </dev/tty
  else
    "$PREFIX/bin/arelay" install --no-interactive
  fi
else
  echo 'Service installation skipped (ARELAY_NO_SERVICE=1). Run arelay install later.'
fi
printf '\nInstalled arelay %s at %s/bin/arelay\n' "$ACTUAL" "$PREFIX"
case ":$PATH:" in *":$PREFIX/bin:"*) ;; *) printf 'Add %s/bin to your shell PATH.\n' "$PREFIX" ;; esac
