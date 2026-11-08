"""Button grammar: timing boundaries, bounce, stuck buttons, randomised noise."""

from __future__ import annotations

import random
import unittest

from evencam.button import ButtonMachine, ButtonTiming

STEP = 0.005  # the client samples every 5 ms


def run(segments, timing=None, start_pressed=False, tail=1.0, step=STEP):
    """segments: list of (pressed, seconds). Returns [(event, time)]."""
    m = ButtonMachine(timing)
    t = 0.0
    events = []
    m.update(start_pressed, t)
    for pressed, dur in segments + [(False, tail)]:
        end = t + dur
        while t < end - 1e-9:
            t = round(t + step, 6)
            for e in m.update(pressed, t):
                events.append((e, t))
    return events


def names(evts):
    return [e for e, _ in evts]


def bounce(pressed, n=4, each=0.004):
    """n quick flips ending on `pressed`, as a worn contact does."""
    out = []
    for i in range(n):
        out.append((pressed if i % 2 else not pressed, each))
    out.append((pressed, each))
    return out


class BasicGrammar(unittest.TestCase):
    def test_single(self):
        ev = run([(False, 0.1), (True, 0.12)])
        self.assertEqual(names(ev), ["single"])
        # fires only after the double window has passed since release
        release = 0.1 + 0.12
        self.assertGreaterEqual(ev[0][1], release + 0.35)
        self.assertLess(ev[0][1], release + 0.35 + 0.05)

    def test_double(self):
        ev = run([(False, 0.1), (True, 0.1), (False, 0.15), (True, 0.1)])
        self.assertEqual(names(ev), ["double"])

    def test_long_fires_while_held(self):
        ev = run([(False, 0.1), (True, 1.5)])
        self.assertEqual(names(ev), ["long"])
        press_at = 0.1
        self.assertGreaterEqual(ev[0][1], press_at + 0.8)
        self.assertLess(ev[0][1], press_at + 0.8 + 0.05)  # well before release at 1.6

    def test_long_release_is_ignored(self):
        ev = run([(False, 0.1), (True, 1.0), (False, 0.1), (True, 0.1)])
        self.assertEqual(names(ev), ["long", "single"])

    def test_click_then_long_gives_single_then_long(self):
        ev = run([(False, 0.1), (True, 0.1), (False, 0.1), (True, 1.2)])
        self.assertEqual(names(ev), ["single", "long"])

    def test_triple_is_double_then_single(self):
        ev = run([(False, 0.1), (True, 0.08), (False, 0.1), (True, 0.08), (False, 0.1), (True, 0.08)])
        self.assertEqual(names(ev), ["double", "single"])

    def test_two_slow_clicks_are_two_singles(self):
        ev = run([(False, 0.1), (True, 0.1), (False, 0.6), (True, 0.1)])
        self.assertEqual(names(ev), ["single", "single"])

    def test_nothing_without_presses(self):
        self.assertEqual(run([(False, 5.0)]), [])


class Boundaries(unittest.TestCase):
    def test_just_below_long_is_short(self):
        ev = run([(False, 0.1), (True, 0.78)])
        self.assertEqual(names(ev), ["single"])

    def test_just_at_long_is_long(self):
        ev = run([(False, 0.1), (True, 0.83)])
        self.assertEqual(names(ev), ["long"])

    def test_double_gap_just_inside(self):
        ev = run([(False, 0.1), (True, 0.1), (False, 0.33), (True, 0.1)])
        self.assertEqual(names(ev), ["double"])

    def test_double_gap_just_outside(self):
        ev = run([(False, 0.1), (True, 0.1), (False, 0.38), (True, 0.1)])
        self.assertEqual(names(ev), ["single", "single"])

    def test_custom_timing(self):
        t = ButtonTiming(debounce_s=0.02, long_s=1.5, double_s=0.5, stuck_s=5)
        self.assertEqual(names(run([(False, 0.1), (True, 1.0)], t)), ["single"])
        self.assertEqual(names(run([(False, 0.1), (True, 1.6)], t)), ["long"])
        self.assertEqual(names(run([(False, 0.1), (True, 0.1), (False, 0.45), (True, 0.1)], t)), ["double"])


