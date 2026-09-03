#!/usr/bin/env bash
# Unit-test entry used by .tigerteam/scripts/run-tests.sh (test_cmd). Args → vitest filters.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d node_modules ] || npm ci --prefer-offline --no-audit --no-fund
exec npx vitest run "$@"
