"""Whole camera client with fake button, LED, clock, camera and server."""

from __future__ import annotations

import random

from evencam.clock import FakeClock
from evencam.controller import Controller
from evencam.feedback import PRE_CAPTURE_LED_S, Feedback
from evencam.gpio import FakeGpio
from evencam.sources import CaptureError, FakeSource
from evencam.uploader import Uploader
from tests.helpers import FakeTransport, TempDirCase, burst_frames, img, make_settings, offline

BUTTON, LED, MOTOR, FILL = 2, 3, 4, 5


class TimedSource(FakeSource):
    """Records the clock time of every capture call and the LED state at that moment."""

    def __init__(self, clock, gpio, **kw):
        super().__init__(**kw)
        self.clock = clock
        self.gpio = gpio
        self.call_times = []
        self.led_at_call = []
        self.fill_at_call = []

    def _next(self, n):
        self.call_times.append(self.clock.monotonic())
        self.led_at_call.append(self.gpio.outputs.get(LED))
        self.fill_at_call.append(self.gpio.outputs.get(FILL))
        return super()._next(n)


class Rig(TempDirCase):
    fill_light = False

    def setUp(self):
        super().setUp()
        self.clock = FakeClock()
        self.gpio = FakeGpio(self.clock.monotonic)
        self.transport = FakeTransport()
        self.settings = make_settings(self.tmp)
        self.fb = Feedback(self.gpio, LED, self.clock.monotonic, motor_pin=MOTOR,
                           fill_light_pin=FILL if self.fill_light else None)
        self.up = Uploader(self.settings, self.transport, self.clock.monotonic, self.fb.play, random.Random(3))
        self.up.fetch_config_now()
        self.source = TimedSource(self.clock, self.gpio, script=[])
        self.ctl = Controller(self.gpio, BUTTON, self.source, self.up, self.fb, self.clock)
        self.events = []
        self.ctl.step()  # first sample: button released

    def hold(self, pressed, seconds, service=True):
        end = self.clock.monotonic() + seconds
        self.gpio.set_input(BUTTON, pressed)
        while self.clock.monotonic() < end:
            self.clock.advance(0.005)
            self.events += self.ctl.step()
            if service:
                self.up.service()

    def click(self):
        self.hold(True, 0.12)
        self.hold(False, 0.6)

    def double(self):
        self.hold(True, 0.1)
        self.hold(False, 0.12)
        self.hold(True, 0.1)
        self.hold(False, 0.6)

    def long(self):
        self.hold(True, 1.2)
        self.hold(False, 0.5)


