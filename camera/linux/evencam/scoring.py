"""On-device frame quality: sharpness, exposure, glare. Then pick the best K.

Each frame is decoded at reduced size (JPEG draft mode decodes at 1/2, 1/4 or 1/8
scale, which is cheap even on a 1.2 GHz Cortex-A7), converted to grey and scaled
to ANALYSIS_EDGE pixels on the long side, so scores do not depend on the capture
resolution.

- sharpness: variance of the 3x3 Laplacian. Blur and motion lower it. Darkness
  lowers it too, because contrast drops.
- brightness: mean grey level 0..255.
- clipped: share of pixels at 250 or above. Glare on glossy paper raises it.
- motion: ratio of the weaker to the stronger of the horizontal and vertical
  gradient energies. Shake smears edges in one direction, so the ratio drops.
  Text itself is not isotropic (about 0.65-0.85 on the test pages), so this is a
  weak signal and only counts together with low gradient energy.

Thresholds were set on the synthetic images in camera/testdata. They are a starting
point only. Real thresholds need real photos from the chosen camera (EXPERIMENT
NEEDED, see camera/README.md).
"""

from __future__ import annotations

import io
from dataclasses import dataclass, field

from PIL import Image, ImageFilter, ImageStat

ANALYSIS_EDGE = 320
SHARP_GOOD = 900.0  # Laplacian variance treated as "fully sharp" (score 1.0)
SHARP_MIN = 250.0  # below this the frame is called blurry
DARK_MEAN = 45.0
BRIGHT_MEAN = 235.0
GLARE_SHARE = 0.12
MOTION_RATIO = 0.6  # below this, with weak gradients, call it motion blur
MOTION_WEAK = 450.0
RELATIVE_FLOOR = 0.5  # drop frames scoring below half the best one (CAPTURE-STRATEGY.md section 2)

_LAPLACE = ImageFilter.Kernel((3, 3), [0, 1, 0, 1, -4, 1, 0, 1, 0], scale=1, offset=128)
_GRAD_X = ImageFilter.Kernel((3, 3), [0, 0, 0, -1, 0, 1, 0, 0, 0], scale=1, offset=128)
_GRAD_Y = ImageFilter.Kernel((3, 3), [0, -1, 0, 0, 0, 0, 0, 1, 0], scale=1, offset=128)

try:  # Pillow 9.1 and later
    _RESAMPLE = Image.Resampling.BILINEAR  # type: ignore[attr-defined]
    _RESAMPLE_HQ = Image.Resampling.LANCZOS  # type: ignore[attr-defined]
except AttributeError:  # older Pillow, e.g. Ubuntu 20.04 ships 7.0
    _RESAMPLE = Image.BILINEAR  # type: ignore[attr-defined]
    _RESAMPLE_HQ = Image.LANCZOS  # type: ignore[attr-defined]


@dataclass
class FrameScore:
    index: int
    width: int
    height: int
    sharpness: float
    brightness: float
    clipped: float
    motion: float
    score: float
    issues: list = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.issues


