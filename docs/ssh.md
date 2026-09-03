# Serving AsciiHack over ssh

`ssh play@host` drops straight into AsciiHack (first-person view), one NetHack
playground per player name, and the session ends when the game exits. This page
is the operator walk-through. The machinery lives in two files:

- `bin/asciihack-login` — the login shell for the dedicated `play` user.
- `scripts/ssh-serve.sh` — `--check` (verify a built tree + print the sshd
  snippet) and `--setup` (create the user + install the sshd block; `--dry-run`
  previews without running).

## Build

The login wrapper runs the **built** client (`dist/cli.js`) and the **built**
bridge, so the tree must be built first:

```
bash scripts/nethack-src.sh                     # populate the submodule (once)
bash scripts/nethack-build.sh lib               # libnethack.a + headers + playground
bash scripts/nethack-build.sh bridge            # build/nethack/bridge/{nh-bridge,playground}
npm run build                                   # dist/cli.js from src
```

`scripts/ssh-serve.sh --check` confirms all four are present and prints the
`sshd_config` snippet to paste in.

## Setup

`--setup` needs root; it creates a `play` user whose login shell is
`bin/asciihack-login` and appends the `Match User play` block to
`/etc/ssh/sshd_config`. Preview it first:

```
bash scripts/ssh-serve.sh --setup --dry-run
```

Then, as root:

```
bash scripts/ssh-serve.sh --setup
systemctl restart sshd      # pick your service manager
```

The `Match User play` block:

```
Match User play
    ForceCommand /path/to/bin/asciihack-login
    # Authentication — pick ONE of the two lines:
    #   PasswordAuthentication no     # require an ssh key
    #   PermitEmptyPasswords yes      # allow an empty password
    PasswordAuthentication no
    X11Forwarding no
    AllowTcpForwarding no
    PermitTTY yes
```

`ForceCommand` means the sshd always runs the login wrapper — the user can
never reach a shell. The two authentication lines are **alternatives**, not
both:

- `PasswordAuthentication no` — players must present an ssh key. Tightest, but
  every player needs a key installed in `play`'s `authorized_keys`.
- `PermitEmptyPasswords yes` — anyone can `ssh play@host` with an empty
  password. Easiest for a private/trusted LAN; on a public host this is a
  wide-open door, so prefer keys.

`X11Forwarding no` and `AllowTcpForwarding no` close the forwarding escape
hatches, and `PermitTTY yes` gives the game its terminal.

## Test

From a client machine:

```
ssh -t play@localhost mia
```

- `-t` forces a pty (required for the game).
- `mia` is an optional name argument: `ssh play@host <name>` plays as `<name>`.
  A single `[A-Za-z0-9_-]{1,20}` token is accepted; anything else (or no
  argument) falls back to a `Name? ` prompt with the same validation (three
  attempts, then exit).

The ssh session ends when the game exits.

## Names → playgrounds

Each player name gets its own NetHack playground (NetHack's `NETHACKDIR`):

```
$ASCIIHACK_HOME/players/<name>     # ASCIIHACK_HOME defaults to ~/.asciihack
```

`~/.asciihack/players/mia/` for `mia`, `~/.asciihack/players/alex/` for `alex`,
and so on. On first use the directory is created by copying the build's
`build/nethack/bridge/playground`. Every player is a separate character with
separate saves, options and history.

## Saves persist

NetHack writes saves (`save/`), the score record and options into the player's
playground, so quitting with `S` (save) and returning later resumes that
character. Back them up by archiving `~/.asciihack/players/`. The build
directory stays clean — it is never written to at runtime.

## Security notes

- The `play` user has **no shell**: `ForceCommand` always runs
  `bin/asciihack-login`, and TCP/X11 forwarding are disabled, so a session
  cannot be used as a general login or a forwarding tunnel.
- NetHack's own escape hatches — the `#shell` extended command and the `!`
  shell escape — are gated on NetHack's `SHELL` macro. The build uses the
  `linux.500` hints, which pass `-DNOSHELL`, so `SHELL` is never defined and
  those commands are **compiled out** — there is no way to reach a shell from
  inside the game.
- The wrapper refuses to run if `dist/cli.js` or the bridge is missing, so a
  half-built tree fails loudly instead of confusingly.

## Terminal requirements

AsciiHack's fps view needs a real terminal:

- **≥ 80×24** — anything smaller and the viewport/status rows don't fit.
- **24-bit colour** — the renderer uses truecolor escapes. On a terminal that
  only does 256-colour, pass `--theme=amber` or `--theme=solarized` (the
  wrapper's default is `fps` with the `cyber` theme); for a genuinely weak
  terminal, `--mode=classic` stays readable.
- A **pty** — always connect with `ssh -t`.

If a player's terminal misrenders colour, they can't change the wrapper's
flags from inside the ssh session, so pick the theme for the fleet when you
set up the box.
