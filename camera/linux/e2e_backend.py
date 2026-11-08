"""Drive the real camera client code against a running backend (mock AI is fine).

    SERVER_URL=http://127.0.0.1:8787 DEVICE_TOKEN=... DEVICE_ID=cam1 \\
        camera/.venv/bin/python -I camera/linux/e2e_backend.py

Uses the real controller, scorer, queue and HTTP transport, with fake GPIO and a
fake camera fed from camera/testdata. Presses: a sharp burst, a double press that
adds a page, a dark burst, a long press (clip mode), and a press while the server
is unreachable that is sent later. Prints one line per press with what the camera
LED would have shown. Exit code 0 when every press reached a final status.
Not part of the unit tests because it needs a backend.
"""

from __future__ import annotations

import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from evencam.clock import RealClock  # noqa: E402
from evencam.config import settings_from_env  # noqa: E402
from evencam.controller import Controller  # noqa: E402
from evencam.feedback import Feedback  # noqa: E402
from evencam.gpio import FakeGpio  # noqa: E402
from evencam.sources import FakeSource  # noqa: E402
from evencam.transport import TransportError, UrllibTransport  # noqa: E402
from evencam.uploader import Uploader  # noqa: E402

TESTDATA = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "testdata"))


def load(*names):
    out = []
    for n in names:
        with open(os.path.join(TESTDATA, n), "rb") as f:
            out.append(f.read())
    return out


class Switchable(UrllibTransport):
    def __init__(self):
        super().__init__()
        self.down = False

    def request(self, *a, **kw):
        if self.down:
            raise TransportError("simulated: hotspot off")
        return super().request(*a, **kw)


def main() -> int:
    env = dict(os.environ)
    env.setdefault("ALLOW_INSECURE_HTTP", "1")
    env.setdefault("GPIO_BACKEND", "fake")
    env.setdefault("CAMERA_SOURCE", "fake")
    state = tempfile.mkdtemp(prefix="evencam-e2e-")
    env["STATE_DIR"] = state
    s = settings_from_env(env)
    clock = RealClock()
    gpio = FakeGpio(clock.monotonic)
    fb = Feedback(gpio, s.led_pin, clock.monotonic, motor_pin=4)
    transport = Switchable()
    up = Uploader(s, transport, clock.monotonic, fb.play)
    cfg = up.fetch_config_now()
    print("config from server: N=%d K=%d long=%s res=%dx%d" % (
        cfg.burst_frames, cfg.keep_best, cfg.long_press_mode, cfg.width, cfg.height))
    burst = load(*["burst/frame%d.jpg" % i for i in range(4)])
    dark = load(*["dark-burst/frame%d.jpg" % i for i in range(3)])
    source = FakeSource(script=[
        burst,
        load("page2.jpg") * 4,
        dark, dark,  # auto retry takes a second dark burst
        burst * 3,  # clip
        load("clean.jpg", "glare.jpg", "motion.jpg", "blur.jpg"),
    ])
    ctl = Controller(gpio, s.button_pin, source, up, fb, clock)

    def settle(seconds):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            up.service()
            ctl.step()
            if up.idle and fb.idle and not fb.busy:
                break
            time.sleep(0.05)

    plan = [("sharp burst", "burst", False), ("added page", "burst", True), ("dark burst", "burst", False),
            ("long press", "clip", False)]
    ok = True
    for label, mode, append in plan:
        before = len(fb.played)
        summary = ctl.press(mode, append)
        settle(40)
        shown = fb.played[before:]
        final = [p for p in shown if p in ("ready", "retake", "error")]
        print("%-12s kept=%s scores=%s led=%s" % (label, summary and summary["kept"], summary and summary["scores"], shown))
        ok = ok and bool(final)

    transport.down = True
    before = len(fb.played)
    ctl.press("burst", False)
    settle(3)
    print("offline      queued=%d led=%s" % (up.pending(), fb.played[before:]))
    transport.down = False
    settle(70)
    shown = fb.played[before:]
    print("back online  queued=%d led=%s" % (up.pending(), shown))
    ok = ok and up.pending() == 0 and any(p in ("ready", "retake") for p in shown)
    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
