"""Remote config parsing, local settings, sysfs GPIO, LED and motor patterns."""

from __future__ import annotations

import os
import unittest

from evencam.clock import FakeClock, iso_utc
from evencam.config import CameraConfig, SettingsError, parse_camera_config, settings_from_env
from evencam.feedback import PATTERNS, Feedback
from evencam.gpio import FakeGpio, GpioError, SysfsGpio
from tests.helpers import TempDirCase

GOOD_ENV = {
    "SERVER_URL": "https://cam.example.test/",
    "DEVICE_TOKEN": "secret-token-value",
    "DEVICE_ID": "cam1",
    "BUTTON_PIN": "203",
    "LED_PIN": "198",
}


class RemoteConfig(unittest.TestCase):
    def test_defaults(self):
        c = CameraConfig()
        self.assertEqual((c.default_mode, c.burst_frames, c.keep_best), ("burst", 4, 3))

    def test_camel_case(self):
        c = parse_camera_config({"defaultMode": "single", "burstFrames": 6, "keepBest": 2, "resolution": "1920x1080"})
        self.assertEqual((c.default_mode, c.burst_frames, c.keep_best, c.width, c.height), ("single", 6, 2, 1920, 1080))

    def test_nested_and_object_resolution(self):
        c = parse_camera_config({"config": {"n": 5, "k": 1, "resolution": {"width": 1600, "height": 1200}}})
        self.assertEqual((c.burst_frames, c.keep_best, c.width), (5, 1, 1600))

    def test_clamps_and_k_never_above_n_or_3(self):
        c = parse_camera_config({"burstFrames": 99, "keepBest": 10})
        self.assertEqual((c.burst_frames, c.keep_best), (8, 3))
        c = parse_camera_config({"burstFrames": 2, "keepBest": 3})
        self.assertEqual(c.keep_best, 2)
        c = parse_camera_config({"burstFrames": 0})
        self.assertEqual(c.burst_frames, 1)

    def test_bad_values_fall_back(self):
        c = parse_camera_config({"defaultMode": "video", "burstFrames": "4", "keepBest": True,
                                 "resolution": "huge", "fillLight": "strobe", "clipSeconds": float("nan")})
        self.assertEqual(c, CameraConfig())
        self.assertEqual(parse_camera_config(None), CameraConfig())
        self.assertEqual(parse_camera_config([1, 2]), CameraConfig())

    def test_cannot_touch_led_or_trigger(self):
        c = parse_camera_config({"led": False, "ledEnabled": False, "captureNow": True, "interval": 5,
                                 "audio": True, "defaultMode": "clip"})
        self.assertEqual(c, CameraConfig())
        self.assertFalse(hasattr(c, "led"))

    def test_backend_shape(self):
        # Exactly what backend/src/cameraConfig.ts returns.
        body = {"version": 3, "updatedAt": "2026-11-08T10:00:00.000Z", "defaultMode": "burst", "burstFrames": 5,
                "uploadFrames": 2, "longPressMode": "burst", "clipSeconds": 3, "resolution": "2048x1536",
                "jpegQuality": 80, "minUploadScore": 0.2, "statusPollSeconds": 20}
        c = parse_camera_config(body)
        self.assertEqual((c.burst_frames, c.keep_best, c.long_press_mode, c.clip_seconds), (5, 2, "burst", 3.0))
        self.assertEqual((c.width, c.height, c.jpeg_quality, c.min_upload_score, c.status_poll_seconds),
                         (2048, 1536, 80, 0.2, 20))

    def test_clip_seconds_limited(self):
        self.assertEqual(parse_camera_config({"clipSeconds": 60}).clip_seconds, 4.0)


class Settings(unittest.TestCase):
    def test_good(self):
        s = settings_from_env(GOOD_ENV)
        self.assertEqual(s.server_url, "https://cam.example.test")
        self.assertEqual((s.button_pin, s.led_pin, s.motor_pin), (203, 198, None))
        self.assertNotIn("secret-token-value", repr(s))

    def test_rejects(self):
        cases = [
            {"SERVER_URL": ""},
            {"SERVER_URL": "ftp://x"},
            {"SERVER_URL": "http://cam.example.test"},
            {"DEVICE_TOKEN": ""},
            {"DEVICE_TOKEN": "paste-device-token-here"},
            {"DEVICE_ID": "bad id!"},
            {"CAMERA_SOURCE": "rtsp"},
            {"LED_PIN": ""},
            {"BUTTON_PIN": "abc"},
        ]
        for patch in cases:
            env = dict(GOOD_ENV)
            env.update(patch)
            with self.subTest(patch=patch), self.assertRaises(SettingsError):
                settings_from_env(env)

    def test_insecure_http_needs_opt_in(self):
        env = dict(GOOD_ENV, SERVER_URL="http://127.0.0.1:8787", ALLOW_INSECURE_HTTP="1")
        self.assertEqual(settings_from_env(env).server_url, "http://127.0.0.1:8787")

    def test_iso(self):
        self.assertEqual(iso_utc(0.5), "1970-01-01T00:00:00.500Z")