def score_jpeg(data: bytes, index: int = 0) -> FrameScore:
    try:
        img = Image.open(io.BytesIO(data))
        width, height = img.size
        img.draft("L", (ANALYSIS_EDGE, ANALYSIS_EDGE))
        grey = img.convert("L")
    except Exception:  # noqa: BLE001 - a corrupt frame scores zero, it never crashes
        return FrameScore(index, 0, 0, 0.0, 0.0, 0.0, 1.0, 0.0, ["unreadable frame"])
    grey.thumbnail((ANALYSIS_EDGE, ANALYSIS_EDGE), _RESAMPLE)
    lap = grey.filter(_LAPLACE)
    sharpness = float(ImageStat.Stat(lap).var[0])
    brightness = float(ImageStat.Stat(grey).mean[0])
    hist = grey.histogram()
    total = float(sum(hist)) or 1.0
    clipped = sum(hist[250:]) / total
    gx = float(ImageStat.Stat(grey.filter(_GRAD_X)).var[0])
    gy = float(ImageStat.Stat(grey.filter(_GRAD_Y)).var[0])
    motion = min(gx, gy) / max(gx, gy) if max(gx, gy) > 0 else 1.0
    motion_blur = motion < MOTION_RATIO and min(gx, gy) < MOTION_WEAK

    issues: list[str] = []
    if brightness < DARK_MEAN:
        issues.append("too dark")
    elif brightness > BRIGHT_MEAN:
        issues.append("too bright")
    if clipped > GLARE_SHARE:
        issues.append("glare")
    if (sharpness < SHARP_MIN or motion_blur) and "too dark" not in issues:
        issues.append("blurry")

    sharp_part = min(1.0, sharpness / SHARP_GOOD)
    if brightness < DARK_MEAN:
        exposure_part = max(0.0, brightness / DARK_MEAN) * 0.5
    elif brightness > BRIGHT_MEAN:
        exposure_part = 0.5
    else:
        exposure_part = 1.0
    glare_part = 1.0 - min(1.0, max(0.0, clipped - 0.02) * 3.0)
    motion_part = min(1.0, motion / 0.75) if motion_blur else 1.0
    score = round(max(0.0, min(1.0, sharp_part * exposure_part * glare_part * motion_part)), 4)
    return FrameScore(
        index, width, height, round(sharpness, 1), round(brightness, 1), round(clipped, 4), round(motion, 3), score, issues
    )


def select_best(scores: list, k: int, relative_floor: float = RELATIVE_FLOOR, min_score: float = 0.0) -> list:
    """Best k frames, highest score first. Frames far below the best (relative_floor)
    or below min_score are dropped, because a blurry extra frame can confuse the model
    more than it helps. Always returns at least one frame when any exist: the server
    decides about a retake, not the camera."""
    if not scores or k <= 0:
        return []
    ranked = sorted(scores, key=lambda s: (-s.score, s.index))
    best = ranked[0].score
    keep = [ranked[0]]
    for s in ranked[1:k]:
        if best > 0 and s.score >= best * relative_floor and s.score > 0 and s.score >= min_score:
            keep.append(s)
    return keep


def common_issue(scores: list) -> str | None:
    """An issue shared by every frame, for local feedback and a retry decision."""
    if not scores:
        return "unreadable frame"
    for issue in ("too dark", "blurry", "glare", "too bright", "unreadable frame"):
        if all(issue in s.issues for s in scores):
            return issue
    return None


def prepare_upload(data: bytes, max_edge: int, max_bytes: int, quality: int = 85) -> tuple:
    """Fit a frame to the upload limits. Returns (jpeg_bytes, width, height).

    Re-encoding also strips EXIF and any other metadata. Frames already small
    enough are re-encoded anyway when they carry metadata, so nothing about the
    device leaks beyond pixels.
    """
    img = Image.open(io.BytesIO(data))
    img.load()
    w, h = img.size
    has_meta = bool(img.info.get("exif")) or "comment" in img.info
    if max(w, h) <= max_edge and len(data) <= max_bytes and not has_meta:
        return data, w, h
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")
    if max(w, h) > max_edge:
        ratio = max_edge / float(max(w, h))
        img = img.resize((max(1, int(round(w * ratio))), max(1, int(round(h * ratio)))), _RESAMPLE_HQ)
    q = quality
    while True:
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=q, optimize=True)
        out = buf.getvalue()
        if len(out) <= max_bytes or q <= 40:
            break
        q -= 10
    if len(out) > max_bytes:
        # Last resort: shrink until it fits.
        while len(out) > max_bytes and max(img.size) > 640:
            img = img.resize((img.size[0] * 3 // 4, img.size[1] * 3 // 4), _RESAMPLE_HQ)
            buf = io.BytesIO()
            img.save(buf, "JPEG", quality=q, optimize=True)
            out = buf.getvalue()
    return out, img.size[0], img.size[1]