class Debounce(unittest.TestCase):
    def test_glitch_shorter_than_debounce_is_ignored(self):
        ev = run([(False, 0.1), (True, 0.015), (False, 0.5)])
        self.assertEqual(ev, [])

    def test_bounce_on_press_and_release(self):
        segs = [(False, 0.1)] + bounce(True) + [(True, 0.1)] + bounce(False) + [(False, 0.05)]
        self.assertEqual(names(run(segs)), ["single"])

    def test_bounce_does_not_make_a_double(self):
        # A press with release bounce must not look like two presses.
        segs = [(False, 0.1), (True, 0.15)] + bounce(False, n=6, each=0.006)
        self.assertEqual(names(run(segs)), ["single"])

    def test_hold_time_measured_from_first_edge(self):
        # Debounce delay must not shorten or lengthen a long press noticeably.
        ev = run([(False, 0.1)] + bounce(True) + [(True, 0.9)])
        self.assertEqual(names(ev), ["long"])
        self.assertLess(ev[0][1], 0.1 + 0.02 + 0.8 + 0.04)


class Safety(unittest.TestCase):
    def test_held_at_start_is_ignored_until_release(self):
        ev = run([(True, 2.0), (False, 0.2), (True, 0.1)], start_pressed=True)
        self.assertEqual(names(ev), ["single"])

    def test_stuck_button(self):
        ev = run([(False, 0.1), (True, 16.0)], timing=ButtonTiming(stuck_s=15.0), step=0.01)
        self.assertEqual(names(ev), ["long", "stuck"])

    def test_reset_while_held_ignores_rest_of_press(self):
        m = ButtonMachine()
        m.update(False, 0.0)
        for i in range(1, 60):
            m.update(True, i * 0.005)
        m.reset(True, 0.3)
        events = []
        t = 0.3
        for _ in range(400):
            t += 0.005
            events += m.update(True, t)
        for _ in range(200):
            t += 0.005
            events += m.update(False, t)
        self.assertEqual(events, [])

    def test_reset_released_is_armed(self):
        m = ButtonMachine()
        m.update(False, 0.0)
        m.reset(False, 1.0)
        evs = []
        t = 1.0
        for p, d in [(True, 0.1), (False, 0.6)]:
            for _ in range(int(d / 0.005)):
                t += 0.005
                evs += m.update(p, t)
        self.assertEqual(evs, ["single"])

    def test_busy_flag(self):
        m = ButtonMachine()
        m.update(False, 0)
        self.assertFalse(m.busy)
        for i in range(1, 20):
            m.update(True, i * 0.005)
        self.assertTrue(m.busy)

    def test_irregular_sampling(self):
        # The main loop may stall (e.g. during a log write); gaps of 40 ms still work.
        ev = run([(False, 0.1), (True, 0.2), (False, 0.1), (True, 0.2)], step=0.04)
        self.assertEqual(names(ev), ["double"])


class RandomisedNoise(unittest.TestCase):
    """Property: adding contact bounce (< debounce) at every edge never changes the events."""

    def test_bounce_never_changes_meaning(self):
        rnd = random.Random(42)
        for trial in range(300):
            clean = [(False, 0.1)]
            for _ in range(rnd.randint(1, 4)):
                hold = rnd.choice([0.06, 0.12, 0.3, 0.6, 1.0, 1.4])
                gap = rnd.choice([0.1, 0.2, 0.5, 0.9])
                clean += [(True, hold), (False, gap)]
            noisy = []
            for pressed, dur in clean:
                flips = rnd.randint(0, 3)
                each = rnd.uniform(0.002, 0.006)
                pre = []
                for i in range(flips):
                    pre.append((not pressed if i % 2 == 0 else pressed, each))
                used = sum(d for _, d in pre)
                noisy += pre + [(pressed, max(0.01, dur - used))]
            with self.subTest(trial=trial):
                self.assertEqual(names(run(noisy)), names(run(clean)), clean)

    def test_random_glitches_alone_never_fire(self):
        rnd = random.Random(7)
        for trial in range(200):
            segs = []
            for _ in range(rnd.randint(1, 20)):
                segs += [(False, rnd.uniform(0.03, 0.3)), (True, rnd.uniform(0.001, 0.02))]
            with self.subTest(trial=trial):
                self.assertEqual(run(segs), [])


if __name__ == "__main__":
    unittest.main()


class SampleGaps(unittest.TestCase):
    """The main loop can stall (a capture, a slow GPIO read). A gap in sampling
    must never lose a press."""

    def test_second_press_seen_late_keeps_first_single(self):
        m = ButtonMachine()
        got = []
        for pressed, t in [(False, 0.0), (True, 0.01), (True, 0.05), (False, 0.15), (False, 0.19),
                           # no samples for 400 ms, then the next press is already down
                           (True, 0.60), (True, 0.64), (False, 0.70), (False, 0.74), (False, 1.20)]:
            got.extend(m.update(pressed, t))
        self.assertEqual(got, ["single", "single"])
