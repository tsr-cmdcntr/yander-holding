"""Generate favicons + OG share card from the Yander emblem.

Outputs into assets/:
  favicon.ico         — multi-size .ico (16, 32, 48)
  favicon-32.png      — modern browsers
  favicon-16.png      — IE/legacy
  apple-touch-icon.png — 180x180, opaque (iOS strips alpha)
  og.png              — 1200x630 social share card
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

HERE = Path(__file__).parent
ASSETS = HERE / "assets"
EMBLEM = ASSETS / "yander-emblem.png"

# Brand tokens — must match styles.css / pitch deck
FOREST_DEEP = (10, 61, 36)       # #0a3d24
FOREST_DARKEST = (6, 36, 24)     # #062418
PAPER = (247, 243, 236)          # #f7f3ec
AMBER = (217, 122, 60)           # #d97a3c
INK = (43, 35, 29)               # #2b231d


def load_emblem() -> Image.Image:
    im = Image.open(EMBLEM).convert("RGBA")
    return im


def emblem_on_color(size: int, bg: tuple) -> Image.Image:
    """Composite emblem centred on a solid bg, with a small inset margin."""
    canvas = Image.new("RGBA", (size, size), bg + (255,))
    emblem = load_emblem()
    # Inset by ~12% so the logo doesn't kiss the edges
    inset = int(size * 0.86)
    em = emblem.resize((inset, inset), Image.LANCZOS)
    pos = ((size - inset) // 2, (size - inset) // 2)
    canvas.alpha_composite(em, pos)
    return canvas


def make_favicon_pngs():
    # Transparent variants for browsers that handle alpha (most do).
    for sz in (16, 32, 48):
        em = load_emblem().resize((sz, sz), Image.LANCZOS)
        em.save(ASSETS / f"favicon-{sz}.png")
    # Multi-size .ico
    em32 = load_emblem().resize((32, 32), Image.LANCZOS)
    em32.save(
        ASSETS / "favicon.ico",
        sizes=[(16, 16), (32, 32), (48, 48)],
    )


def make_apple_touch():
    # iOS strips alpha, so bake on forest background
    icon = emblem_on_color(180, FOREST_DEEP)
    icon.convert("RGB").save(ASSETS / "apple-touch-icon.png", "PNG", optimize=True)


def make_og_card():
    """1200x630 social share card matching the deck cover vibe."""
    W, H = 1200, 630
    card = Image.new("RGB", (W, H), FOREST_DARKEST)

    # Vertical gradient: forest_darkest top -> forest_deep bottom
    grad = Image.new("RGB", (1, H))
    for y in range(H):
        t = y / (H - 1)
        r = round(FOREST_DARKEST[0] * (1 - t) + FOREST_DEEP[0] * t)
        g = round(FOREST_DARKEST[1] * (1 - t) + FOREST_DEEP[1] * t)
        b = round(FOREST_DARKEST[2] * (1 - t) + FOREST_DEEP[2] * t)
        grad.putpixel((0, y), (r, g, b))
    grad = grad.resize((W, H), Image.BILINEAR)
    card.paste(grad)

    # Soft horizon glow near vertical centre
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((W * 0.2, H * 0.45, W * 0.8, H * 0.85), fill=(247, 243, 236, 24))
    glow = glow.filter(ImageFilter.GaussianBlur(radius=60))
    card.paste(glow, (0, 0), glow)

    # Emblem (left side)
    em = load_emblem().resize((260, 260), Image.LANCZOS)
    card.paste(em, (90, (H - 260) // 2), em)

    # Try to find a serif font for the wordmark; fall back to default
    def load_font(candidates: list, size: int) -> ImageFont.FreeTypeFont:
        for path in candidates:
            try:
                return ImageFont.truetype(path, size=size)
            except OSError:
                continue
        return ImageFont.load_default()

    serif_paths = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSerifBold.ttf",
    ]
    sans_paths = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ]
    sans_italic_paths = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Italic.ttf",
    ]

    wordmark_font = load_font(serif_paths, 124)
    tagline_font = load_font(sans_paths, 34)
    eyebrow_font = load_font(sans_italic_paths, 26)

    d = ImageDraw.Draw(card)
    text_x = 400

    # Eyebrow
    d.text(
        (text_x, 210),
        "COMING 2026",
        fill=AMBER,
        font=eyebrow_font,
    )
    # Wordmark
    d.text(
        (text_x, 250),
        "yander",
        fill=PAPER,
        font=wordmark_font,
    )
    # Tagline
    d.text(
        (text_x, 410),
        "The road less driven.",
        fill=PAPER,
        font=tagline_font,
    )

    # Footer line
    foot_font = load_font(sans_paths, 22)
    d.text(
        (90, H - 60),
        "yander.app",
        fill=(247, 243, 236, 180),
        font=foot_font,
    )

    card.save(ASSETS / "og.png", "PNG", optimize=True)


def main():
    if not EMBLEM.exists():
        raise SystemExit(f"Emblem not found at {EMBLEM}")
    make_favicon_pngs()
    make_apple_touch()
    make_og_card()
    print("Generated:")
    for p in sorted(ASSETS.glob("*")):
        print(" ", p.name, p.stat().st_size, "bytes")


if __name__ == "__main__":
    main()
