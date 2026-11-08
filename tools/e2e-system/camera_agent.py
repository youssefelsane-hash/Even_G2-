"""Camera side of the full-system test (tools/e2e-system/run.mjs starts it).

Runs the real Linux camera client loop, the same objects and two loops as
`python -m evencam` (controller sampling the button every 5 ms, uploader service
thread), with two fakes: GPIO (FakeGpio) and the camera sensor (a scene source
fed from camera/testdata). Button presses are made by changing the fake button
level with real timing, so the real debounce and press grammar decide what a
press is.

Reads one JSON command per line on stdin:
  {"cmd": "scene", "name": "sharp" | "dark" | "blurry" | "glare" | "page2"}
  {"cmd": "press", "kind": "single" | "double" | "long" | "bounce"}
  {"cmd": "state"}
  {"cmd": "quit"}
Writes one JSON line per event on stdout: {"ev": "led", "name": ...} for every
LED/motor pattern, {"ev": "capture", ...} per press, {"ev": "reply", ...} per command.
Logs go to stderr. Never prints the token.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "camera", "linux"))

from evencam.clock import RealClock  # noqa: E402
from evencam.config import settings_from_env  # noqa: E402
from evencam.controller import Controller  # noqa: E402
from evencam.feedback import Feedback  # noqa: E402
from evencam.gpio import FakeGpio  # noqa: E402
from evencam.sources import FakeSource  # noqa: E402
from evencam.transport import UrllibTransport  # noqa: E402
from evencam.uploader import Uploader  # noqa: E402

TESTDATA = os.path.join(ROOT, "camera", "testdata")
SCENES = {
    "sharp": ["burst/frame0.jpg", "burst/frame1.jpg", "burst/frame2.jpg", "burst/frame3.jpg"],
    "dark": ["dark-burst/frame0.jpg", "dark-burst/frame1.jpg", "dark-burst/frame2.jpg"],
    "blurry": ["blur.jpg", "motion.jpg"],
    "glare": ["glare.jpg"],
    "page2": ["page2.jpg"],
    "clean": ["clean.jpg"],
}

out_lock = threading.Lock()


def emit(obj: dict) -> None:
    with out_lock:
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()


class SceneSource(FakeSource):
    """FakeSource whose folder content is switched by the test: what the camera 'sees'."""

    def set_scene(self, name: str) -> None:
        self.files = [os.path.join(TESTDATA, f) for f in SCENES[name]]
        self._pos = 0


def main() -> int:
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="camera %(levelname)s %(message)s")
    env = dict(os.environ)
    env["GPIO_BACKEND"] = "fake"
    env["CAMERA_SOURCE"] = "fake"
    s = settings_from_env(env)
    clock = RealClock()
    gpio = FakeGpio(clock.monotonic)
    feedback = Feedback(gpio, s.led_pin, clock.monotonic, motor_pin=5)
    original_play = feedback.play

    def play(name: str) -> None:
        emit({"ev": "led", "name": name, "t": round(time.time(), 3)})
        original_play(name)

    feedback.play = play  # type: ignore[method-assign]
    source = SceneSource()
    source.set_scene("sharp")
    uploader = Uploader(s, UrllibTransport(), clock.monotonic, feedback.play)
    controller = Controller(gpio, s.button_pin, source, uploader, feedback, clock)
    original_press = controller.press

    def press(mode: str, append: bool):
        summary = original_press(mode, append)
        emit({
            "ev": "capture",
            "mode": mode,
            "append": append,
            "ok": summary is not None,
            "key": summary and summary.get("key"),
            "kept": summary and summary.get("kept"),
            "candidates": summary and summary.get("candidates"),
            "attempts": summary and summary.get("attempts"),
            "issue": summary and summary.get("issue"),
            "metaMode": summary and summary["meta"]["mode"],
            "uploadFrames": summary and len(summary["meta"]["frames"]),
        })
        return summary

    controller.press = press  # type: ignore[method-assign]
    stop = threading.Event()

    def service_loop():
        while not stop.is_set():
            try:
                uploader.service()
            except Exception:  # noqa: BLE001
                logging.exception("service step failed")
            stop.wait(0.2)

    def main_loop():
        while not stop.is_set():
            controller.step()
            stop.wait(0.005)

    def hold(seconds: float) -> None:
        gpio.set_input(s.button_pin, True)
        time.sleep(seconds)
        gpio.set_input(s.button_pin, False)

    def do_press(kind: str) -> None:
        if kind == "single":
            hold(0.12)
        elif kind == "double":
            hold(0.10)
            time.sleep(0.15)
            hold(0.10)
        elif kind == "long":
            hold(1.1)
        elif kind == "bounce":
            # Contact chatter on press and release (2-6 ms), one real 150 ms press.
            for _ in range(4):
                gpio.set_input(s.button_pin, True)
                time.sleep(0.003)
                gpio.set_input(s.button_pin, False)
                time.sleep(0.003)
            hold(0.15)
            for _ in range(3):
                gpio.set_input(s.button_pin, True)
                time.sleep(0.003)
                gpio.set_input(s.button_pin, False)
                time.sleep(0.003)
        else:
            raise ValueError("unknown press %r" % kind)

    threading.Thread(target=service_loop, name="uploader", daemon=True).start()
    loop = threading.Thread(target=main_loop, name="controller", daemon=True)
    loop.start()
    feedback.play("boot")
    emit({"ev": "ready", "pending": uploader.pending()})
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            c = json.loads(line)
            cmd = c.get("cmd")
            reply: dict = {"ev": "reply", "id": c.get("id"), "ok": True}
            try:
                if cmd == "scene":
                    source.set_scene(c["name"])
                elif cmd == "press":
                    do_press(c["kind"])
                elif cmd == "state":
                    with uploader.lock:
                        reply.update({
                            "pending": len(uploader.items),
                            "polls": len(uploader.polls),
                            "uploaded": uploader.stats.uploaded,
                            "retried": uploader.stats.retried,
                            "dropped": uploader.stats.dropped,
                            "statuses": list(uploader.stats.statuses),
                            "jobIds": dict(uploader.job_ids),
                            "config": {"burst": uploader.config.burst_frames, "keep": uploader.config.keep_best,
                                       "long": uploader.config.long_press_mode},
                            "configLoaded": uploader.config_loaded,
                        })
                    reply["ledOn"] = gpio.outputs.get(s.led_pin, False)
                    reply["queueDirEntries"] = sorted(os.listdir(s.queue_dir)) if os.path.isdir(s.queue_dir) else []
                elif cmd == "quit":
                    emit(reply)
                    break
                else:
                    raise ValueError("unknown command %r" % cmd)
            except Exception as e:  # noqa: BLE001
                reply = {"ev": "reply", "id": c.get("id"), "ok": False, "error": str(e)}
            emit(reply)
    finally:
        stop.set()
        loop.join(timeout=5)
        feedback.all_off()
        source.close()
        gpio.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
