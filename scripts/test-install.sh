#!/bin/sh
# Offline installer test: fake downloads, real checksum/tar/Node, no real service.
set -eu
ROOT=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
mkdir -p "$TMP/bin" "$TMP/downloads"
cp "$ROOT/dist/arelay.tar.gz" "$ROOT/dist/SHA256SUMS" "$TMP/downloads/"
cat > "$TMP/bin/curl" <<'SH'
#!/bin/sh
set -eu
out=''
url=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2 ;;
    https://*) url=$1; shift ;;
    *) shift ;;
  esac
done
case "${url##*/}" in arelay.tar.gz|SHA256SUMS) cp "$ARELAY_TEST_DIST/${url##*/}" "$out" ;; *) exit 1 ;; esac
SH
chmod +x "$TMP/bin/curl"
export PATH="$TMP/bin:$PATH"
export ARELAY_TEST_DIST="$TMP/downloads"
export ARELAY_NO_SERVICE=1
export ARELAY_PREFIX="$TMP/prefix with spaces"
sh "$ROOT/install.sh"
VERSION=$(node -p "require('$ROOT/package.json').version")
test "$("$ARELAY_PREFIX/bin/arelay" --version)" = "$VERSION"
# An update is idempotent and the resulting CLI still works.
sh "$ROOT/install.sh"
"$ARELAY_PREFIX/bin/arelay" --help >/dev/null
# Exercise curl-style piped stdin in a real terminal, then cancel before any config/service writes.
ARELAY_NO_SERVICE=0 ARELAY_PREFIX="$TMP/interactive-prefix" \
ARELAY_HOME="$TMP/interactive-config" CLAUDE_CONFIG_DIR="$TMP/claude" CODEX_HOME="$TMP/codex" \
ARELAY_TEST_INSTALLER="$ROOT/install.sh" \
python3 "$ROOT/scripts/test-wizard-pty.py" escape sh -c 'cat "$ARELAY_TEST_INSTALLER" | sh'
test ! -e "$TMP/interactive-config"
# Exercise real unattended CLI installs without touching the user's service manager.
for manager in launchctl systemctl; do
  cat > "$TMP/bin/$manager" <<'SH'
#!/bin/sh
printf '%s\n' "$*" >> "$ARELAY_TEST_SERVICE_LOG"
SH
  chmod +x "$TMP/bin/$manager"
done
for option in CI ARELAY_NO_TUI TERM redirected; do
  case "$option" in TERM) value=dumb ;; *) value=1 ;; esac
  mkdir -p "$TMP/home-$option"
  export ARELAY_TEST_SERVICE_LOG="$TMP/service-$option.log"
  if [ "$option" = redirected ]; then
    env HOME="$TMP/home-$option" XDG_CONFIG_HOME="$TMP/home-$option/.config" \
      ARELAY_NO_SERVICE=0 ARELAY_PREFIX="$TMP/prefix-$option" \
      ARELAY_HOME="$TMP/config-$option" CI= ARELAY_NO_TUI= TERM=xterm-256color \
      sh "$ROOT/install.sh" > "$TMP/output-$option"
    grep -q 'running, starts at login' "$TMP/output-$option"
  else
    env HOME="$TMP/home-$option" XDG_CONFIG_HOME="$TMP/home-$option/.config" \
      ARELAY_NO_SERVICE=0 ARELAY_PREFIX="$TMP/prefix-$option" \
      ARELAY_HOME="$TMP/config-$option" CI= ARELAY_NO_TUI= TERM=xterm-256color \
      "$option=$value" ARELAY_TEST_INSTALLER="$ROOT/install.sh" \
      python3 "$ROOT/scripts/test-wizard-pty.py" unattended sh -c 'cat "$ARELAY_TEST_INSTALLER" | sh'
  fi
  test -f "$TMP/config-$option/config.json"
  test -s "$ARELAY_TEST_SERVICE_LOG"
done
# A checksum failure must not install an executable.
printf 'tampered' >> "$TMP/downloads/arelay.tar.gz"
export ARELAY_PREFIX="$TMP/rejected"
if sh "$ROOT/install.sh" >"$TMP/rejection.log" 2>&1; then
  echo 'Installer accepted a tampered archive' >&2
  exit 1
fi
test ! -e "$ARELAY_PREFIX/bin/arelay"
echo 'Offline install, cancellation, unattended flags, CLI, and checksum rejection passed.'
