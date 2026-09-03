#!/usr/bin/env bash
# Full gate: install → typecheck → unit → build. NetHack/bridge C builds are
# added as stages once their tickets land (see docs/architecture.md §9).
# Full output goes to a log; stdout gets one line per stage + the log path.
set -uo pipefail
cd "$(dirname "$0")/.."
mkdir -p .tigerteam/logs/tests
log=".tigerteam/logs/tests/check-$(date -u +%Y%m%d-%H%M%S)-$$.log"
run() { local name="$1"; shift; if "$@" >>"$log" 2>&1; then echo "$name: ok"; else echo "$name: FAIL (see $log)"; exit 1; fi; }
[ -d node_modules ] || run install npm ci --prefer-offline --no-audit --no-fund
run typecheck npx tsc --noEmit
run unit npx vitest run
run build npx tsc -p tsconfig.build.json
echo "log: $log"
