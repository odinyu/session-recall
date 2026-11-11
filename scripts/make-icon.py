#!/usr/bin/env python3
"""Render the Session Recall app icon.

Mirrors web/favicon.svg: a #2f6b58 rounded square with a white magnifier
glyph (circle outline + round-capped diagonal handle).

The geometry sits on Apple's macOS icon grid rather than filling the canvas.
A 1024x1024 canvas carries an 822x822 rounded tile centred at (101, 101), so the
solid body covers 80.3% of the canvas — the same coverage Calculator, Notes and
Music use. Filling the whole canvas is what makes an icon look oversized next to
real macOS apps in the Dock and in Finder.

A soft shadow (blur 14, offset 8px down) sits under the tile, matching the
decay measured on system icons: alpha ~26 eight pixels outside the right edge
and ~55 below the bottom edge.

The glyph keeps the favicon's 32x32 coordinate space, mapped onto the tile, so
its proportions are unchanged — it just scales down with the tile.
Supersampled 4x then box-downsampled for clean antialiased edges.

Usage:
    python3 scripts/make-icon.py [output.png]
"""

from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
SS = 4  # supersample factor

# Apple's macOS icon grid: 822px tile centred in a 1024px canvas.
TILE = 822
PAD = (SIZE - TILE) // 2  # 101
RADIUS = 185  # corner radius for a tile this size

UNIT = TILE / 32.0  # favicon viewBox unit -> tile pixels

BG = (47, 107, 88, 255)  # #2f6b58
FG = (242, 243, 239, 255)  # #f2f3ef

SHADOW_OFFSET_Y = 8
SHADOW_BLUR = 14
SHADOW_ALPHA = 90  # 0-255, tuned to the decay measured on system icons

STROKE = 2.4 * UNIT  # favicon stroke-width=2.4
CIRCLE_CENTER = (14 * UNIT, 14 * UNIT)  # favicon circle cx/cy=14
CIRCLE_RADIUS = 6 * UNIT  # favicon circle r=6
HANDLE_START = (18.5 * UNIT, 18.5 * UNIT)
HANDLE_END = (23.5 * UNIT, 23.5 * UNIT)


def render() -> Image.Image:
    canvas_px = SIZE * SS
    big = Image.new("RGBA", (canvas_px, canvas_px), (0, 0, 0, 0))

    def box(value: float) -> float:
        return value * SS

    def rounded(value: float) -> float:
        """Align a 1px stroke's centre to the pixel grid at supersampled scale."""
        return box(value) - 0.5

    tile_box = (box(PAD), box(PAD), box(PAD + TILE) - 1, box(PAD + TILE) - 1)

    # --- shadow ---------------------------------------------------------
    # Draw the tile silhouette on its own layer, blur it, then darken with it.
    shadow = Image.new("RGBA", (canvas_px, canvas_px), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        (
            tile_box[0],
            tile_box[1] + box(SHADOW_OFFSET_Y),
            tile_box[2],
            tile_box[3] + box(SHADOW_OFFSET_Y),
        ),
        radius=box(RADIUS),
        fill=(0, 0, 0, SHADOW_ALPHA),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(box(SHADOW_BLUR)))
    big = Image.alpha_composite(big, shadow)

    # --- tile -----------------------------------------------------------
    draw = ImageDraw.Draw(big)
    draw.rounded_rectangle(tile_box, radius=box(RADIUS), fill=BG)

    # --- glyph ----------------------------------------------------------
    # Favicon coordinates are relative to the tile's top-left corner.
    def place(point: tuple[float, float]) -> tuple[float, float]:
        return (PAD + point[0], PAD + point[1])

    cx, cy = place(CIRCLE_CENTER)
    stroke = box(STROKE)
    r = box(CIRCLE_RADIUS) - stroke / 2
    draw.ellipse(
        (
            rounded(cx) - r,
            rounded(cy) - r,
            rounded(cx) + r,
            rounded(cy) + r,
        ),
        outline=FG,
        width=round(stroke),
    )

    # Magnifier handle: round-capped diagonal.
    start = place(HANDLE_START)
    end = place(HANDLE_END)
    draw.line(
        (
            rounded(start[0]),
            rounded(start[1]),
            rounded(end[0]),
            rounded(end[1]),
        ),
        fill=FG,
        width=round(stroke),
    )
    # Round the handle's butt ends (PIL draws square caps).
    cap = stroke / 2
    for point in (start, end):
        draw.ellipse(
            (
                rounded(point[0]) - cap,
                rounded(point[1]) - cap,
                rounded(point[0]) + cap,
                rounded(point[1]) + cap,
            ),
            fill=FG,
        )

    return big.resize((SIZE, SIZE), Image.LANCZOS)


def main() -> None:
    import sys

    out = sys.argv[1] if len(sys.argv) > 1 else "src-tauri/app-icon.png"
    render().save(out)
    print(f"icon -> {out} ({SIZE}x{SIZE}, tile {TILE} at {PAD})")


if __name__ == "__main__":
    main()
