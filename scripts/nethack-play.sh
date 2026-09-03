#!/usr/bin/env bash
# Play vanilla NetHack in the console, using the out-of-tree tty build.
# Runs build/nethack/tty/playground/nethack with HACKDIR/NETHACKDIR pointed
# at the playground; all arguments are passed through to NetHack.
set -euo pipefail
cd "$(dirname "$0")/.."

PLAYDIR="build/nethack/tty/playground"
BIN="$PLAYDIR/nethack"

if [ ! -x "$BIN" ]; then
    echo "nethack binary not found at $BIN" >&2
    echo "build it first with:  bash scripts/nethack-build.sh tty" >&2
    exit 1
fi

export HACKDIR="$(cd "$PLAYDIR" && pwd)"
export NETHACKDIR="$HACKDIR"

exec "$BIN" "$@"
