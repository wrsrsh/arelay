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
# A checksum failure must not install an executable.
printf 'tampered' >> "$TMP/downloads/arelay.tar.gz"
export ARELAY_PREFIX="$TMP/rejected"
if sh "$ROOT/install.sh" >"$TMP/rejection.log" 2>&1; then
  echo 'Installer accepted a tampered archive' >&2
  exit 1
fi
test ! -e "$ARELAY_PREFIX/bin/arelay"
echo 'Offline installation, repeat installation, CLI, and checksum rejection passed.'
