"""Time source behind an interface, so tests run with a fake clock."""

from __future__ import annotations

import threading
import time


class Clock:
    def monotonic(self) -> float:
        raise NotImplementedError

    def wall(self) -> float:
        """Seconds since the epoch, for the capturedAt timestamp only."""
        raise NotImplementedError

    def sleep(self, seconds: float) -> None:
        raise NotImplementedError


class RealClock(Clock):
    def monotonic(self) -> float:
        return time.monotonic()

    def wall(self) -> float:
        return time.time()

    def sleep(self, seconds: float) -> None:
        if seconds > 0:
            time.sleep(seconds)


class FakeClock(Clock):
    """Manual clock. sleep() advances time instantly."""

    def __init__(self, start: float = 1000.0, epoch: float = 1_793_000_000.0) -> None:
        self._now = start
        self._epoch_offset = epoch - start
        self._lock = threading.Lock()
        self.sleeps: list[float] = []

    def monotonic(self) -> float:
        with self._lock:
            return self._now

    def wall(self) -> float:
        with self._lock:
            return self._now + self._epoch_offset

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.advance(seconds)

    def advance(self, seconds: float) -> None:
        with self._lock:
            self._now += max(0.0, seconds)


def iso_utc(epoch_seconds: float) -> str:
    t = time.gmtime(epoch_seconds)
    ms = int(round((epoch_seconds - int(epoch_seconds)) * 1000)) % 1000
    return time.strftime("%Y-%m-%dT%H:%M:%S", t) + ".%03dZ" % ms
