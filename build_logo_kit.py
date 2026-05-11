"""Build the complete Yander Y-logo kit.

Outputs everything you'll ever need into yander-logo-kit/ and updates the
live holding page assets in yander-holding/assets/.

Run from project root:
    python3 yander-holding/build_logo_kit.py
"""

from __future__ import annotations

from pathlib import Path
from io import BytesIO

import cairosvg
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
HOLDING = ROOT / "yander-holding"
KIT = ROOT / "yander-logo-kit"
SVG_SRC = HOLDING / "assets" / "y-logo.svg"

# Brand colours
MINT = (0x5c, 0xb9, 0x92)         # app primary
PAPER = (0xf7, 0xf3, 0xec)        # cream
INK = (0x2b, 0x23, 0x1d)          # near-black
FOREST_DEEP = (0x0a, 0x3d, 0x24)  # dark backdrop
FOREST_DARKEST = (0x06, 0x24, 0x18)
AMBER = (0xd9, 0x7a, 0x3c)
WHITE = (0xff, 0xff, 0xff)


# ---------- SVG colour variants ----------

COLOR_VARIANTS = {
    "mint":  "#5cb992",
    "paper": "#f7f3ec",
    "ink":   "#2b231d",
    "white": "#ffffff",
    "amber": "#d97a3c",
}


def make_variant_svg(colour_hex: str) -> str:
    """Return a coloured SVG string by replacing currentColor."""
    raw = SVG_SRC.read_text()
    return raw.replace("currentColor", colour_hex)


# ---------- raster rasterising helpers ----------

def rasterise(svg_text: str, width: int) -> Image.Image:
    """Rasterise SVG text to an RGBA PIL image at the given width."""
    png_bytes = cairosvg.svg2png(bytestring=svg_text.encode("utf-8"), output_width=width)
    return Image.open(BytesIO(png_bytes)).convert("RGBA")


def add_canvas_padding(im: Image.Image, padding_ratio: float = 0.12, bg=(0, 0, 0, 0)) -> Image.Image:
    """Pad an image so the logo doesn't kiss the edges."""
    w, h = im.size
    pad = int(max(w, h) * padding_ratio)
    out = Image.new("RGBA", (w + pad * 2, h + pad * 2), bg)
    out.alpha_composite(im, (pad, pad))
    return out


# ---------- favicon set ----------

