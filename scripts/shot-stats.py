#!/usr/bin/env python3
"""Brightness statistics for a renderer screenshot — so look tuning is
measurable instead of vibes.

    python3 scripts/shot-stats.py shot.png [shot2.png ...]

Reports, per image: the share of pixels at or near black (the quantiser's
dead zone), mean and p95 luminance, how many distinct luminance levels are
actually used, and the share that blooms to near-white. A good ASCII frame
spreads its levels; a bad one is mostly black with a few blown highlights.
"""
import sys
from collections import Counter
from PIL import Image


def stats(path: str) -> None:
    im = Image.open(path).convert("RGB")
    px = list(im.getdata())
    n = len(px)
    lum = [int(0.2126 * r + 0.7152 * g + 0.0722 * b) for r, g, b in px]
    hist = Counter(lum)
    black = sum(c for v, c in hist.items() if v <= 8)
    white = sum(c for v, c in hist.items() if v >= 247)
    used = sum(1 for v, c in hist.items() if c >= n / 20000)
    srt = sorted(lum)
    p95 = srt[int(n * 0.95)]
    mean = sum(lum) / n
    name = path.rsplit("/", 1)[-1]
    print(
        f"{name:34} black={black / n:6.1%} white={white / n:5.1%} "
        f"mean={mean:5.1f} p95={p95:3d} levels={used:3d}"
    )


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        raise SystemExit(2)
    for p in sys.argv[1:]:
        stats(p)