class Presses(Rig):
    def test_single_press_uploads_best_frames_of_burst(self):
        self.source.script = [burst_frames()]
        self.click()
        self.hold(False, 3)
        self.assertEqual(self.events, ["single"])
        self.assertEqual(self.source.calls[0][:2], ("burst", 4))
        meta = self.transport.meta_of("job1")
        self.assertEqual(meta["mode"], "burst")
        self.assertEqual([f["name"] for f in meta["frames"]], ["frame0", "frame1"])
        self.assertEqual(meta["frames"][0]["score"], 1.0)
        self.assertEqual(self.transport.jobs["job1"]["frame0"][1], img("burst/frame1.jpg"))
        self.assertNotIn("appendTo", meta)
        # The camera's own verdict travels with each frame, so the server agrees with it.
        self.assertEqual([f["issues"] for f in meta["frames"]], [[], []])
        self.assertIn("captured", self.fb.played)
        self.assertIn("uploaded", self.fb.played)

    def test_led_on_at_least_500_ms_before_capture_and_through_upload(self):
        self.source.script = [burst_frames()]
        self.click()
        self.hold(False, 3)
        self.assertTrue(self.source.led_at_call[0])
        first_on = self.gpio.on_intervals(LED)[0]
        self.assertGreaterEqual(self.source.call_times[0] - first_on[0], PRE_CAPTURE_LED_S - 1e-9)
        # the first solid-on period lasts past capture, until the upload was attempted
        self.assertEqual(len(self.transport.posts()), 1)
        self.assertGreater(first_on[1], self.source.call_times[0])
        self.assertIsNotNone(first_on[1])

    def test_led_stays_on_while_offline_up_to_limit(self):
        self.transport.handler = offline
        self.source.script = [burst_frames()]
        self.click()
        self.hold(False, 2)
        # first upload attempt happens almost at once and fails -> LED released,
        # then the offline pattern plays; LED must not stay solid on for minutes
        on = self.gpio.on_intervals(LED)[0]
        self.assertLess(on[1] - on[0], 2.0)
        self.assertIsNotNone(on[1])
        self.assertIn("queued_offline", self.fb.played)

    def test_double_press_appends(self):
        self.source.script = [burst_frames(), [img("page2.jpg")] * 4]
        self.click()
        self.hold(False, 1)
        self.double()
        self.hold(False, 2)
        self.assertEqual(self.events, ["single", "double"])
        self.assertEqual(self.transport.meta_of("job2")["appendTo"], "job1")

    def test_long_press_is_clip_mode(self):
        self.source.script = [burst_frames() * 3]
        self.long()
        self.hold(False, 2)
        self.assertEqual(self.events, ["long"])
        self.assertEqual(self.source.calls[0][0], "clip")
        _, secs, w, h, cand = self.source.calls[0]
        self.assertEqual((secs, cand), (2.0, 12))
        self.assertLessEqual(w, 1920)
        meta = self.transport.meta_of("job1")
        self.assertEqual(meta["mode"], "clip")
        self.assertLessEqual(len(meta["frames"]), 3)

    def test_long_press_burst_mode_from_config(self):
        self.transport.config_body = {"longPressMode": "burst"}
        self.up.fetch_config_now()
        self.source.script = [burst_frames() * 2]
        self.long()
        self.hold(False, 2)
        self.assertEqual(self.source.calls[0][:2], ("burst", 8))
        self.assertEqual(self.transport.meta_of("job1")["mode"], "burst")

    def test_long_press_release_does_not_capture_again(self):
        self.source.script = [burst_frames()]
        self.hold(True, 3.0)  # user keeps holding long after the clip started
        self.hold(False, 2)
        self.assertEqual(len(self.source.calls), 1)

    def test_single_mode_from_config(self):
        self.transport.config_body = {"defaultMode": "single"}
        self.up.fetch_config_now()
        self.source.script = [[img("clean.jpg")]]
        self.click()
        self.hold(False, 2)
        self.assertEqual(self.source.calls[0][:2], ("burst", 1))
        meta = self.transport.meta_of("job1")
        self.assertEqual(meta["mode"], "single")
        self.assertEqual(len(meta["frames"]), 1)

    def test_presses_during_capture_are_not_queued(self):
        self.source.script = [burst_frames(), burst_frames()]
        self.click()
        self.hold(False, 2)
        self.assertEqual(len(self.source.calls), 1)

    def test_battery_in_meta(self):
        self.ctl.battery = lambda: 57
        self.source.script = [burst_frames()]
        self.click()
        self.hold(False, 2)
        self.assertEqual(self.transport.meta_of("job1")["battery"], 57)


