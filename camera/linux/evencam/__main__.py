"""Entry point: python3 -I -m evencam  (systemd runs this; see systemd/).

Reads settings from the environment, then runs two loops:
- main thread: button sampling every 5 ms, captures, LED patterns
- service thread: uploads, retries, status polling, config refresh

SIGTERM or SIGINT stops both, turns every output off and releases the GPIO lines.
Logs carry job keys and timings only, never the token or any answer text.
"""

from __future__ import annotations

import logging
import signal
import sys
import threading

from .clock import RealClock
from .config import SettingsError, settings_from_env
from .controller import Controller
from .feedback import Feedback
from .gpio import FakeGpio, Gpio, GpiodGpio, SysfsGpio
from .sources import make_source
from .transport import UrllibTransport
from .uploader import Uploader

log = logging.getLogger("evencam")
LOOP_S = 0.005
SERVICE_S = 0.2


def read_battery(path: str):
    if not path:
        return lambda: None

    def read():
        try:
            with open(path) as f:
                v = int(float(f.read().strip()))
            return max(0, min(100, v))
        except (OSError, ValueError):
            return None

    return read


def make_gpio(kind: str, chip: str, clock: RealClock) -> Gpio:
    if kind == "sysfs":
        return SysfsGpio()
    if kind == "fake":
        return FakeGpio(clock.monotonic)
    return GpiodGpio(chip)


def main(argv: list | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    try:
        s = settings_from_env()
    except SettingsError as e:
        log.error("configuration: %s", e)
        return 2
    clock = RealClock()
    gpio = make_gpio(s.gpio_backend, s.gpio_chip, clock)
    feedback = Feedback(
        gpio, s.led_pin, clock.monotonic, s.motor_pin, s.fill_light_pin, led_active_low=s.led_active_low
    )
    stop = threading.Event()
    uploader = Uploader(s, UrllibTransport(s.ca_file), clock.monotonic, feedback.play)
    source = make_source(
        s.camera_source,
        device=s.v4l2_device,
        input_format=s.v4l2_input_format,
        workdir=s.work_dir,
        fake_dir=s.fake_source_dir,
    )
    controller = Controller(gpio, s.button_pin, source, uploader, feedback, clock, read_battery(s.battery_file))

    def on_signal(signum, _frame):
        stop.set()

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)

    def service_loop():
        while not stop.is_set():
            try:
                uploader.service()
            except Exception:  # noqa: BLE001 - keep the camera alive, log and continue
                log.exception("service step failed")
            stop.wait(SERVICE_S)

    worker = threading.Thread(target=service_loop, name="uploader", daemon=True)
    worker.start()
    feedback.play("boot")
    log.info("ready: %r, %d presses waiting", s, uploader.pending())
    try:
        while not stop.is_set():
            controller.step()
            stop.wait(LOOP_S)
    finally:
        stop.set()
        worker.join(timeout=5)
        feedback.all_off()
        source.close()
        gpio.close()
        log.info("stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
