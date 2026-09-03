#!/usr/bin/env bash
# ssh-serve.sh — operator tool for serving AsciiHack over ssh. `--check` verifies
# a built tree and prints the sshd_config snippet; `--setup` (root, or --dry-run)
# creates the play user and installs the sshd block. See docs/ssh.md.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST_JS="$REPO_ROOT/dist/cli.js"
BRIDGE="$REPO_ROOT/build/nethack/bridge/nh-bridge"
PLAYGROUND="$REPO_ROOT/build/nethack/bridge/playground"
LOGIN="$REPO_ROOT/bin/asciihack-login"

# Print the sshd_config Match block for the play user.
ssh_snippet() {
  cat <<EOF
Match User play
    ForceCommand $LOGIN
    # Authentication — pick ONE of the two lines:
    #   PasswordAuthentication no     # require an ssh key
    #   PermitEmptyPasswords yes      # allow an empty password
    PasswordAuthentication no
    X11Forwarding no
    AllowTcpForwarding no
    PermitTTY yes
EOF
}

# Verify a built tree and print the sshd snippet. Exit 0 only if all present.
check() {
  local fail=0
  [[ -f "$DIST_JS" ]] || { echo "error: missing $DIST_JS (run: npm run build)" >&2; fail=1; }
  [[ -x "$BRIDGE" ]] || { echo "error: bridge not built at $BRIDGE (run: bash scripts/nethack-build.sh lib && bash scripts/nethack-build.sh bridge)" >&2; fail=1; }
  [[ -d "$PLAYGROUND" ]] || { echo "error: bridge playground missing at $PLAYGROUND (run: bash scripts/nethack-build.sh bridge)" >&2; fail=1; }
  [[ -x "$LOGIN" ]] || { echo "error: $LOGIN is not executable" >&2; fail=1; }
  if (( fail )); then
    return 1
  fi
  echo "check: ok"
  echo
  echo "Add this block to /etc/ssh/sshd_config (then restart sshd):"
  echo
  ssh_snippet
}

# Create the play user and append the sshd block. Needs root unless --dry-run.
setup() {
  local dry_run=0 arg
  for arg in "$@"; do
    [[ "$arg" == "--dry-run" ]] && dry_run=1
  done
  if (( ! dry_run )) && (( EUID != 0 )); then
    echo "error: --setup requires root (use --setup --dry-run to preview)" >&2
    exit 1
  fi

  local useradd="useradd -m -s '$LOGIN' play"
  if (( dry_run )); then
    echo "Would run the following as root:"
    echo "  $useradd"
    echo "  cp /etc/ssh/sshd_config /etc/ssh/sshd_config.asciihack.bak"
    echo "  append this block to /etc/ssh/sshd_config:"
    ssh_snippet | sed 's/^/    /'
    echo "  then restart sshd (e.g. systemctl restart sshd)"
    return 0
  fi

  echo "+ $useradd"
  useradd -m -s "$LOGIN" play || { echo "error: could not create user 'play'" >&2; exit 1; }
  echo "+ cp /etc/ssh/sshd_config /etc/ssh/sshd_config.asciihack.bak"
  cp /etc/ssh/sshd_config /etc/ssh/sshd_config.asciihack.bak || true
  echo "+ append sshd block"
  ssh_snippet >> /etc/ssh/sshd_config || { echo "error: could not write /etc/ssh/sshd_config" >&2; exit 1; }
  echo "Restart sshd to pick up the config (e.g. systemctl restart sshd)."
}

case "${1:-}" in
  --check) check ;;
  --setup) setup "${@:2}" ;;
  *) echo "usage: $0 --check | --setup [--dry-run]" >&2; exit 2 ;;
esac
