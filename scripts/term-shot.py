#!/usr/bin/env python3
"""Render a tmux colour capture (`tmux capture-pane -e -p`) to a PNG.

Usage:  tmux capture-pane -e -p -t <session> > frame.txt
        python3 scripts/term-shot.py frame.txt docs/screenshot.png [--cell 9x18] [--font PATH]

Understands the SGR subset the screen writer emits: 24-bit fg/bg
(`38;2;r;g;b`, `48;2;r;g;b`), reset (`0`), and the 8/16-colour and 256-colour
forms as a fallback. Everything else is ignored. Needs Pillow and a monospace
TTF (DejaVu Sans Mono by default).
"""
from __future__ import annotations

import argparse
import re
import sys

from PIL import Image, ImageDraw, ImageFont

SGR = re.compile(r"\x1b\[([0-9;]*)m")
OTHER = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
DEFAULT_FG = (200, 200, 200)
DEFAULT_BG = (0, 0, 0)
ANSI16 = [
    (0, 0, 0), (205, 49, 49), (13, 188, 121), (229, 229, 16), (36, 114, 200), (188, 63, 188), (17, 168, 205), (204, 204, 204),
    (102, 102, 102), (241, 76, 76), (35, 209, 139), (245, 245, 67), (59, 142, 234), (214, 112, 214), (41, 184, 219), (255, 255, 255),
]


def color256(n: int) -> tuple[int, int, int]:
    """Map an xterm-256 index to RGB."""
    if n < 16:
        return ANSI16[n]
    if n < 232:
        n -= 16
        r, g, b = n // 36, (n // 6) % 6, n % 6
        return tuple(0 if v == 0 else 55 + v * 40 for v in (r, g, b))  # type: ignore[return-value]
    v = 8 + (n - 232) * 10
    return (v, v, v)


def parse(text: str) -> list[list[tuple[str, tuple[int, int, int], tuple[int, int, int]]]]:
    """Turn the capture into rows of (char, fg, bg) cells."""
    rows = []
    for line in text.split("\n"):
        fg, bg = DEFAULT_FG, DEFAULT_BG
        cells: list[tuple[str, tuple[int, int, int], tuple[int, int, int]]] = []
        i = 0
        while i < len(line):
            m = SGR.match(line, i)
            if m:
                params = [int(p) if p else 0 for p in m.group(1).split(";")] if m.group(1) else [0]
                j = 0
                while j < len(params):
                    p = params[j]
                    if p == 0:
                        fg, bg = DEFAULT_FG, DEFAULT_BG
                    elif p in (38, 48) and j + 1 < len(params):
                        mode = params[j + 1]
                        if mode == 2 and j + 4 < len(params):
                            rgb = (params[j + 2], params[j + 3], params[j + 4])
                            j += 4
                        elif mode == 5 and j + 2 < len(params):
                            rgb = color256(params[j + 2])
                            j += 2
                        else:
                            rgb = DEFAULT_FG
                        if p == 38:
                            fg = rgb
                        else:
                            bg = rgb
                    elif 30 <= p <= 37:
                        fg = ANSI16[p - 30]
                    elif 40 <= p <= 47:
                        bg = ANSI16[p - 40]
                    elif 90 <= p <= 97:
                        fg = ANSI16[p - 90 + 8]
                    elif 100 <= p <= 107:
                        bg = ANSI16[p - 100 + 8]
                    elif p == 7:
                        fg, bg = bg, fg
                    j += 1
                i = m.end()
                continue
            m = OTHER.match(line, i)
            if m:
                i = m.end()
                continue
            cells.append((line[i], fg, bg))
            i += 1
        rows.append(cells)
    while rows and not rows[-1]:
        rows.pop()
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("capture")
    ap.add_argument("out")
    ap.add_argument("--cell", default="9x18", help="cell size WxH in pixels")
    ap.add_argument("--font", default="/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf")
    ap.add_argument("--size", type=int, default=15, help="font size in px")
    ap.add_argument("--pad", type=int, default=12)
    a = ap.parse_args()
    cw, ch = (int(v) for v in a.cell.lower().split("x"))
    rows = parse(open(a.capture, encoding="utf-8", errors="replace").read())
    cols = max((len(r) for r in rows), default=80)
    img = Image.new("RGB", (cols * cw + 2 * a.pad, len(rows) * ch + 2 * a.pad), DEFAULT_BG)
    draw = ImageDraw.Draw(img)
    font = ImageFont.truetype(a.font, a.size)
    for y, row in enumerate(rows):
        for x, (chr_, fg, bg) in enumerate(row):
            px, py = a.pad + x * cw, a.pad + y * ch
            if bg != DEFAULT_BG:
                draw.rectangle([px, py, px + cw - 1, py + ch - 1], fill=bg)
            if chr_ != " ":
                draw.text((px, py), chr_, font=font, fill=fg)
    img.save(a.out, optimize=True)
    print(f"{a.out}: {cols}x{len(rows)} cells -> {img.size[0]}x{img.size[1]} px")
    return 0


if __name__ == "__main__":
    sys.exit(main())
