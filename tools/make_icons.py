#!/usr/bin/env python3
"""Render the app icons.

Pure stdlib, no image libraries: shapes are defined in normalized 0..1 space
and sampled with 3x3 supersampling, then written out as PNG.

    python3 tools/make_icons.py
"""

import math
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")

BG = (0x0B, 0x12, 0x20)
DIAMOND = (0xEE, 0xF3, 0xFF)
ARROW = (0xFF, 0xA5, 0x2B)

SS = 3  # supersampling factor per axis


# --------------------------------------------------------------------------
# geometry helpers, all in normalized 0..1 coordinates (y grows downward)
# --------------------------------------------------------------------------


def in_rounded_rect(x, y, radius):
    cx = min(max(x, radius), 1 - radius)
    cy = min(max(y, radius), 1 - radius)
    dx, dy = x - cx, y - cy
    return dx * dx + dy * dy <= radius * radius


def in_diamond(x, y, cx, cy, ax, ay):
    return abs(x - cx) / ax + abs(y - cy) / ay <= 1.0


def in_segment(x, y, p0, p1, half):
    (x0, y0), (x1, y1) = p0, p1
    dx, dy = x1 - x0, y1 - y0
    length_sq = dx * dx + dy * dy
    t = 0.0 if length_sq == 0 else ((x - x0) * dx + (y - y0) * dy) / length_sq
    t = min(1.0, max(0.0, t))
    px, py = x0 + t * dx, y0 + t * dy
    return (x - px) ** 2 + (y - py) ** 2 <= half * half


def in_triangle(x, y, a, b, c):
    def side(p, q):
        return (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0])

    s1, s2, s3 = side(a, b), side(b, c), side(c, a)
    return (s1 >= 0 and s2 >= 0 and s3 >= 0) or (s1 <= 0 and s2 <= 0 and s3 <= 0)


# The HOV diamond, and an arrow peeling out of it to the lower right.
DIAMOND_C = (0.40, 0.32)
DIAMOND_A = (0.20, 0.26)
DIAMOND_INNER = 0.55

SHAFT_0 = (0.28, 0.58)
SHAFT_1 = (0.60, 0.74)
SHAFT_HALF = 0.055
HEAD_HALF = 0.115
HEAD_LEN = 0.17


def _arrow_head():
    x0, y0 = SHAFT_0
    x1, y1 = SHAFT_1
    dx, dy = x1 - x0, y1 - y0
    length = math.hypot(dx, dy)
    ux, uy = dx / length, dy / length
    nx, ny = -uy, ux
    # Seat the base slightly behind the shaft's end so its round cap is
    # swallowed by the head instead of poking out as a bump.
    bx, by = x1 - ux * 0.04, y1 - uy * 0.04
    tip = (bx + ux * HEAD_LEN, by + uy * HEAD_LEN)
    left = (bx + nx * HEAD_HALF, by + ny * HEAD_HALF)
    right = (bx - nx * HEAD_HALF, by - ny * HEAD_HALF)
    return tip, left, right


HEAD = _arrow_head()


def sample(x, y, maskable):
    """Return an RGBA tuple for one normalized sample point."""
    if maskable:
        # Keep the artwork inside the ~80% safe zone; background is full bleed.
        cx, cy = 0.5 + (x - 0.5) / 0.72, 0.5 + (y - 0.5) / 0.72
        inside_bg = True
    else:
        cx, cy = x, y
        inside_bg = in_rounded_rect(x, y, 0.22)

    if not inside_bg:
        return (0, 0, 0, 0)

    if in_diamond(cx, cy, *DIAMOND_C, *DIAMOND_A) and not in_diamond(
        cx, cy, *DIAMOND_C, DIAMOND_A[0] * DIAMOND_INNER, DIAMOND_A[1] * DIAMOND_INNER
    ):
        return DIAMOND + (255,)

    if in_segment(cx, cy, SHAFT_0, SHAFT_1, SHAFT_HALF) or in_triangle(cx, cy, *HEAD):
        return ARROW + (255,)

    return BG + (255,)


def render(size, maskable=False):
    rows = []
    step = 1.0 / (size * SS)
    for py in range(size):
        row = bytearray()
        for px in range(size):
            r = g = b = a = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = (px * SS + sx + 0.5) * step
                    y = (py * SS + sy + 0.5) * step
                    sr, sg, sb, sa = sample(x, y, maskable)
                    # Premultiply so edge pixels blend instead of fringing.
                    r += sr * sa
                    g += sg * sa
                    b += sb * sa
                    a += sa
            n = SS * SS
            if a == 0:
                row += bytes((0, 0, 0, 0))
            else:
                row += bytes((round(r / a), round(g / a), round(b / a), round(a / n)))
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    raw = b"".join(b"\x00" + row for row in rows)

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as handle:
        handle.write(png)
    print(f"{path}  {size}x{size}  {len(png):,} bytes")


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in (180, 192, 512):
        write_png(os.path.join(OUT_DIR, f"icon-{size}.png"), size, render(size))
    write_png(
        os.path.join(OUT_DIR, "icon-maskable-512.png"), 512, render(512, maskable=True)
    )


if __name__ == "__main__":
    main()
