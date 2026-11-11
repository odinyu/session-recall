#!/usr/bin/env python3
"""Render the Session Recall app icon.

Mirrors web/favicon.svg exactly: a #2f6b58 rounded square with a white
magnifier glyph (circle outline + round-capped diagonal handle).

Geometry below is the favicon's 32x32 coordinate space scaled to 1024x1024.
Supersampled 4x then box-downsampled for clean antialiased edges.

Usage:
    python3 scripts/make-icon.py [output.png]
"""

from PIL import Image, ImageDraw

SIZE = 1024
SS = 4  # supersample factor
UNIT = SIZE / 32.0  # favicon viewBox unit -> pixels

BG = (47, 107, 88, 255)  # #2f6b58
FG = (242, 243, 239, 255)  # #f2f3ef

RADIUS = 8 * UNIT  # favicon rect rx=8
STROKE = 2.4 * UNIT  # favicon stroke-width=2.4
CIRCLE_CENTER = (14 * UNIT, 14 * UNIT)  # favicon circle cx/cy=14
CIRCLE_RADIUS = 6 * UNIT  # favicon circle r=6
HANDLE_START = (18.5 * UNIT, 18.5 * UNIT)
HANDLE_END = (23.5 * UNIT, 23.5 * UNIT)


def render() -> Image.Image:
    big = Image.new("RGBA", (SIZE * SS, SIZE * SS), (0, 0, 0, 0))
    draw = ImageDraw.Draw(big)

    def box(value: float) -> float:
        return value * SS

    def rounded(value: float) -> float:
        """Align a 1px stroke's centre to the pixel grid at supersampled scale."""
        return box(value) - 0.5

    # Rounded square background.
    draw.rounded_rectangle(
        (0, 0, box(SIZE) - 1, box(SIZE) - 1),
        radius=box(RADIUS),
        fill=BG,
    )

    # Magnifier lens: circle outline.
    cx, cy = CIRCLE_CENTER
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
    draw.line(
        (
            rounded(HANDLE_START[0]),
            rounded(HANDLE_START[1]),
            rounded(HANDLE_END[0]),
            rounded(HANDLE_END[1]),
        ),
        fill=FG,
        width=round(stroke),
    )
    # Round the handle's butt ends (PIL draws square caps).
    cap = stroke / 2
    for x, y in (HANDLE_START, HANDLE_END):
        draw.ellipse(
            (
                rounded(x) - cap,
                rounded(y) - cap,
                rounded(x) + cap,
                rounded(y) + cap,
            ),
            fill=FG,
        )

    return big.resize((SIZE, SIZE), Image.LANCZOS)


def main() -> None:
    import sys

    out = sys.argv[1] if len(sys.argv) > 1 else "src-tauri/app-icon.png"
    render().save(out)
    print(f"icon -> {out} ({SIZE}x{SIZE})")


if __name__ == "__main__":
    main()
