"""GPIO behind one small interface: button input, LED, vibration motor, fill light.

Backends:
- FakeGpio: in memory, records every write with a timestamp. Used by tests.
- SysfsGpio: /sys/class/gpio. Old interface, still present on the FriendlyCore 4.14
  kernel for the NanoPi Duo2 (ASSUMPTION). No pull-up control: wire an external
  10 kOhm pull-up on the button pin (see WIRING.md).
- GpiodGpio: the character device through the python gpiod bindings, v1 or v2 API.
  Used on Raspberry Pi OS and newer Armbian. Supports the internal pull-up.

All pins are "logical": read() returns True when the button is pressed, write(True)
turns the LED or motor on. Active-low wiring is handled here, not by callers.
None of these backends has been run on a real board. EXPERIMENT NEEDED.
"""

from __future__ import annotations

import os
import threading
from typing import Callable


class GpioError(RuntimeError):
    pass


class Gpio:
    def setup_input(self, pin: int, active_low: bool = True, pull_up: bool = True) -> None:
        raise NotImplementedError

    def setup_output(self, pin: int, active_low: bool = False) -> None:
        raise NotImplementedError

    def read(self, pin: int) -> bool:
        raise NotImplementedError

    def write(self, pin: int, on: bool) -> None:
        raise NotImplementedError

    def close(self) -> None:
        pass


class FakeGpio(Gpio):
    def __init__(self, now: Callable[[], float] | None = None) -> None:
        self._now = now or (lambda: 0.0)
        self.inputs: dict[int, bool] = {}
        self.outputs: dict[int, bool] = {}
        self.history: list[tuple[float, int, bool]] = []
        self.fail_writes: set[int] = set()
        self._lock = threading.Lock()

    def setup_input(self, pin: int, active_low: bool = True, pull_up: bool = True) -> None:
        self.inputs.setdefault(pin, False)

    def setup_output(self, pin: int, active_low: bool = False) -> None:
        self.outputs[pin] = False

    def set_input(self, pin: int, pressed: bool) -> None:
        self.inputs[pin] = pressed

    def read(self, pin: int) -> bool:
        return self.inputs.get(pin, False)

    def write(self, pin: int, on: bool) -> None:
        if pin in self.fail_writes:
            raise GpioError("simulated write failure on pin %d" % pin)
        with self._lock:
            if pin not in self.outputs:
                raise GpioError("pin %d not set up as output" % pin)
            if self.outputs[pin] != on:
                self.history.append((self._now(), pin, on))
            self.outputs[pin] = on

    def on_intervals(self, pin: int) -> list[tuple[float, float | None]]:
        """(on_at, off_at) pairs for a pin, off_at None if still on."""
        out: list[tuple[float, float | None]] = []
        start = None
        for t, p, on in self.history:
            if p != pin:
                continue
            if on and start is None:
                start = t
            elif not on and start is not None:
                out.append((start, t))
                start = None
        if start is not None:
            out.append((start, None))
        return out


class SysfsGpio(Gpio):
    def __init__(self, root: str = "/sys/class/gpio") -> None:
        self.root = root
        self._active_low: dict[int, bool] = {}
        self._exported: list[int] = []

    def _pin_dir(self, pin: int) -> str:
        return os.path.join(self.root, "gpio%d" % pin)

    def _export(self, pin: int) -> None:
        if not os.path.isdir(self._pin_dir(pin)):
            try:
                with open(os.path.join(self.root, "export"), "w") as f:
                    f.write(str(pin))
            except OSError as e:
                raise GpioError("cannot export GPIO %d: %s" % (pin, e)) from e
            self._exported.append(pin)
        if not os.path.isdir(self._pin_dir(pin)):
            raise GpioError("GPIO %d did not appear after export" % pin)

    def _write_attr(self, pin: int, name: str, value: str) -> None:
        with open(os.path.join(self._pin_dir(pin), name), "w") as f:
            f.write(value)

    def setup_input(self, pin: int, active_low: bool = True, pull_up: bool = True) -> None:
        self._export(pin)
        self._write_attr(pin, "direction", "in")
        self._active_low[pin] = active_low

    def setup_output(self, pin: int, active_low: bool = False) -> None:
        self._export(pin)
        # "low" sets direction to output and drives it low in one step, no glitch.
        self._write_attr(pin, "direction", "high" if active_low else "low")
        self._active_low[pin] = active_low

    def read(self, pin: int) -> bool:
        with open(os.path.join(self._pin_dir(pin), "value")) as f:
            level = f.read().strip() == "1"
        return level != self._active_low.get(pin, False)

    def write(self, pin: int, on: bool) -> None:
        level = on != self._active_low.get(pin, False)
        try:
            self._write_attr(pin, "value", "1" if level else "0")
        except OSError as e:
            raise GpioError("write to GPIO %d failed: %s" % (pin, e)) from e

    def close(self) -> None:
        for pin in self._exported:
            try:
                with open(os.path.join(self.root, "unexport"), "w") as f:
                    f.write(str(pin))
            except OSError:
                pass
        self._exported = []


