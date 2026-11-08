"""LED and vibration feedback.

The capture LED has two jobs:

1. Tell other people the camera is taking pictures. While `busy` is set the LED is
   solid on. Busy is set at least PRE_CAPTURE_LED_S before the sensor is read and
   stays set through capture and upload. Nothing in the remote config can change
   this, and there is no setting for it.
2. Tell the wearer what happened, with short blink patterns once busy ends.

Patterns (LED steps in ms, on/off alternating, starting with on):

| Name           | LED                         | Motor        | Meaning                                  |
| -------------- | --------------------------- | ------------ | ---------------------------------------- |
| boot           | 200                         | -            | Client started                           |
| captured       | (solid while busy)          | 60           | Frames taken                             |
| uploaded       | 80 120 80                   | -            | Server accepted the press                |
| queued_offline | 400 400 400 400 400         | -            | No network, saved in RAM, will retry     |
| ready          | 600                         | 60 100 60    | Answer is ready on the glasses           |
| retake         | 100x5 with 100 gaps         | 250 150 250  | Take the photo again (reason on lens)    |
| error          | 1200                        | 400          | Upload failed for good, or capture error |
| queue_full     | 60x5 with 60 gaps           | 400          | Too many unsent presses, press ignored   |
| stuck          | 60 60 60 60 1200            | -            | Button held too long, check wiring       |
"""

from __future__ import annotations

import threading
from typing import Callable

from .gpio import Gpio

PRE_CAPTURE_LED_S = 0.5  # fixed by the spec: LED on at least 500 ms before capture

PATTERNS: dict[str, tuple[list[int], list[int]]] = {
    "boot": ([200], []),
    "captured": ([], [60]),
    "uploaded": ([80, 120, 80], []),
    "queued_offline": ([400, 400, 400, 400, 400], []),
    "ready": ([600], [60, 100, 60]),
    "retake": ([100, 100, 100, 100, 100, 100, 100, 100, 100], [250, 150, 250]),
    "error": ([1200], [400]),
    "queue_full": ([60, 60, 60, 60, 60, 60, 60, 60, 60], [400]),
    "stuck": ([60, 60, 60, 60, 1200], []),
}


class _Track:
    """One output (LED or motor) playing queued step lists."""

    def __init__(self) -> None:
        self.queue: list[list[int]] = []
        self.steps: list[int] = []
        self.started_at = 0.0

    def add(self, steps: list[int], now: float) -> None:
        if not steps:
            return
        if not self.steps:
            self.steps = list(steps)
            self.started_at = now
        else:
            self.queue.append(list(steps))

    def level(self, now: float) -> bool:
        while self.steps:
            elapsed_ms = (now - self.started_at) * 1000.0
            acc = 0
            for i, ms in enumerate(self.steps):
                acc += ms
                if elapsed_ms < acc:
                    return i % 2 == 0
            # pattern finished; 150 ms gap before the next one
            gap_end = acc + 150
            if self.queue and elapsed_ms >= gap_end:
                self.steps = self.queue.pop(0)
                self.started_at = self.started_at + gap_end / 1000.0
                continue
            if self.queue:
                return False
            self.steps = []
        return False

    @property
    def idle(self) -> bool:
        return not self.steps and not self.queue


class Feedback:
    def __init__(
        self,
        gpio: Gpio,
        led_pin: int,
        now: Callable[[], float],
        motor_pin: int | None = None,
        fill_light_pin: int | None = None,
        led_active_low: bool = False,
    ) -> None:
        self.gpio = gpio
        self.led_pin = led_pin
        self.motor_pin = motor_pin
        self.fill_light_pin = fill_light_pin
        self._now = now
        self._lock = threading.RLock()
        self._busy = 0
        self._led = _Track()
        self._motor = _Track()
        self.played: list[str] = []
        gpio.setup_output(led_pin, active_low=led_active_low)
        if motor_pin is not None:
            gpio.setup_output(motor_pin)
        if fill_light_pin is not None:
            gpio.setup_output(fill_light_pin)

    @property
    def has_fill_light(self) -> bool:
        return self.fill_light_pin is not None

    def busy_on(self) -> None:
        """LED solid on. Raises GpioError if the LED cannot be driven; caller must not capture."""
        with self._lock:
            self._busy += 1
            self.gpio.write(self.led_pin, True)

    def busy_off(self) -> None:
        with self._lock:
            self._busy = max(0, self._busy - 1)
            if self._busy == 0:
                self.tick()

    @property
    def busy(self) -> bool:
        return self._busy > 0

    def fill_light(self, on: bool) -> None:
        if self.fill_light_pin is not None:
            self.gpio.write(self.fill_light_pin, on)

    def play(self, name: str) -> None:
        led, motor = PATTERNS[name]
        with self._lock:
            now = self._now()
            self.played.append(name)
            self._led.add(led, now)
            self._motor.add(motor, now)
            self.tick()

    @property
    def idle(self) -> bool:
        return self._led.idle and self._motor.idle and not self.busy

    def tick(self) -> None:
        with self._lock:
            now = self._now()
            led_on = self._busy > 0 or self._led.level(now)
            try:
                self.gpio.write(self.led_pin, led_on)
                if self.motor_pin is not None:
                    self.gpio.write(self.motor_pin, self._motor.level(now))
            except Exception:  # noqa: BLE001 - feedback must never crash the loop
                pass

    def all_off(self) -> None:
        with self._lock:
            self._busy = 0
            self._led = _Track()
            self._motor = _Track()
            for pin in (self.led_pin, self.motor_pin, self.fill_light_pin):
                if pin is not None:
                    try:
                        self.gpio.write(pin, False)
                    except Exception:  # noqa: BLE001
                        pass
