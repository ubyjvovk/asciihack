#!/usr/bin/env bash
# Populate the nethack/ git submodule in this worktree (no-op when already
# populated). In a linked worktree it uses the main checkout's object store
# as a --reference so no network clone is needed.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f nethack/include/hack.h ]; then
    echo "nethack/ already populated."
else
    common_dir="$(git rev-parse --git-common-dir)"
    ref_dir="$common_dir/modules/nethack"
    if [ -d "$ref_dir" ]; then
        echo "Populating nethack/ from worktree reference $ref_dir"
        git submodule update --init --reference "$ref_dir" -- nethack
    else
        echo "Populating nethack/ (network clone)"
        git submodule update --init -- nethack
    fi
fi

echo "nethack/ submodule commit: $(git -C nethack rev-parse HEAD)"