class GpiodGpio(Gpio):
    """python3-libgpiod. Pins are line offsets on one chip. Not run on hardware."""

    def __init__(self, chip: str = "/dev/gpiochip0", consumer: str = "even-g2-camera") -> None:
        try:
            import gpiod  # type: ignore
        except ImportError as e:
            raise GpioError("python gpiod bindings missing: apt install python3-libgpiod") from e
        self._gpiod = gpiod
        self._v2 = hasattr(gpiod, "request_lines")
        self._chip_path = chip
        self._consumer = consumer
        self._lines: dict[int, object] = {}
        self._active_low: dict[int, bool] = {}
        if not self._v2:
            name = chip.replace("/dev/", "")
            self._chip = gpiod.Chip(name)

    def _request(self, pin: int, output: bool, pull_up: bool) -> None:
        g = self._gpiod
        if self._v2:
            from gpiod.line import Bias, Direction, Value  # type: ignore

            settings = g.LineSettings(
                direction=Direction.OUTPUT if output else Direction.INPUT,
                bias=Bias.PULL_UP if (pull_up and not output) else Bias.AS_IS,
                output_value=Value.INACTIVE,
            )
            self._lines[pin] = g.request_lines(
                self._chip_path, consumer=self._consumer, config={pin: settings}
            )
        else:
            line = self._chip.get_line(pin)
            flags = 0
            if pull_up and not output and hasattr(g, "LINE_REQ_FLAG_BIAS_PULL_UP"):
                flags |= g.LINE_REQ_FLAG_BIAS_PULL_UP
            line.request(
                consumer=self._consumer,
                type=g.LINE_REQ_DIR_OUT if output else g.LINE_REQ_DIR_IN,
                flags=flags,
            )
            self._lines[pin] = line

    def setup_input(self, pin: int, active_low: bool = True, pull_up: bool = True) -> None:
        self._request(pin, False, pull_up)
        self._active_low[pin] = active_low

    def setup_output(self, pin: int, active_low: bool = False) -> None:
        self._request(pin, True, False)
        self._active_low[pin] = active_low
        self.write(pin, False)

    def read(self, pin: int) -> bool:
        line = self._lines[pin]
        if self._v2:
            from gpiod.line import Value  # type: ignore

            level = line.get_value(pin) == Value.ACTIVE  # type: ignore[attr-defined]
        else:
            level = line.get_value() == 1  # type: ignore[attr-defined]
        return level != self._active_low.get(pin, False)

    def write(self, pin: int, on: bool) -> None:
        level = on != self._active_low.get(pin, False)
        line = self._lines[pin]
        try:
            if self._v2:
                from gpiod.line import Value  # type: ignore

                line.set_value(pin, Value.ACTIVE if level else Value.INACTIVE)  # type: ignore[attr-defined]
            else:
                line.set_value(1 if level else 0)  # type: ignore[attr-defined]
        except Exception as e:  # noqa: BLE001 - library raises various types
            raise GpioError("write to line %d failed: %s" % (pin, e)) from e

    def close(self) -> None:
        for line in self._lines.values():
            try:
                line.release()  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001
                pass
        self._lines = {}
