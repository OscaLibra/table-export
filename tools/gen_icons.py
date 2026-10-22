"""Generate simple extension icons (16/48/128) as PNG, no third-party deps.

Draws a green rounded square with a white grid + arrow-down motif,
kept intentionally simple (nearest-block rendering).
"""
import struct
import zlib
import os

def write_png(path, size, pixels):
    # pixels: list of rows, each row list of (r,g,b,a)
    raw = b""
    for row in pixels:
        raw += b"\x00" + b"".join(struct.pack("4B", *p) for p in row)
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        c += struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        return c
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)

def make_icon(size):
    S = size
    px = [[(0, 0, 0, 0) for _ in range(S)] for _ in range(S)]
    green = (46, 125, 50, 255)
    green_dark = (27, 94, 32, 255)
    white = (255, 255, 255, 255)

    def inside_rounded(x, y, r=None):
        # rounded-rect coverage for full canvas with margin
        m = max(1, S // 16)          # margin
        rr = r if r is not None else S // 5
        x0, y0, x1, y1 = m, m, S - 1 - m, S - 1 - m
        if x < x0 or x > x1 or y < y0 or y > y1:
            return False
        cx = min(max(x, x0 + rr), x1 - rr)
        cy = min(max(y, y0 + rr), y1 - rr)
        return (x - cx) ** 2 + (y - cy) ** 2 <= rr * rr

    for y in range(S):
        for x in range(S):
            if inside_rounded(x, y):
                # subtle darker bottom edge
                px[y][x] = green_dark if y > S * 0.82 else green

    # white table grid (upper 2/3) + down arrow (lower 1/3)
    gx0, gy0 = int(S * 0.22), int(S * 0.20)
    gx1, gy1 = int(S * 0.78), int(S * 0.58)
    lw = max(1, S // 16)
    for y in range(S):
        for x in range(S):
            if not (gx0 <= x <= gx1 and gy0 <= y <= gy1):
                continue
            on_border = x in range(gx0, gx0 + lw) or x in range(gx1 - lw + 1, gx1 + 1)
            on_border = on_border or y in range(gy0, gy0 + lw) or y in range(gy1 - lw + 1, gy1 + 1)
            mid_y = (gy0 + gy1) // 2
            on_mid = y in range(mid_y - lw // 2, mid_y - lw // 2 + lw)
            col_split = (gx0 + gx1) // 2
            on_col = x in range(col_split - lw // 2, col_split - lw // 2 + lw) and y < mid_y
            if on_border or on_mid or on_col:
                px[y][x] = white

    # down arrow
    ax = S // 2
    ay0, ay1 = int(S * 0.62), int(S * 0.84)
    aw = max(1, S // 10)   # shaft half-width
    for y in range(S):
        for x in range(S):
            if ay0 <= y <= ay1 - int(S * 0.08):
                if abs(x - ax) <= aw:
                    px[y][x] = white
            # arrow head triangle
            if ay1 - int(S * 0.10) <= y <= ay1:
                t = (y - (ay1 - int(S * 0.10))) / max(1, int(S * 0.10))
                half = int(t * S * 0.16)
                if abs(x - ax) <= half:
                    px[y][x] = white
    return px

out = os.path.join(os.path.dirname(__file__), "..", "icons")
os.makedirs(out, exist_ok=True)
for s in (16, 48, 128):
    write_png(os.path.join(out, f"icon{s}.png"), s, make_icon(s))
    print(f"icon{s}.png written")