def make_favicons():
    """Generate favicon-16/32/48 + multi-size .ico + apple-touch-icon."""
    fav_dir = KIT / "favicon"
    fav_dir.mkdir(parents=True, exist_ok=True)

    # Padded square version on transparent — best for modern browsers
    mint_svg = make_variant_svg(COLOR_VARIANTS["mint"])
    for sz in (16, 32, 48, 64, 128, 180, 256):
        raw = rasterise(mint_svg, width=sz * 2)
        # Make square canvas at sz*2, centre the Y, then shrink to sz
        side = max(raw.size)
        sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        sq.alpha_composite(raw, ((side - raw.width) // 2, (side - raw.height) // 2))
        sq = sq.resize((sz, sz), Image.LANCZOS)
        sq.save(fav_dir / f"favicon-{sz}.png")

    # Multi-size .ico (16/32/48)
    base = Image.open(fav_dir / "favicon-48.png")
    base.save(fav_dir / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])

    # apple-touch-icon: 180×180 with forest background (iOS strips alpha)
    apple_bg = Image.new("RGBA", (180, 180), FOREST_DEEP + (255,))
    raw = rasterise(mint_svg, width=120)
    side = max(raw.size)
    sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    sq.alpha_composite(raw, ((side - raw.width) // 2, (side - raw.height) // 2))
    sq = sq.resize((130, 130), Image.LANCZOS)
    apple_bg.alpha_composite(sq, ((180 - 130) // 2, (180 - 130) // 2))
    apple_bg.convert("RGB").save(fav_dir / "apple-touch-icon.png", "PNG", optimize=True)


# ---------- exhaustive PNG export ----------

def make_png_exports():
    """For every colour variant, render PNGs at every common size."""
    out = KIT / "png"
    out.mkdir(parents=True, exist_ok=True)
    sizes = [16, 32, 48, 64, 96, 128, 192, 256, 384, 512, 1024, 2048]
    for cname, chex in COLOR_VARIANTS.items():
        cdir = out / cname
        cdir.mkdir(exist_ok=True)
        svg = make_variant_svg(chex)
        for sz in sizes:
            im = rasterise(svg, width=sz)
            # Square canvas
            side = max(im.size)
            sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
            sq.alpha_composite(im, ((side - im.width) // 2, (side - im.height) // 2))
            sq = sq.resize((sz, sz), Image.LANCZOS)
            sq.save(cdir / f"yander-y-{cname}-{sz}.png")


# ---------- SVG variants exported ----------

def make_svg_exports():
    out = KIT / "svg"
    out.mkdir(parents=True, exist_ok=True)
    # Master with currentColor so consumers can recolor via CSS `color`
    (out / "yander-y.svg").write_text(SVG_SRC.read_text())
    for cname, chex in COLOR_VARIANTS.items():
        (out / f"yander-y-{cname}.svg").write_text(make_variant_svg(chex))


# ---------- horizontal lockup (Y + wordmark) ----------

def find_font(candidates, size):
    for p in candidates:
        try:
            return ImageFont.truetype(p, size=size)
        except OSError:
            continue
    return ImageFont.load_default()


SERIF_PATHS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSerifBold.ttf",
]
SERIF_REG = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSerif.ttf",
]
SANS_PATHS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
]
SANS_ITALIC = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Italic.ttf",
]


def make_lockups():
    """Y + 'yander' wordmark, horizontal lockups in mint/paper/ink variants."""
    out = KIT / "lockup"
    out.mkdir(parents=True, exist_ok=True)

    H = 240
    PADX = 32

    for cname in ("mint", "paper", "ink"):
        chex = COLOR_VARIANTS[cname]
        rgb = tuple(int(chex[i:i + 2], 16) for i in (1, 3, 5))
        svg = make_variant_svg(chex)

        # Render Y at logo height
        y_im = rasterise(svg, width=H)  # height auto from aspect
        # Resize so Y fits into H tall
        scale = H / y_im.height
        y_w = int(y_im.width * scale)
        y_im = y_im.resize((y_w, H), Image.LANCZOS)

        # Wordmark
        font = find_font(SERIF_REG, int(H * 0.74))
        # Measure
        dummy = Image.new("RGBA", (1, 1))
        d = ImageDraw.Draw(dummy)
        bbox = d.textbbox((0, 0), "yander", font=font)
        tw = bbox[2] - bbox[0]
        th = bbox[3] - bbox[1]

        total_w = y_w + 22 + tw + PADX * 2
        canvas = Image.new("RGBA", (total_w, H + PADX), (0, 0, 0, 0))
        canvas.alpha_composite(y_im, (PADX, 0))
        d = ImageDraw.Draw(canvas)
        d.text(
            (PADX + y_w + 22, (H - th) // 2 - bbox[1]),
            "yander",
            fill=rgb,
            font=font,
        )
        canvas.save(out / f"yander-lockup-{cname}.png")

    # Lockup on forest bg, paper text + mint Y (canonical web header use)
    chex_y = COLOR_VARIANTS["mint"]
    chex_w = COLOR_VARIANTS["paper"]
    svg = make_variant_svg(chex_y)
    y_im = rasterise(svg, width=H)
    scale = H / y_im.height
    y_w = int(y_im.width * scale)
    y_im = y_im.resize((y_w, H), Image.LANCZOS)
    font = find_font(SERIF_REG, int(H * 0.74))
    dummy = Image.new("RGBA", (1, 1))
    d = ImageDraw.Draw(dummy)
    bbox = d.textbbox((0, 0), "yander", font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    total_w = y_w + 22 + tw + PADX * 2
    canvas = Image.new("RGB", (total_w, H + PADX), FOREST_DEEP)
    canvas_rgba = canvas.convert("RGBA")
    canvas_rgba.alpha_composite(y_im, (PADX, 0))
    d = ImageDraw.Draw(canvas_rgba)
    d.text(
        (PADX + y_w + 22, (H - th) // 2 - bbox[1]),
        "yander",
        fill=PAPER,
        font=font,
    )
    canvas_rgba.convert("RGB").save(out / "yander-lockup-on-forest.png")


# ---------- App icon (squircle, store-ready) ----------

def make_app_icon():
    """1024x1024 app icon: mint Y on forest-deep squircle background."""
    out = KIT / "app-icon"
    out.mkdir(parents=True, exist_ok=True)

    SIZE = 1024
    bg = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

    # Forest squircle: just a rounded-square (App Store autoclips to its mask)
    mask = Image.new("L", (SIZE, SIZE), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle((0, 0, SIZE - 1, SIZE - 1), radius=int(SIZE * 0.225), fill=255)

    sq = Image.new("RGBA", (SIZE, SIZE), FOREST_DEEP + (255,))
    sq.putalpha(mask)

    # Subtle gradient overlay
    grad = Image.new("L", (1, SIZE))
    for y in range(SIZE):
        grad.putpixel((0, y), int(40 * (1 - y / SIZE)))
    grad = grad.resize((SIZE, SIZE), Image.BILINEAR)
    grad_rgba = Image.merge("RGBA", (
        Image.new("L", (SIZE, SIZE), 247),
        Image.new("L", (SIZE, SIZE), 243),
        Image.new("L", (SIZE, SIZE), 236),
        grad,
    ))
    sq.alpha_composite(grad_rgba)
    sq.putalpha(mask)

    # Mint Y centred
    mint_svg = make_variant_svg(COLOR_VARIANTS["mint"])
    y_im = rasterise(mint_svg, width=int(SIZE * 0.42))
    sq.alpha_composite(
        y_im,
        ((SIZE - y_im.width) // 2, (SIZE - y_im.height) // 2 - int(SIZE * 0.01)),
    )
    bg.alpha_composite(sq)
    bg.save(out / "yander-app-icon-1024.png")
    # Also export common app icon sizes
    for sz in (180, 192, 256, 512):
        bg.resize((sz, sz), Image.LANCZOS).save(out / f"yander-app-icon-{sz}.png")


# ---------- 1200x630 OG share card ----------

def make_og_card():
    out = KIT / "social"
    out.mkdir(parents=True, exist_ok=True)

    W, H = 1200, 630
    card = Image.new("RGB", (W, H), FOREST_DARKEST)

    # Vertical gradient
    grad = Image.new("RGB", (1, H))
    for y in range(H):
        t = y / (H - 1)
        grad.putpixel(
            (0, y),
            (
                round(FOREST_DARKEST[0] * (1 - t) + FOREST_DEEP[0] * t),
                round(FOREST_DARKEST[1] * (1 - t) + FOREST_DEEP[1] * t),
                round(FOREST_DARKEST[2] * (1 - t) + FOREST_DEEP[2] * t),
            ),
        )
    grad = grad.resize((W, H), Image.BILINEAR)
    card.paste(grad)

    # Soft horizon glow
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((W * 0.2, H * 0.45, W * 0.8, H * 0.85), fill=(247, 243, 236, 24))
    glow = glow.filter(ImageFilter.GaussianBlur(radius=60))
    card_rgba = card.convert("RGBA")
    card_rgba.alpha_composite(glow)

    # Mint Y on the left
    mint_svg = make_variant_svg(COLOR_VARIANTS["mint"])
    y_im = rasterise(mint_svg, width=210)
    y_x = 110
    y_y = (H - y_im.height) // 2
    card_rgba.alpha_composite(y_im, (y_x, y_y))

    serif_bold = find_font(SERIF_PATHS, 124)
    sans = find_font(SANS_PATHS, 34)
    italic = find_font(SANS_ITALIC, 26)

    d = ImageDraw.Draw(card_rgba)
    text_x = y_x + y_im.width + 70
    d.text((text_x, 210), "COMING 2026", fill=AMBER, font=italic)
    d.text((text_x, 250), "yander", fill=PAPER, font=serif_bold)
    d.text((text_x, 410), "The route less taken.", fill=PAPER, font=sans)

    foot = find_font(SANS_PATHS, 22)
    d.text((90, H - 60), "yander.app", fill=(247, 243, 236, 180), font=foot)

    card_rgba.convert("RGB").save(out / "yander-og-1200x630.png", "PNG", optimize=True)


# ---------- monogram tile (for Instagram avatars etc) ----------

def make_avatar():
    out = KIT / "social"
    out.mkdir(parents=True, exist_ok=True)
    SIZE = 1024

    # Mint Y on forest, centered, square (no rounding — platforms add their own)
    bg = Image.new("RGB", (SIZE, SIZE), FOREST_DEEP)
    bg_rgba = bg.convert("RGBA")
    mint_svg = make_variant_svg(COLOR_VARIANTS["mint"])
    y_im = rasterise(mint_svg, width=int(SIZE * 0.5))
    bg_rgba.alpha_composite(
        y_im,
        ((SIZE - y_im.width) // 2, (SIZE - y_im.height) // 2),
    )
    bg_rgba.convert("RGB").save(out / "yander-avatar-1024.png")


# ---------- main ----------

def main():
    KIT.mkdir(exist_ok=True)
    print("Building Yander logo kit at", KIT)
    print(" - SVG variants...")
    make_svg_exports()
    print(" - PNG exports...")
    make_png_exports()
    print(" - Favicon set...")
    make_favicons()
    print(" - Lockup (Y + wordmark)...")
    make_lockups()
    print(" - App icon (1024 squircle)...")
    make_app_icon()
    print(" - OG share card (1200x630)...")
    make_og_card()
    print(" - Avatar (1024 square)...")
    make_avatar()
    print("Done.")


if __name__ == "__main__":
    main()
