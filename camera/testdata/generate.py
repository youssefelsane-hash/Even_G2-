"""Generate small synthetic test photos of printed pages, with common faults.

Run from the repository root:

    camera/.venv/bin/python -I camera/testdata/generate.py

Writes JPEGs next to this script. Output is deterministic for a given Pillow
version (fixed random seed). These are rendered images, not real photos: they
test the pipeline and the on-device scorer, not real optics.
"""

from __future__ import annotations

import os
import random
import sys

from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
W, H = 640, 480
QUALITY = 80

PAGE1 = [
    "Exercise 3 (Algebra)",
    "",
    "a) Solve x^2 - 5x + 6 = 0.",
    "b) Factor 2x^2 + 7x + 3.",
    "c) For which k does x^2 + kx + 9 = 0",
    "   have exactly one solution?",
    "",
    "Hint: use the discriminant b^2 - 4ac.",
    "Show every step of your work.",
]

PAGE2 = [
    "Exercise 3 (continued)",
    "",
    "d) Sketch y = x^2 - 5x + 6 and mark",
    "   both roots and the vertex.",
    "e) Explain why the vertex lies at",
    "   x = 2.5 without computing y.",
]


def font(size: int) -> ImageFont.ImageFont:
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow older than 10.1
        return ImageFont.load_default()


def render_page(lines: list[str], offset_y: int = 0, seed: int = 1) -> Image.Image:
    """A slightly off-white page on a darker desk, text in dark ink."""
    rnd = random.Random(seed)
    img = Image.new("RGB", (W, H), (70, 60, 50))  # desk
    d = ImageDraw.Draw(img)
    d.rectangle([40, 20 + offset_y, W - 40, H + 200], fill=(236, 233, 224))
    f = font(24)
    y = 50 + offset_y
    for line in lines:
        d.text((70 + rnd.randint(-1, 1), y), line, fill=(25, 25, 30), font=f)
        y += 40
    return img


def motion_blur(img: Image.Image, length: int = 9) -> Image.Image:
    """Average of horizontally shifted copies: a cheap motion blur."""
    acc = img.copy()
    for i in range(1, length):
        shifted = ImageChops.offset(img, i - length // 2, 0)
        acc = Image.blend(acc, shifted, 1.0 / (i + 1))
    return acc


def add_noise(img: Image.Image, amount: int, seed: int) -> Image.Image:
    rnd = random.Random(seed)
    noise = Image.new("L", img.size)
    noise.putdata([128 + rnd.randint(-amount, amount) for _ in range(img.size[0] * img.size[1])])
    return ImageChops.add(img, Image.merge("RGB", [noise] * 3), scale=1.0, offset=-128)


def glare(img: Image.Image) -> Image.Image:
    out = img.copy()
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).ellipse([180, 90, 520, 330], fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(25))
    white = Image.new("RGB", img.size, (255, 255, 255))
    return Image.composite(white, out, mask)


def save(img: Image.Image, name: str) -> None:
    path = os.path.join(HERE, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, "JPEG", quality=QUALITY, optimize=True)


def main() -> int:
    clean = render_page(PAGE1)
    save(clean, "clean.jpg")
    save(clean.filter(ImageFilter.GaussianBlur(3.0)), "blur.jpg")
    dark = ImageEnhance.Brightness(clean).enhance(0.12)
    save(add_noise(dark, 6, seed=7), "dark.jpg")
    save(glare(clean), "glare.jpg")
    save(motion_blur(clean, 11), "motion.jpg")
    save(render_page(PAGE1, offset_y=-150), "cutoff.jpg")
    save(render_page(PAGE2, seed=2), "page2.jpg")
    # A burst as a hand-held camera might take it: frame1 is the sharp one.
    blur_levels = [2.2, 0.0, 1.0, 3.5]
    for i, r in enumerate(blur_levels):
        frame = render_page(PAGE1, seed=10 + i)
        if r > 0:
            frame = frame.filter(ImageFilter.GaussianBlur(r))
        save(frame, os.path.join("burst", "frame%d.jpg" % i))
    # A burst taken in bad light where every frame is too dark.
    for i in range(3):
        frame = ImageEnhance.Brightness(render_page(PAGE1, seed=20 + i)).enhance(0.1)
        save(add_noise(frame, 5, seed=30 + i), os.path.join("dark-burst", "frame%d.jpg" % i))
    print("wrote test images to", HERE)
    return 0


if __name__ == "__main__":
    sys.exit(main())
