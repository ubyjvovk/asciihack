#!/usr/bin/env bash
# asciihack-lib.sh — shared helpers for the ssh login wrapper. Sourceable so the
# pure pieces (name validation, path derivation) can be unit-tested without ssh.
#   source bin/asciihack-lib.sh
# Never run directly (it only defines functions).

# A valid player name is 1-20 chars of [A-Za-z0-9_-]; anything else (empty,
# path separators, spaces, over-long) is rejected.
asciihack_valid_name() {
  local name="$1"
  [[ "$name" =~ ^[A-Za-z0-9_-]{1,20}$ ]]
}

# Print the ASCIIHACK_HOME directory (default $HOME/.asciihack).
asciihack_home() {
  printf '%s' "${ASCIIHACK_HOME:-$HOME/.asciihack}"
}

# Print the per-player playground dir for the given name.
asciihack_player_dir() {
  printf '%s/players/%s' "$(asciihack_home)" "$1"
}

# Prompt for a player name on stdin, up to three attempts. Prints the valid name
# on success (exit 0), otherwise exits 1 with nothing printed.
asciihack_prompt_name() {
  local tries=3 name
  while (( tries > 0 )); do
    if ! read -r -p 'Name? ' name; then
      return 1
    fi
    if asciihack_valid_name "$name"; then
      printf '%s' "$name"
      return 0
    fi
    echo 'invalid name: use letters, digits, _ or - (1-20 chars)' >&2
    tries=$(( tries - 1 ))
  done
  return 1
}
