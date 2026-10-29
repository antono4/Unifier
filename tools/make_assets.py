#!/usr/bin/env python3
"""Generate the Unifier social card + PNG app icons.

Requires Pillow:  pip install pillow
Run:              python3 tools/make_assets.py

Outputs: assets/social-card.png (1200x630), assets/icon-192.png, assets/icon-512.png
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"

BG = (7, 11, 20)
S1 = (45, 212, 191)
S2 = (99, 102, 241)
S3 = (244, 114, 182)
TEXT = (232, 238, 248)
DIM = (150, 165, 190)

W, H = 1200, 630


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    names = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ]
    for n in names:
        if Path(n).exists():
            return ImageFont.truetype(n, size)
    return ImageFont.load_default()


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def ramp(t: float):
    t = max(0.0, min(1.0, t))
    return lerp(S1, S2, t * 2) if t < 0.5 else lerp(S2, S3, (t - 0.5) * 2)


def glow_layer():
    """Blurred radial blobs composited additively for the ambient light."""
    layer = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(layer)
    d.ellipse((W * 0.52, H * 0.18, W * 1.05, H * 0.95), fill=(10, 60, 58))
    d.ellipse((-W * 0.1, -H * 0.25, W * 0.42, H * 0.6), fill=(18, 18, 62))
    return layer.filter(ImageFilter.GaussianBlur(90))


def spectrum(img: Image.Image, x0: int, y0: int, w: int, h: int, bars: int = 52):
    d = ImageDraw.Draw(img, "RGBA")
    gap = 4
    bw = (w - gap * (bars - 1)) / bars
    for i in range(bars):
        t = i / (bars - 1)
        # deterministic envelope: two humps + ripple, reads like real speech
        env = (
            0.55 * math.exp(-((t - 0.18) ** 2) / 0.02)
            + 0.9 * math.exp(-((t - 0.42) ** 2) / 0.03)
            + 0.3 * math.exp(-((t - 0.75) ** 2) / 0.05)
        )
        env *= 0.72 + 0.28 * abs(math.sin(i * 1.7))
        bh = max(4, env * h)
        x = x0 + i * (bw + gap)
        col = ramp(t)
        d.rounded_rectangle((x, y0 + h - bh, x + bw, y0 + h), radius=min(bw / 2, 4), fill=col + (235,))
        d.rectangle((x, y0 + h - bh - 6, x + bw, y0 + h - bh - 3), fill=S1 + (200,))


def social_card() -> Image.Image:
    base = glow_layer().convert("RGBA")
    img = Image.alpha_composite(Image.new("RGBA", (W, H), BG + (255,)), base)

    # subtle grid
    grid = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grid)
    for x in range(0, W, 48):
        gd.line((x, 0, x, H), fill=(255, 255, 255, 9))
    for y in range(0, H, 48):
        gd.line((0, y, W, y), fill=(255, 255, 255, 9))
    img = Image.alpha_composite(img, grid)

    spectrum(img, 96, 300, 1008, 210)

    d = ImageDraw.Draw(img, "RGBA")
    # logo bars
    lx, ly = 96, 96
    for i, hh in enumerate((26, 52, 36, 64, 42)):
        col = ramp(i / 4)
        d.rounded_rectangle((lx + i * 15, ly + 64 - hh, lx + i * 15 + 9, ly + 64), radius=4, fill=col + (255,))

    d.text((lx + 108, ly + 22), "Unifier", font=font(52, True), fill=TEXT)
    d.text((lx, 190), "Visualisasi suara real-time", font=font(34, True), fill=TEXT)
    d.text(
        (lx, 244),
        "Audio · ucapan · sinyal agen AI → efek visual",
        font=font(24),
        fill=DIM,
    )

    # footer strip
    d.line((96, 548, W - 96, 548), fill=(255, 255, 255, 30), width=1)
    d.text((96, 566), "antono4.github.io/Unifier", font=font(22), fill=DIM)
    d.text((W - 96 - 250, 566), "Canvas 2D · tanpa dependensi", font=font(22), fill=(110, 125, 150))
    return img.convert("RGB")


def icon(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = size * 0.22
    d.rounded_rectangle((0, 0, size - 1, size - 1), radius=r, fill=BG + (255,))
    n = 4
    bw = size * 0.085
    gap = size * 0.115
    total = n * bw + (n - 1) * gap
    x0 = (size - total) / 2
    heights = (0.28, 0.55, 0.4, 0.66)
    for i, hh in enumerate(heights):
        bh = size * hh
        x = x0 + i * (bw + gap)
        y = size * 0.72 - bh
        d.rounded_rectangle((x, y, x + bw, y + bh), radius=bw / 2, fill=ramp(i / (n - 1)) + (255,))
    return img


def make_animation() -> None:
    """Assemble .agent_tmp/shots/frames/ into docs/preview.webp.

    A still cannot show a real-time visualizer doing anything, and there is no
    ffmpeg here, so the frames are collected off the canvas and stitched into an
    animated WebP.

    Every second frame is kept. This content is all fine detail and resists
    compression, so frame count is the lever that actually matters: dropping
    every other frame halves the file while keeping the same five seconds of
    motion at 180 ms per frame, which is plenty for a preview loop.
    """
    src = ROOT / ".agent_tmp/shots/frames"
    frames = sorted(src.glob("f*.png")) if src.is_dir() else []
    if len(frames) < 2:
        print("  (no frames; run tools/make-shots.mjs first)")
        return
    step = 2
    imgs = [Image.open(p).convert("RGB") for p in frames[::step]]
    out = ROOT / "docs"
    out.mkdir(parents=True, exist_ok=True)
    dest = out / "preview.webp"
    imgs[0].save(
        dest, "WEBP", save_all=True, append_images=imgs[1:],
        duration=90 * step, loop=0, quality=68, method=6,
    )
    print(f"  wrote docs/preview.webp  {imgs[0].size}  {len(imgs)} frames  {dest.stat().st_size // 1024} KB")


def optimise_shots() -> None:
    """Downscale .agent_tmp/shots/*.png into docs/ for the README.

    The raw shots are full-resolution and run to ~1.5 MB each, which is far too
    heavy to commit. PNG barely compresses these (smooth gradients, dark UI) —
    quantising to 256 colours saves under 20% while visibly banding the
    gradients. WebP handles this content far better: the whole gallery lands
    under 200 KB at an RMSE of ~2/255, which is not perceptible.
    """
    src = ROOT / ".agent_tmp/shots"
    if not src.is_dir():
        print("  (no .agent_tmp/shots; run tools/make-shots.mjs first)")
        return
    out = ROOT / "docs"
    out.mkdir(parents=True, exist_ok=True)
    for p in sorted(src.glob("*.png")):
        im = Image.open(p).convert("RGB")
        # mode shots are 1920x1080 exports; UI shots are 1440x900 screenshots
        target = 1200 if p.stem.startswith("mode-") else 1280
        if im.width > target:
            im = im.resize((target, round(im.height * target / im.width)), Image.LANCZOS)
        dest = out / (p.stem + ".webp")
        im.save(dest, "WEBP", quality=90, method=6)
        print(f"  wrote docs/{dest.name}  {im.size}  {dest.stat().st_size // 1024} KB")


def main() -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    card = social_card()
    card.save(ASSETS / "social-card.png", "PNG", optimize=True)
    print(f"  wrote assets/social-card.png  {card.size}")
    for s in (192, 512):
        ic = icon(s)
        ic.save(ASSETS / f"icon-{s}.png", "PNG", optimize=True)
        print(f"  wrote assets/icon-{s}.png  {ic.size}")
    optimise_shots()
    make_animation()
    print("done")


if __name__ == "__main__":
    main()
