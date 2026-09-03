# Building NetHack out-of-tree

NetHack 5.0 lives in the `nethack/` git submodule and is **never modified or
built in place**. All builds happen in copies under `build/` (gitignored).
Two scripts drive this; a third plays the console game.

## The submodule (`scripts/nethack-src.sh`)

`bash scripts/nethack-src.sh` populates the `nethack/` submodule in the
current worktree. In a **linked worktree** the directory starts empty; the
script reuses the main checkout's object store so no network clone is needed:

- if `nethack/include/hack.h` is already present it is a no-op;
- otherwise it runs `git submodule update --init -- nethack`, passing
  `--reference "$(git rev-parse --git-common-dir)/modules/nethack"` when that
  reference directory exists (it does in linked worktrees — it is the main
  checkout's copy).

It prints the submodule commit at the end. `nethack-build.sh` calls it first,
so you normally never run it by hand.

## The build (`scripts/nethack-build.sh`)

```
bash scripts/nethack-build.sh tty    # vanilla console game
bash scripts/nethack-build.sh lib    # libnethack.a + headers + playground
```

Each variant copies the submodule into `build/nethack/<variant>/src-tree/`
(`cp -a`; there is no `rsync` guarantee), configures it with NetHack's own
`sys/unix/setup.sh hints/linux.500` ritual, and builds. The two variants
share a Lua cache and the idempotency rule.

### The two variants

**`tty`** builds and installs the plain console game into
`build/nethack/tty/playground/`, so you can play vanilla NetHack from this
repo (`make all` then `make install`). The install dir is overridden on the
`make` command line (`HACKDIR`/`INSTDIR`/`VARDIR` — `dirs-perms.500` uses
`?=` so these win over the default `<srcroot>/playground`, keeping the
playground **outside** `src-tree/`). Output:

```
build/nethack/tty/playground/nethack   # the game binary
build/nethack/tty/playground/{nhdat,symbols,sysconf,license,recover}
build/nethack/tty/playground/{record,perm,logfile,xlogfile,livelog}  # empty
build/nethack/tty/playground/save/
```

**`lib`** produces the library the C bridge (T-0002) links against, under
`build/nethack/lib/`:

- `libnethack.a` — the game library (`src/libnh.a` from `make WANT_LIBNH=1`,
  renamed; it exports `nhmain` and `shim_graphics_set_callback`);
- `liblua.a` — Lua 5.4.8, copied from `lib/lua/liblua-5.4.8.a`;
- `include/` — a copy of `nethack/include/` **plus** the generated headers
  (`date.h`, `nhlua.h`; NetHack 5.0 generates those two);
- `cflags.txt` — one line: the exact `CFLAGS` the tree used to compile
  `src/*.c`, extracted from the generated `src/Makefile` (see below). The
  bridge must be compiled with the same flags so struct layouts match;
- `playground/` — the runtime dir (mirrors the tty install): `nhdat`,
  `sysconf`, `symbols`, empty `record`/`perm`/`logfile`/`xlogfile`/
  `livelog`, and `save/`.

With `WANT_LIBNH=1` the game binary is disabled (`GAME` is emptied), so the
`lua_support` target that would normally generate `nhlua.h` never fires on
its own; the script runs `make WANT_LIBNH=1 lua_support` first, then
`make WANT_LIBNH=1 all`.

### The Lua cache

NetHack needs the Lua 5.4.8 sources under `lib/`. The first build downloads
`lua-5.4.8.tar.gz` into `build/cache/lua-5.4.8.tar.gz` and unpacks it into
the copy's `lib/`. Every later build unpacks from the cache, so **no network
is needed after the first build**.

### The stamp / idempotency rule

`build/nethack/<variant>/.stamp` records the submodule commit that was
built. On each run the script compares it to the current submodule HEAD and,
if they match **and** the variant's key artifact exists
(`playground/nethack` for `tty`, `libnethack.a` for `lib`), it is a fast
no-op. Rerunning the same commit costs a few milliseconds, does not
recompile, and does not touch the network. A changed submodule commit forces
a full rebuild.

### Extracting `cflags.txt`

The effective `CFLAGS` is accumulated across many `+=` lines in the
generated `src/Makefile`, so the script asks `make` to print it expanded by
feeding a one-line `printflags` target through a data-less makefile:

```
printf 'include Makefile\nprintflags:\n\t@echo "$(CFLAGS)"\n' \
    | make -C src -f /dev/stdin WANT_LIBNH=1 printflags
```

It runs with `WANT_LIBNH=1` so the flags include
`-DSHIM_GRAPHICS -DNOTTYGRAPHICS -DNOSHELL -DLIBNH -fpic` and
`-DDEFAULT_WINDOW_SYS="shim"`.

## Playing the console game (`scripts/nethack-play.sh`)

```
bash scripts/nethack-play.sh
```

runs `build/nethack/tty/playground/nethack` with `HACKDIR` and `NETHACKDIR`
pointed at the playground; all arguments pass through to NetHack (e.g.
`bash scripts/nethack-play.sh -u wizard --version`). Build it first with
`bash scripts/nethack-build.sh tty`.

## Out-of-scope notes

- The `bridge` build variant is a later ticket (T-0002) and is rejected here.
- Nothing under `nethack/` is ever edited; `git status --porcelain nethack`
  stays empty after any build, and the only files the builds create are under
  `build/`.