class HardConditions(Rig):
    def test_all_blurry_triggers_one_auto_retry_and_pools(self):
        self.source.script = [
            [img("blur.jpg"), img("burst/frame0.jpg"), img("burst/frame3.jpg"), img("blur.jpg")],
            [img("burst/frame2.jpg"), img("blur.jpg"), img("burst/frame1.jpg"), img("blur.jpg")],
        ]
        self.click()
        self.hold(False, 2)
        self.assertEqual(len(self.source.calls), 2)
        self.assertEqual(self.ctl.captures[0]["attempts"], 2)
        self.assertEqual(self.ctl.captures[0]["candidates"], 8)
        self.assertEqual(self.transport.jobs["job1"]["frame0"][1], img("burst/frame1.jpg"))

    def test_all_blurry_frames_are_flagged_in_meta(self):
        self.source.script = [[img("blur.jpg"), img("motion.jpg")], [img("motion.jpg"), img("blur.jpg")]]
        self.click()
        self.hold(False, 2)
        meta = self.transport.meta_of("job1")
        self.assertTrue(meta["frames"])
        self.assertTrue(all(f["issues"] == ["blurry"] for f in meta["frames"]), meta["frames"])

    def test_no_retry_when_one_frame_is_good(self):
        self.source.script = [burst_frames()]
        self.click()
        self.hold(False, 2)
        self.assertEqual(len(self.source.calls), 1)

    def test_auto_retry_can_be_turned_off(self):
        self.transport.config_body = {"autoRetry": False}
        self.up.fetch_config_now()
        self.source.script = [[img("blur.jpg")] * 4]
        self.click()
        self.hold(False, 2)
        self.assertEqual(len(self.source.calls), 1)
        # still uploaded: the server makes the final retake decision
        self.assertEqual(len(self.transport.posts()), 1)

    def test_retake_from_server_reaches_led_and_motor(self):
        self.transport.status_script["job1"] = ["processing", "retake"]
        self.source.script = [[img("glare.jpg")] * 4]
        self.click()
        self.hold(False, 8)
        self.assertIn("retake", self.fb.played)
        self.assertGreaterEqual(len(self.gpio.on_intervals(MOTOR)), 3)  # captured buzz + 2 retake buzzes


class FillLight(Rig):
    fill_light = True

    def test_dark_burst_retries_with_fill_light(self):
        dark = [img("dark-burst/frame%d.jpg" % i) for i in range(3)]
        self.source.script = [dark, [img("clean.jpg")] * 3]
        self.click()
        self.hold(False, 2)
        self.assertEqual(self.source.fill_at_call, [False, True])
        self.assertFalse(self.gpio.outputs[FILL])  # off again after capture
        self.assertEqual(self.transport.jobs["job1"]["frame0"][1], img("clean.jpg"))

    def test_fill_light_off_setting(self):
        self.transport.config_body = {"fillLight": "off"}
        self.up.fetch_config_now()
        self.source.script = [[img("dark.jpg")] * 3, [img("dark.jpg")] * 3]
        self.click()
        self.hold(False, 2)
        self.assertEqual(self.source.fill_at_call, [False, False])

    def test_fill_light_always_on_setting(self):
        self.transport.config_body = {"fillLight": "on"}
        self.up.fetch_config_now()
        self.source.script = [burst_frames()]
        self.click()
        self.hold(False, 2)
        self.assertEqual(self.source.fill_at_call, [True])


class Failures(Rig):
    def test_broken_led_means_no_capture(self):
        self.gpio.fail_writes.add(LED)
        self.source.script = [burst_frames()]
        self.click()
        self.hold(False, 2)
        self.assertEqual(self.source.calls, [])
        self.assertEqual(self.transport.posts(), [])

    def test_camera_error_plays_error_and_frees_led(self):
        self.source.script = [CaptureError("ffmpeg failed")]
        self.click()
        self.hold(False, 3)
        self.assertIn("error", self.fb.played)
        self.assertFalse(self.gpio.outputs[LED])
        self.assertEqual(self.transport.posts(), [])

    def test_queue_full_refuses_press(self):
        self.transport.handler = offline
        self.source.script = [burst_frames()] * 6
        for _ in range(self.settings.max_queue + 1):
            self.click()
            self.hold(False, 0.5, service=False)
        self.assertEqual(self.up.pending(), self.settings.max_queue)
        self.assertIn("queue_full", self.fb.played)
        self.assertEqual(len(self.source.calls), self.settings.max_queue)

    def test_stuck_button(self):
        self.hold(True, 16, service=False)
        self.assertEqual(self.events, ["long"])  # long fires, then capture resets the machine
        self.assertEqual(len(self.source.calls), 1)

    def test_corrupt_frames_still_send_best_effort(self):
        self.source.script = [[b"\xff\xd8broken", img("clean.jpg")]]
        self.click()
        self.hold(False, 2)
        self.assertEqual(len(self.transport.meta_of("job1")["frames"]), 1)
