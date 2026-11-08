"""Turns button events into captures.

| Press              | What happens                                                        |
| ------------------ | ------------------------------------------------------------------- |
| single             | Burst: N frames over about 1 s (or 1 frame if the config says       |
|                    | "single"), score them, keep the best K (at most 3), queue upload    |
| double             | Same capture, sent as an extra page of the previous question        |
| long (>= 0.8 s)    | Clip: about 2 s of silent video recorded locally, frames extracted, |
|                    | best K kept, video deleted. The video never leaves the device       |
| stuck (>= 15 s)    | Nothing captured; "stuck" pattern                                   |

Before any sensor read the LED goes solid on for at least PRE_CAPTURE_LED_S, and it
stays on until the upload's first attempt ends (at most UPLOAD_LED_HOLD_S). If the
LED pin cannot be driven, nothing is captured.

Hard conditions:
- If every frame of a press is too dark and a fill light is wired (fill_light
  "auto"), the fill light comes on and the press is captured once more.
- If every frame is blurry or too dark, one automatic second capture is taken
  (auto_retry). Candidates from both attempts are pooled and the best K kept.
- Frames far worse than the best are not uploaded at all (see scoring.select_best).
- The server makes the final call: if the model cannot read the union of frames, it
  answers "retake" with a reason, and the LED shows the retake pattern.
"""

from __future__ import annotations

import logging
from typing import Callable

from .button import ButtonMachine
from .clock import Clock, iso_utc
from .config import MAX_UPLOAD_BYTES, CameraConfig
from .feedback import PRE_CAPTURE_LED_S, Feedback
from .gpio import Gpio, GpioError
from .scoring import common_issue, prepare_upload, score_jpeg, select_best
from .sources import CaptureError, CaptureSource
from .uploader import QueueFull, Uploader

log = logging.getLogger("evencam")

UPLOAD_LED_HOLD_S = 30.0
SERVER_ISSUES = ("too dark", "too bright", "glare", "blurry")  # names the backend knows
CLIP_MAX_W, CLIP_MAX_H = 1920, 1080  # video modes above 1080p are rare and slow to encode (ASSUMPTION)


