"""Button grammar: single, double and long press, with debounce.

Feed raw samples with update(pressed, now). The machine returns the events that
became certain at that moment:

- "long"   the button has been held for LONG_S. Fires while still held, so the
           user gets feedback without letting go. The release is then ignored.
- "double" two short presses, the second starting within DOUBLE_S of the first
           release.
- "single" a short press with no second press within DOUBLE_S.
- "stuck"  held longer than STUCK_S. Reported once; nothing fires until release.

Edges are dated from when the raw level last changed, so debounce does not add to
the measured hold time. A button already held when the machine starts (or after
reset()) is ignored until it has been released, so a shorted or stuck button
cannot cause captures on boot.

A first short press followed by a second press that becomes long gives "single"
then "long". The first press is not lost.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ButtonTiming:
    debounce_s: float = 0.03
    long_s: float = 0.8
    double_s: float = 0.35
    stuck_s: float = 15.0


class ButtonMachine:
    def __init__(self, timing: ButtonTiming | None = None) -> None:
        self.t = timing or ButtonTiming()
        self._raw: bool | None = None
        self._raw_changed_at = 0.0
        self._stable = False
        self._armed = True
        self._press_start = 0.0
        self._long_fired = False
        self._stuck_fired = False
        self._pending_click = False
        self._pending_since = 0.0

    def reset(self, pressed_now: bool, now: float) -> None:
        """Forget everything. Used after a blocking capture, when samples were missed."""
        self._raw = pressed_now
        self._raw_changed_at = now
        self._stable = pressed_now
        self._armed = not pressed_now
        self._long_fired = False
        self._stuck_fired = False
        self._pending_click = False

    @property
    def busy(self) -> bool:
        """True while a press may still turn into an event."""
        return self._stable or self._pending_click

    def update(self, pressed: bool, now: float) -> list[str]:
        events: list[str] = []
        if self._raw is None:
            # First sample: a button held at start is not a press.
            self.reset(pressed, now)
            return events
        if pressed != self._raw:
            self._raw = pressed
            self._raw_changed_at = now

        if self._raw != self._stable and now - self._raw_changed_at >= self.t.debounce_s:
            self._stable = self._raw
            edge_at = self._raw_changed_at
            if self._stable:
                events.extend(self._on_press(edge_at))
            else:
                events.extend(self._on_release(edge_at))

        if self._stable and self._armed:
            # If the raw level already shows a release (still inside debounce),
            # measure only up to that release, so debounce never lengthens a hold.
            held = (now if self._raw else self._raw_changed_at) - self._press_start
            if not self._long_fired and held >= self.t.long_s:
                self._long_fired = True
                if self._pending_click:
                    self._pending_click = False
                    events.append("single")
                events.append("long")
            if not self._stuck_fired and held >= self.t.stuck_s:
                self._stuck_fired = True
                events.append("stuck")

        if (
            self._pending_click
            and not self._stable
            and not self._raw
            and now - self._pending_since >= self.t.double_s
        ):
            self._pending_click = False
            events.append("single")
        return events

    def _on_press(self, at: float) -> list[str]:
        if not self._armed:
            return []
        self._press_start = at
        self._long_fired = False
        self._stuck_fired = False
        if self._pending_click and at - self._pending_since > self.t.double_s:
            # Too late to be a double. Normally "single" has already fired, but after
            # a gap in sampling it has not: fire it now so the first press is not lost.
            self._pending_click = False
            return ["single"]
        return []

    def _on_release(self, at: float) -> list[str]:
        if not self._armed:
            self._armed = True
            return []
        if self._long_fired or self._stuck_fired:
            return []
        if self._pending_click:
            self._pending_click = False
            return ["double"]
        self._pending_click = True
        self._pending_since = at
        return []
