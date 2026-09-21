#!/usr/bin/env bash
# Contact sheet of the renderer bench — the PM's eyeball review in one image.
#
#   bash scripts/web-sheet.sh <out.png> [--gl swiftshader|gpu] "<query>" ["<query>" ...]
#
# Each <query> is appended to /scene.html (e.g. "render=amber&pose=7.5,4.5,90").
# Needs `npm run web:dev` running on 127.0.0.1:5273.
set -euo pipefail
cd "$(dirname "$0")/.."
out="${1:?usage: web-sheet.sh <out.png> [--gl swiftshader|gpu] \"<query>\" ...}"; shift
gl="--swiftshader"
if [ "${1:-}" = "--gl" ]; then [ "$2" = "gpu" ] && gl="--gpu"; shift 2; fi
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
i=0
labels=()
for q in "$@"; do
  i=$((i + 1))
  printf -v n '%02d' "$i"
  node scripts/web-shot.mjs "/scene.html?$q" "$tmp/$n.png" $gl --w 640 --h 400 >"$tmp/$n.log" 2>&1 || true
  # burn the query into the tile so the sheet is self-describing
  convert "$tmp/$n.png" -gravity north -background '#101418' -splice 0x18 \
    -fill '#ffcf8a' -pointsize 13 -annotate +0+2 "$q" "$tmp/t$n.png"
  labels+=("$tmp/t$n.png")
  grep -h "console.error\|pageerror\|probe" "$tmp/$n.log" | head -2 || true
done
montage "${labels[@]}" -tile 2x -geometry +2+2 -background '#000000' "$out"
echo "sheet: $out ($i tiles)"
