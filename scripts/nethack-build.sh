#!/usr/bin/env bash
# Out-of-tree NetHack 5.0 build. Copies the nethack/ submodule into
# build/nethack/<variant>/src-tree/, configures it with the linux.500 hints,
# builds and installs. Idempotent: a stamp file records the submodule commit,
# so a rerun for the same commit is a fast no-op (no network, no recompile).
#
#   bash scripts/nethack-build.sh tty   - vanilla console game in
#                                         build/nethack/tty/playground/
#   bash scripts/nethack-build.sh lib   - libnethack.a + headers + cflags.txt
#                                         + runtime playground in
#                                         build/nethack/lib/
#   (bridge is a later ticket)
set -euo pipefail
cd "$(dirname "$0")/.."

VARIANT="${1:?usage: nethack-build.sh <tty|lib>}"
case "$VARIANT" in
    tty|lib) ;;
    *) echo "unknown variant: $VARIANT (expected tty or lib)" >&2; exit 1 ;;
esac

bash scripts/nethack-src.sh

COMMIT="$(git -C nethack rev-parse HEAD)"
OUT="build/nethack/$VARIANT"
ABSOUT="$(pwd)/build/nethack/$VARIANT"
SRCTREE="$OUT/src-tree"
STAMP="$OUT/.stamp"
CACHE="build/cache/lua-5.4.8.tar.gz"
LUA_DIR="lib/lua-5.4.8"
# Install into an out-of-tree playground. dirs-perms.500 uses '?=' for these,
# so command-line values win over the default <srcroot>/playground. Absolute
# paths: make resolves them with the src-tree as its cwd.
MAKEVARS="HACKDIR=$ABSOUT/playground INSTDIR=$ABSOUT/playground VARDIR=$ABSOUT/playground"

# Fast path: same submodule commit and the key artifact already present.
case "$VARIANT" in
    tty) KEY="$OUT/playground/nethack" ;;
    lib) KEY="$OUT/libnethack.a" ;;
esac
if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$COMMIT" ] && [ -f "$KEY" ]; then
    echo "nethack-build $VARIANT: up to date (stamp $COMMIT); nothing to do."
    exit 0
fi

# --- fresh out-of-tree copy of the submodule -------------------------------
echo "nethack-build $VARIANT: copying submodule -> $SRCTREE"
rm -rf "$OUT"
mkdir -p "$SRCTREE" "$OUT" "$(dirname "$CACHE")"
cp -a nethack/. "$SRCTREE/"

# --- Lua: fetch once into the cache, unpack into the copy ------------------
if [ ! -f "$CACHE" ]; then
    echo "nethack-build $VARIANT: downloading Lua 5.4.8 into $CACHE"
    curl -q --fail --no-progress-meter -R -o "$CACHE" \
        https://www.lua.org/ftp/lua-5.4.8.tar.gz
fi
mkdir -p "$SRCTREE/lib"
echo "nethack-build $VARIANT: unpacking Lua 5.4.8 from cache"
tar -C "$SRCTREE/lib" -zxf "$CACHE"

# --- configure with the linux.500 hints ------------------------------------
echo "nethack-build $VARIANT: running setup.sh hints/linux.500"
( cd "$SRCTREE/sys/unix" && sh ./setup.sh hints/linux.500 )

# --- build ---------------------------------------------------------------
if [ "$VARIANT" = tty ]; then
    echo "nethack-build tty: building and installing the console game"
    ( cd "$SRCTREE" && make $MAKEVARS all )
    ( cd "$SRCTREE" && make $MAKEVARS install )
else
    # With WANT_LIBNH=1 the game binary is disabled (GAME is emptied), so the
    # lua_support target that normally generates nhlua.h never fires on its
    # own; build Lua + nhlua.h explicitly first, then everything else.
    echo "nethack-build lib: building Lua support"
    ( cd "$SRCTREE" && make WANT_LIBNH=1 $MAKEVARS lua_support )
    echo "nethack-build lib: building libnh.a and data files"
    ( cd "$SRCTREE" && make WANT_LIBNH=1 $MAKEVARS all )

    echo "nethack-build lib: collecting artifacts into $OUT"
    cp "$SRCTREE/src/libnh.a" "$OUT/libnethack.a"
    cp "$SRCTREE/lib/lua/liblua-5.4.8.a" "$OUT/liblua.a"
    cp -a "$SRCTREE/include/." "$OUT/include/"

    # exact CFLAGS used to compile src/*.c for this variant (see docs)
    printf 'include Makefile\n.PHONY: printflags\nprintflags:\n\t@echo "$(CFLAGS)"\n' \
        | make -C "$SRCTREE/src" -f /dev/stdin WANT_LIBNH=1 $MAKEVARS printflags 2>/dev/null \
        | grep -v '^make\[' | grep -v 'Entering directory\|Leaving directory' \
        > "$OUT/cflags.txt"

    # runtime playground (mirrors the tty install)
    mkdir -p "$OUT/playground/save"
    cp "$SRCTREE/dat/nhdat" "$SRCTREE/dat/symbols" "$OUT/playground/"
    cp "$SRCTREE/sys/unix/sysconf" "$OUT/playground/sysconf"
    touch "$OUT/playground/record" "$OUT/playground/perm" \
          "$OUT/playground/logfile" "$OUT/playground/xlogfile" \
          "$OUT/playground/livelog"
fi

echo "$COMMIT" > "$STAMP"
echo "nethack-build $VARIANT: done (stamp $COMMIT)."
