"""Two kinds of settings.

LocalSettings come from environment variables (the systemd unit reads
/etc/even-g2-camera/camera.env). They hold the server address, the device token
and the pin numbers. The token never appears in logs.

CameraConfig comes from the backend at start and every CONFIG_REFRESH_S after that
(GET /v1/camera/config). The phone panel changes it with PUT. It only tunes how
pictures are taken. It cannot turn the LED off, start a capture, set a timer or
enable audio: those settings do not exist, and unknown keys are ignored.
Bad or missing values fall back to the defaults, clamped to safe ranges.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, replace
from urllib.parse import urlparse

DEVICE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
MODES = ("single", "burst")

MAX_KEEP = 3  # API limit: frame0..frame2
MAX_FRAMES = 8
MAX_UPLOAD_BYTES = 2_500_000  # API limit per frame


@dataclass(frozen=True)
class CameraConfig:
    default_mode: str = "burst"  # what a single press does: "burst" (N frames) or "single" (1 frame)
    burst_frames: int = 4  # N
    keep_best: int = 3  # K
    width: int = 2592
    height: int = 1944
    burst_seconds: float = 1.0
    clip_seconds: float = 2.0
    clip_candidates: int = 12  # frames sampled from the clip before scoring
    long_press_mode: str = "clip"  # "clip" (record locally) or "burst" (long burst of long_burst_frames)
    long_burst_frames: int = 8  # long press when long_press_mode is "burst" (and always on the ESP32)
    jpeg_quality: int = 85  # used when a frame must be re-encoded for upload
    min_upload_score: float = 0.15  # frames below this are not sent if a better one exists
    status_poll_seconds: int = 30  # how long to poll job status after upload
    upload_max_edge: int = 2208  # largest 4:3 size under the 4,784-token image limit (CAPTURE-STRATEGY.md section 2)
    fill_light: str = "auto"  # "auto", "on" or "off"; only used if a fill light is wired
    auto_retry: bool = True  # one automatic re-capture when every frame is dark or blurry

    def frames_for(self, mode: str) -> int:
        return 1 if mode == "single" else self.burst_frames

    def keep_for(self, mode: str) -> int:
        return 1 if mode == "single" else self.keep_best


_ALIASES = {
    "default_mode": ("defaultMode", "mode", "default_mode"),
    "burst_frames": ("burstFrames", "frames", "n", "N", "burst_frames"),
    "keep_best": ("uploadFrames", "keepBest", "keep", "k", "K", "keep_best"),
    "long_press_mode": ("longPressMode", "long_press_mode"),
    "jpeg_quality": ("jpegQuality", "jpeg_quality"),
    "min_upload_score": ("minUploadScore", "min_upload_score"),
    "status_poll_seconds": ("statusPollSeconds", "status_poll_seconds"),
    "burst_seconds": ("burstSeconds", "burst_seconds"),
    "clip_seconds": ("clipSeconds", "clip_seconds"),
    "clip_candidates": ("clipCandidates", "clip_candidates"),
    "long_burst_frames": ("longBurstFrames", "long_burst_frames"),
    "upload_max_edge": ("uploadMaxEdge", "upload_max_edge"),
    "fill_light": ("fillLight", "fill_light"),
    "auto_retry": ("autoRetry", "auto_retry"),
}


def _pick(d: dict, names: tuple):
    for n in names:
        if n in d:
            return d[n]
    return None


def _int_in(v, lo: int, hi: int, default: int) -> int:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return default
    if v != v:  # NaN
        return default
    return int(max(lo, min(hi, int(v))))


def _float_in(v, lo: float, hi: float, default: float) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v:
        return default
    return float(max(lo, min(hi, float(v))))


def _resolution(v, default: tuple) -> tuple:
    w = h = None
    if isinstance(v, str):
        m = re.match(r"^\s*(\d{2,5})\s*[xX]\s*(\d{2,5})\s*$", v)
        if m:
            w, h = int(m.group(1)), int(m.group(2))
    elif isinstance(v, dict):
        w, h = v.get("width"), v.get("height")
    elif isinstance(v, (list, tuple)) and len(v) == 2:
        w, h = v
    if not all(isinstance(x, int) and not isinstance(x, bool) for x in (w, h)):
        return default
    if not (160 <= w <= 4608 and 120 <= h <= 3456):
        return default
    return (w, h)


def parse_camera_config(body, base: CameraConfig | None = None) -> CameraConfig:
    """Tolerant parser: accepts {...} or {"config": {...}}, camelCase or snake_case."""
    base = base or CameraConfig()
    if not isinstance(body, dict):
        return base
    if isinstance(body.get("config"), dict):
        body = body["config"]
    d = CameraConfig()  # defaults for invalid fields, not the previous value
    mode = _pick(body, _ALIASES["default_mode"])
    res = _resolution(_pick(body, ("resolution", "size")), (d.width, d.height))
    if "width" in body and "height" in body:
        res = _resolution({"width": body.get("width"), "height": body.get("height")}, res)
    fill = _pick(body, _ALIASES["fill_light"])
    long_mode = _pick(body, _ALIASES["long_press_mode"])
    auto_retry = _pick(body, _ALIASES["auto_retry"])
    burst_frames = _int_in(_pick(body, _ALIASES["burst_frames"]), 1, MAX_FRAMES, d.burst_frames)
    keep = _int_in(_pick(body, _ALIASES["keep_best"]), 1, MAX_KEEP, d.keep_best)
    return replace(
        base,
        default_mode=mode if mode in MODES else d.default_mode,
        burst_frames=burst_frames,
        keep_best=min(keep, burst_frames),
        width=res[0],
        height=res[1],
        burst_seconds=_float_in(_pick(body, _ALIASES["burst_seconds"]), 0.3, 3.0, d.burst_seconds),
        clip_seconds=_float_in(_pick(body, _ALIASES["clip_seconds"]), 1.0, 4.0, d.clip_seconds),
        clip_candidates=_int_in(_pick(body, _ALIASES["clip_candidates"]), 3, 24, d.clip_candidates),
        long_press_mode=long_mode if long_mode in ("clip", "burst") else d.long_press_mode,
        jpeg_quality=_int_in(_pick(body, _ALIASES["jpeg_quality"]), 50, 95, d.jpeg_quality),
        min_upload_score=_float_in(_pick(body, _ALIASES["min_upload_score"]), 0.0, 1.0, d.min_upload_score),
        status_poll_seconds=_int_in(_pick(body, _ALIASES["status_poll_seconds"]), 0, 60, d.status_poll_seconds),
        long_burst_frames=_int_in(_pick(body, _ALIASES["long_burst_frames"]), 2, MAX_FRAMES, d.long_burst_frames),
        upload_max_edge=_int_in(_pick(body, _ALIASES["upload_max_edge"]), 640, 4096, d.upload_max_edge),
        fill_light=fill if fill in ("auto", "on", "off") else d.fill_light,
        auto_retry=auto_retry if isinstance(auto_retry, bool) else d.auto_retry,
    )


class SettingsError(ValueError):
    pass


def _opt_int(env: dict, key: str) -> int | None:
    v = env.get(key, "").strip()
    if not v:
        return None
    try:
        return int(v)
    except ValueError as e:
        raise SettingsError("%s must be a number" % key) from e


@dataclass(frozen=True)
class LocalSettings:
    server_url: str
    device_token: str
    device_id: str
    camera_source: str = "v4l2"
    v4l2_device: str = "/dev/video0"
    v4l2_input_format: str = ""
    fake_source_dir: str = ""
    gpio_backend: str = "gpiod"
    gpio_chip: str = "/dev/gpiochip0"
    button_pin: int = 0
    led_pin: int = 0
    motor_pin: int | None = None
    fill_light_pin: int | None = None
    led_active_low: bool = False
    state_dir: str = "/run/even-g2-camera"
    ca_file: str = ""
    battery_file: str = ""
    max_queue: int = 4

    def __repr__(self) -> str:  # never print the token
        return "LocalSettings(server_url=%r, device_id=%r, camera_source=%r)" % (
            self.server_url, self.device_id, self.camera_source,
        )

    @property
    def queue_dir(self) -> str:
        return os.path.join(self.state_dir, "queue")

    @property
    def work_dir(self) -> str:
        return os.path.join(self.state_dir, "work")


def settings_from_env(env: dict | None = None) -> LocalSettings:
    env = dict(os.environ if env is None else env)
    url = env.get("SERVER_URL", "").strip().rstrip("/")
    token = env.get("DEVICE_TOKEN", "").strip()
    device_id = env.get("DEVICE_ID", "").strip()
    if not url:
        raise SettingsError("SERVER_URL is not set")
    parsed = urlparse(url)
    if parsed.scheme not in ("https", "http") or not parsed.netloc:
        raise SettingsError("SERVER_URL must be an http(s) URL with a host")
    if parsed.scheme == "http" and env.get("ALLOW_INSECURE_HTTP") != "1":
        raise SettingsError("SERVER_URL must use https (set ALLOW_INSECURE_HTTP=1 only for a local test server)")
    if not token or token.startswith("paste-"):
        raise SettingsError("DEVICE_TOKEN is not set")
    if not DEVICE_ID_RE.match(device_id):
        raise SettingsError("DEVICE_ID must be 1-40 letters, digits, - or _")
    source = env.get("CAMERA_SOURCE", "v4l2").strip()
    if source not in ("v4l2", "libcamera", "fake"):
        raise SettingsError("CAMERA_SOURCE must be v4l2, libcamera or fake")
    gpio_backend = env.get("GPIO_BACKEND", "gpiod").strip()
    if gpio_backend not in ("gpiod", "sysfs", "fake"):
        raise SettingsError("GPIO_BACKEND must be gpiod, sysfs or fake")
    button = _opt_int(env, "BUTTON_PIN")
    led = _opt_int(env, "LED_PIN")
    if gpio_backend != "fake" and (button is None or led is None):
        raise SettingsError("BUTTON_PIN and LED_PIN are required: the camera never runs without its LED")
    max_queue = _opt_int(env, "MAX_QUEUE") or 4
    return LocalSettings(
        server_url=url,
        device_token=token,
        device_id=device_id,
        camera_source=source,
        v4l2_device=env.get("V4L2_DEVICE", "/dev/video0"),
        v4l2_input_format=env.get("V4L2_INPUT_FORMAT", ""),
        fake_source_dir=env.get("FAKE_SOURCE_DIR", ""),
        gpio_backend=gpio_backend,
        gpio_chip=env.get("GPIO_CHIP", "/dev/gpiochip0"),
        button_pin=button if button is not None else 0,
        led_pin=led if led is not None else 1,
        motor_pin=_opt_int(env, "MOTOR_PIN"),
        fill_light_pin=_opt_int(env, "FILL_LIGHT_PIN"),
        led_active_low=env.get("LED_ACTIVE_LOW", "0") == "1",
        state_dir=env.get("STATE_DIR", "/run/even-g2-camera"),
        ca_file=env.get("CA_FILE", ""),
        battery_file=env.get("BATTERY_FILE", ""),
        max_queue=max(1, min(10, max_queue)),
    )