class Sysfs(TempDirCase):
    def make_pin(self, n, value="0"):
        d = os.path.join(self.tmp, "gpio%d" % n)
        os.makedirs(d)
        for name, v in (("value", value), ("direction", "in")):
            with open(os.path.join(d, name), "w") as f:
                f.write(v)

    def read(self, n, name):
        with open(os.path.join(self.tmp, "gpio%d" % n, name)) as f:
            return f.read()

    def test_output_and_input(self):
        open(os.path.join(self.tmp, "export"), "w").close()
        self.make_pin(198)
        self.make_pin(203, "1")
        g = SysfsGpio(self.tmp)
        g.setup_output(198)
        self.assertEqual(self.read(198, "direction"), "low")
        g.write(198, True)
        self.assertEqual(self.read(198, "value"), "1")
        g.setup_input(203, active_low=True)
        self.assertFalse(g.read(203))  # pulled up = released
        with open(os.path.join(self.tmp, "gpio203", "value"), "w") as f:
            f.write("0\n")
        self.assertTrue(g.read(203))  # pulled to ground = pressed

    def test_active_low_output(self):
        open(os.path.join(self.tmp, "export"), "w").close()
        self.make_pin(5)
        g = SysfsGpio(self.tmp)
        g.setup_output(5, active_low=True)
        self.assertEqual(self.read(5, "direction"), "high")  # off at start
        g.write(5, True)
        self.assertEqual(self.read(5, "value"), "0")

    def test_export_writes_pin_number(self):
        open(os.path.join(self.tmp, "export"), "w").close()
        g = SysfsGpio(self.tmp)
        with self.assertRaises(GpioError):
            g.setup_output(77)  # export written but the fake kernel never creates the folder
        with open(os.path.join(self.tmp, "export")) as f:
            self.assertEqual(f.read(), "77")


class Patterns(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.gpio = FakeGpio(self.clock.monotonic)
        self.fb = Feedback(self.gpio, 3, self.clock.monotonic, motor_pin=4, fill_light_pin=5)

    def run_for(self, seconds, step=0.01):
        t_end = self.clock.monotonic() + seconds
        while self.clock.monotonic() < t_end:
            self.clock.advance(step)
            self.fb.tick()

    def durations(self, pin):
        return [round(b - a, 2) for a, b in self.gpio.on_intervals(pin) if b is not None]

    def test_uploaded_two_blinks(self):
        self.fb.play("uploaded")
        self.run_for(1.0)
        self.assertEqual(len(self.durations(3)), 2)
        for d in self.durations(3):
            self.assertAlmostEqual(d, 0.08, delta=0.011)

    def test_retake_led_and_motor(self):
        self.fb.play("retake")
        self.run_for(2.0)
        self.assertEqual(len(self.durations(3)), 5)
        self.assertEqual(len(self.durations(4)), 2)

    def test_patterns_queue_in_order(self):
        self.fb.play("uploaded")
        self.fb.play("ready")
        self.run_for(2.0)
        d = self.durations(3)
        self.assertEqual(len(d), 3)
        self.assertAlmostEqual(d[2], 0.6, delta=0.011)
        self.assertTrue(self.fb.idle)

    def test_busy_is_solid_and_overrides_patterns(self):
        self.fb.busy_on()
        self.fb.play("uploaded")
        self.run_for(1.0)
        self.assertTrue(self.gpio.outputs[3])
        self.assertEqual(len(self.gpio.on_intervals(3)), 1)
        self.fb.busy_off()
        self.assertFalse(self.gpio.outputs[3])

    def test_busy_nesting(self):
        self.fb.busy_on()
        self.fb.busy_on()
        self.fb.busy_off()
        self.assertTrue(self.gpio.outputs[3])
        self.fb.busy_off()
        self.assertFalse(self.gpio.outputs[3])

    def test_led_failure_raises_on_busy(self):
        self.gpio.fail_writes.add(3)
        with self.assertRaises(GpioError):
            self.fb.busy_on()
        self.fb.tick()  # never raises

    def test_all_patterns_finish(self):
        for name in PATTERNS:
            self.fb.play(name)
        self.run_for(20.0, step=0.02)
        self.assertTrue(self.fb.idle)
        self.assertFalse(self.gpio.outputs[3])
        self.assertFalse(self.gpio.outputs[4])

    def test_all_off(self):
        self.fb.busy_on()
        self.fb.fill_light(True)
        self.fb.all_off()
        self.assertEqual(set(self.gpio.outputs.values()), {False})


if __name__ == "__main__":
    unittest.main()