class Controller:
    def __init__(
        self,
        gpio: Gpio,
        button_pin: int,
        source: CaptureSource,
        uploader: Uploader,
        feedback: Feedback,
        clock: Clock,
        battery: Callable[[], int | None] | None = None,
        machine: ButtonMachine | None = None,
    ) -> None:
        self.gpio = gpio
        self.button_pin = button_pin
        self.source = source
        self.uploader = uploader
        self.feedback = feedback
        self.clock = clock
        self.battery = battery or (lambda: None)
        self.machine = machine or ButtonMachine()
        self._hold: list[tuple[str, float]] = []  # (queue key, release deadline)
        self.captures: list[dict] = []  # summary per press, for tests and logs
        gpio.setup_input(button_pin, active_low=True, pull_up=True)

    # ----- main loop step -----
    def step(self) -> list:
        now = self.clock.monotonic()
        events = self.machine.update(self.gpio.read(self.button_pin), now)
        for ev in events:
            self.handle(ev)
        self._release_upload_holds()
        self.feedback.tick()
        return events

    def handle(self, event: str) -> None:
        cfg = self.uploader.config
        if event == "single":
            self.press(cfg.default_mode, append=False)
        elif event == "double":
            self.press(cfg.default_mode, append=True)
        elif event == "long":
            self.press("clip" if cfg.long_press_mode == "clip" else "long_burst", append=False)
        elif event == "stuck":
            log.warning("button held too long; ignoring until released")
            self.feedback.play("stuck")

    def _release_upload_holds(self) -> None:
        if not self._hold:
            return
        now = self.clock.monotonic()
        keep = []
        for key, deadline in self._hold:
            item = next((i for i in self.uploader.items if i.key == key), None)
            done = item is None or item.attempts > 0
            if done or now >= deadline:
                self.feedback.busy_off()
            else:
                keep.append((key, deadline))
        self._hold = keep

    # ----- one press -----
    def _grab(self, mode: str, cfg: CameraConfig) -> list:
        if mode == "clip":
            w, h = min(cfg.width, CLIP_MAX_W), min(cfg.height, CLIP_MAX_H)
            return self.source.clip(cfg.clip_seconds, w, h, cfg.clip_candidates)
        if mode == "long_burst":
            return self.source.burst(cfg.long_burst_frames, cfg.burst_seconds * 2, cfg.width, cfg.height)
        return self.source.burst(cfg.frames_for(mode), cfg.burst_seconds, cfg.width, cfg.height)

    def press(self, mode: str, append: bool) -> dict | None:
        cfg = self.uploader.config
        if self.uploader.pending() >= self.uploader.s.max_queue:
            self.feedback.play("queue_full")
            return None
        try:
            self.feedback.busy_on()
        except GpioError as e:
            log.error("capture LED cannot be driven, refusing to capture: %s", e)
            self.feedback.busy_off()
            return None
        hold = False
        summary: dict = {"mode": mode, "append": append, "attempts": 0, "fill_light": False}
        try:
            self.clock.sleep(PRE_CAPTURE_LED_S)
            if cfg.fill_light == "on" and self.feedback.has_fill_light:
                self.feedback.fill_light(True)
                summary["fill_light"] = True
            frames: list = []
            scores: list = []
            for attempt in range(2):
                summary["attempts"] = attempt + 1
                got = self._grab(mode, cfg)
                base = len(frames)
                frames.extend(got)
                scores.extend(score_jpeg(f, base + i) for i, f in enumerate(got))
                issue = common_issue(scores[base:])
                if attempt == 1 or not cfg.auto_retry or issue not in ("too dark", "blurry"):
                    break
                if issue == "too dark" and cfg.fill_light == "auto" and self.feedback.has_fill_light:
                    self.feedback.fill_light(True)
                    summary["fill_light"] = True
                log.info("all frames %s, capturing once more", issue)
            self.feedback.fill_light(False)
            keep_n = 1 if mode == "single" else cfg.keep_best
            best = select_best(scores, keep_n, min_score=cfg.min_upload_score)
            if not best:
                raise CaptureError("no usable frames")
            upload_frames = []
            frames_meta = []
            for i, s in enumerate(best):
                data, w, h = prepare_upload(frames[s.index], cfg.upload_max_edge, MAX_UPLOAD_BYTES, cfg.jpeg_quality)
                upload_frames.append(data)
                frames_meta.append({
                    "name": "frame%d" % i,
                    "score": s.score,
                    "width": w,
                    "height": h,
                    "sharpness": s.sharpness,
                    "brightness": s.brightness,
                    "clipped": s.clipped,
                    # The server cannot decode pixels: it trusts this verdict and does
                    # not send a flagged frame to the AI (docs/API.md, frames[].issues).
                    "issues": [i for i in s.issues if i in SERVER_ISSUES],
                })
            meta: dict = {
                "mode": "clip" if mode == "clip" else ("single" if mode == "single" else "burst"),
                "capturedAt": iso_utc(self.clock.wall()),
                "frames": frames_meta,
            }
            batt = self.battery()
            if batt is not None:
                meta["battery"] = batt
            key = self.uploader.enqueue(meta, upload_frames, append=append)
            self.feedback.play("captured")
            hold = True
            self._hold.append((key, self.clock.monotonic() + UPLOAD_LED_HOLD_S))
            summary.update({
                "key": key,
                "candidates": len(frames),
                "kept": [s.index for s in best],
                "scores": [s.score for s in scores],
                "issue": common_issue(scores),
                "meta": meta,
            })
            self.captures.append(summary)
            log.info("press %s mode=%s kept=%d of %d", key, meta["mode"], len(best), len(frames))
            return summary
        except QueueFull:
            self.feedback.play("queue_full")
            return None
        except (CaptureError, OSError, ValueError) as e:
            log.error("capture failed: %s", e)
            self.feedback.play("error")
            return None
        finally:
            try:
                self.feedback.fill_light(False)
            except GpioError:
                pass
            if not hold:
                self.feedback.busy_off()
            # Samples were missed while capturing: start the button fresh.
            self.machine.reset(self.gpio.read(self.button_pin), self.clock.monotonic())
