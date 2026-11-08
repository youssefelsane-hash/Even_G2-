"""Offline queue, retries, idempotency, append, status polling, config refresh."""

from __future__ import annotations

import json
import os
import random

from evencam.clock import FakeClock
from evencam.transport import Response, TransportError
from evencam.uploader import BACKOFF_MAX_S, MAX_AGE_S, POLL_FOR_S, QueueFull, Uploader
from tests.helpers import FakeTransport, TempDirCase, img, make_settings, offline

META = {"mode": "burst", "capturedAt": "2026-11-08T10:00:00.000Z",
        "frames": [{"name": "frame0", "score": 0.9, "width": 640, "height": 480}]}


class Base(TempDirCase):
    def setUp(self):
        super().setUp()
        self.clock = FakeClock()
        self.t = FakeTransport()
        self.played = []
        self.settings = make_settings(self.tmp)
        self.up = self.new_uploader()

    def new_uploader(self):
        return Uploader(self.settings, self.t, self.clock.monotonic, self.played.append, random.Random(1))

    def enqueue(self, append=False, frames=None):
        return self.up.enqueue(META, frames or [img("clean.jpg")], append=append)

    def run_service(self, seconds, step=0.25):
        end = self.clock.monotonic() + seconds
        while self.clock.monotonic() < end:
            self.up.service()
            self.clock.advance(step)


class HappyPath(Base):
    def test_upload_format(self):
        key = self.enqueue(frames=[img("burst/frame1.jpg"), img("burst/frame2.jpg")])
        self.up.service()
        self.assertEqual(len(self.t.posts()), 1)
        _, path, headers, _ = self.t.posts()[0]
        self.assertEqual(path, "/v1/captures")
        self.assertEqual(headers["Authorization"], "Bearer dev-token-123")
        self.assertEqual(headers["X-Device-Id"], "cam1")
        self.assertEqual(headers["Idempotency-Key"], key)
        self.assertRegex(key, r"^[A-Za-z0-9_-]{8,64}$")
        parts = self.t.jobs["job1"]
        self.assertEqual(sorted(parts), ["frame0", "frame1", "meta"])
        self.assertEqual(parts["frame0"], ("image/jpeg", img("burst/frame1.jpg")))
        self.assertEqual(parts["meta"][0], "application/json")
        self.assertEqual(self.t.meta_of("job1"), META)
        self.assertEqual(self.played, ["uploaded"])
        self.assertEqual(self.up.pending(), 0)
        self.assertEqual(os.listdir(self.settings.queue_dir), [])  # photos deleted after upload

    def test_config_fetched_first(self):
        self.t.config_body = {"defaultMode": "single", "burstFrames": 6}
        self.up.service()
        self.assertEqual(self.t.requests[0][1], "/v1/camera/config")
        self.assertEqual(self.up.config.default_mode, "single")
        self.assertEqual(self.up.config.burst_frames, 6)
        n = len(self.t.requests)
        self.run_service(10)
        self.assertEqual(len([r for r in self.t.requests[n:] if r[1] == "/v1/camera/config"]), 0)
        self.run_service(300)
        self.assertEqual(len([r for r in self.t.requests[n:] if r[1] == "/v1/camera/config"]), 1)

    def test_config_failure_keeps_defaults_and_retries_soon(self):
        self.t.config_body = None
        self.up.service()
        self.assertFalse(self.up.config_loaded)
        self.assertEqual(self.up.config.burst_frames, 4)
        self.t.config_body = {"burstFrames": 3}
        self.run_service(31)
        self.assertEqual(self.up.config.burst_frames, 3)


class Retry(Base):
    def test_offline_then_online_same_key(self):
        self.t.handler = offline
        key = self.enqueue()
        self.run_service(20)
        attempts = [r for r in self.t.requests if r[0] == "POST"]
        self.assertGreaterEqual(len(attempts), 3)
        self.assertEqual(self.played.count("queued_offline"), 1)
        self.t.handler = self.t.default
        self.run_service(70)
        self.assertEqual(self.up.pending(), 0)
        self.assertEqual(self.t.keys, {key: "job1"})
        keys = {r[2]["Idempotency-Key"] for r in self.t.posts()}
        self.assertEqual(keys, {key})
        self.assertEqual(self.played[-1], "uploaded")

    def test_backoff_grows_and_caps(self):
        self.t.handler = offline
        self.enqueue()
        times = []
        for _ in range(4000):
            before = len(self.t.requests)
            self.up.service()
            if len(self.t.requests) > before and self.t.requests[-1][0] == "POST":
                times.append(self.clock.monotonic())
            self.clock.advance(0.25)
            if len(times) >= 9:
                break
        gaps = [b - a for a, b in zip(times, times[1:])]
        self.assertAlmostEqual(gaps[0], 2.0, delta=0.8)
        self.assertAlmostEqual(gaps[1], 4.0, delta=0.8)
        self.assertTrue(all(g2 >= g1 - 0.6 for g1, g2 in zip(gaps, gaps[1:])))
        self.assertLessEqual(max(gaps), BACKOFF_MAX_S + 0.8)

    def test_server_errors_retry(self):
        codes = [503, 500, 429, 408]

        def h(method, path, headers, body):
            if method == "POST" and codes:
                return Response(codes.pop(0), b"{}")
            return self.t.default(method, path, headers, body)

        self.t.handler = h
        self.enqueue()
        self.run_service(120)
        self.assertEqual(self.up.pending(), 0)
        self.assertEqual(len(self.t.posts()), 5)

    def test_permanent_errors_drop(self):
        for code in (400, 401, 403, 413):
            with self.subTest(code=code):
                self.played.clear()
                self.t.handler = lambda m, p, h, b, c=code: Response(c, b"{}") if m == "POST" else Response(404, b"")
                self.enqueue()
                self.run_service(1)
                self.assertEqual(self.up.pending(), 0)
                self.assertIn("error", self.played)
        self.assertEqual(os.listdir(self.settings.queue_dir), [])

    def test_too_old_is_dropped(self):
        self.t.handler = offline
        self.enqueue()
        self.run_service(MAX_AGE_S + 5, step=1.0)
        self.assertEqual(self.up.pending(), 0)
        self.assertIn("error", self.played)

    def test_queue_full(self):
        self.t.handler = offline
        for _ in range(self.settings.max_queue):
            self.enqueue()
        with self.assertRaises(QueueFull):
            self.enqueue()

    def test_order_preserved(self):
        self.t.handler = offline
        k1 = self.enqueue()
        k2 = self.enqueue()
        self.t.handler = self.t.default
        self.run_service(10)
        self.assertEqual([r[2]["Idempotency-Key"] for r in self.t.posts()], [k1, k2])

    def test_restart_resumes_queue_from_ram_disk(self):
        self.t.handler = offline
        k1 = self.enqueue()
        self.run_service(3)
        # client restarts (not a reboot: /run survives a service restart)
        self.t.handler = self.t.default
        up2 = self.new_uploader()
        self.assertEqual(up2.pending(), 1)
        up2.service()
        self.assertEqual(self.t.posts()[-1][2]["Idempotency-Key"], k1)
        self.assertEqual(up2.pending(), 0)

    def test_corrupt_queue_entry_is_removed_on_start(self):
        os.makedirs(os.path.join(self.settings.queue_dir, "deadbeefdeadbeef"))
        with open(os.path.join(self.settings.queue_dir, "deadbeefdeadbeef", "state.json"), "w") as f:
            f.write("{not json")
        up2 = self.new_uploader()
        self.assertEqual(up2.pending(), 0)
        self.assertEqual(os.listdir(self.settings.queue_dir), [])


class Append(Base):
    def test_double_press_appends_to_previous_job_id(self):
        self.enqueue()
        self.run_service(1)
        self.enqueue(append=True, frames=[img("page2.jpg")])
        self.run_service(1)
        self.assertEqual(self.t.meta_of("job2")["appendTo"], "job1")

    def test_append_while_previous_still_queued(self):
        self.t.handler = offline
        self.enqueue()
        self.enqueue(append=True)
        self.t.handler = self.t.default
        self.run_service(10)
        self.assertNotIn("appendTo", self.t.meta_of("job1"))
        self.assertEqual(self.t.meta_of("job2")["appendTo"], "job1")

    def test_append_without_known_previous_uses_previous(self):
        self.enqueue(append=True)
        self.run_service(1)
        self.assertEqual(self.t.meta_of("job1")["appendTo"], "previous")


class StatusPolling(Base):
    def test_retake_signalled(self):
        self.t.status_script["job1"] = ["processing", "processing", "retake"]
        self.enqueue()
        self.run_service(10)
        self.assertEqual(self.played, ["uploaded", "retake"])
        polls = [r for r in self.t.requests if r[1] == "/v1/captures/job1"]
        self.assertEqual(len(polls), 3)
        self.assertEqual(polls[0][2]["Authorization"], "Bearer dev-token-123")

    def test_ready_and_failed(self):
        self.t.status_script["job1"] = ["ready"]
        self.enqueue()
        self.run_service(5)
        self.t.status_script["job2"] = ["failed"]
        self.enqueue()
        self.run_service(5)
        self.assertEqual(self.played, ["uploaded", "ready", "uploaded", "error"])

    def test_polling_stops_after_30_s(self):
        self.enqueue()
        self.run_service(30 + 20)
        polls = [r for r in self.t.requests if r[1].startswith("/v1/captures/job")]
        self.assertLessEqual(len(polls), 16)
        self.assertGreaterEqual(len(polls), 14)
        self.assertTrue(self.up.idle)

    def test_poll_time_from_config(self):
        self.t.config_body = {"statusPollSeconds": 0}
        self.up.fetch_config_now()
        self.enqueue()
        self.run_service(10)
        self.assertFalse(any(r[1].startswith("/v1/captures/job") for r in self.t.requests))
        self.t.config_body = {"statusPollSeconds": 600}
        self.up.fetch_config_now()
        self.assertEqual(self.up.config.status_poll_seconds, 60)
        self.assertLessEqual(POLL_FOR_S, 60)

    def test_poll_network_errors_are_tolerated(self):
        calls = {"n": 0}

        def h(method, path, headers, body):
            if path.startswith("/v1/captures/job"):
                calls["n"] += 1
                if calls["n"] < 3:
                    raise TransportError("blip")
                return Response(200, json.dumps({"status": "retake", "retakeReason": "too dark"}).encode())
            return self.t.default(method, path, headers, body)

        self.t.handler = h
        self.enqueue()
        self.run_service(10)
        self.assertIn("retake", self.played)

    def test_poll_never_requests_results(self):
        self.enqueue()
        self.run_service(40)
        self.assertFalse(any(r[1].startswith("/v1/results") for r in self.t.requests))

    def test_immediate_terminal_status_in_upload_response(self):
        def h(method, path, headers, body):
            if method == "POST":
                return Response(202, b'{"jobId":"j9","status":"retake"}')
            return self.t.default(method, path, headers, body)

        self.t.handler = h
        self.enqueue()
        self.run_service(5)
        self.assertEqual(self.played, ["uploaded", "retake"])


class BadSuccess(Base):
    """A 2xx that is not the backend's 202 (captive portal on public Wi-Fi, a
    misrouted proxy) must not count as uploaded: the press would be lost."""

    def test_captive_portal_200_keeps_press(self):
        portal = lambda m, p, h, b: Response(200, b"<html>Login to WiFi</html>") if m == "POST" else Response(200, b"<html></html>")
        self.t.handler = portal
        key = self.enqueue()
        self.run_service(5)
        self.assertEqual(self.up.pending(), 1)
        self.assertNotIn("uploaded", self.played)
        posts = len(self.t.posts())
        self.assertLessEqual(posts, 3)  # backoff, not a tight loop
        self.t.handler = self.t.default
        self.run_service(130)
        self.assertEqual(self.up.pending(), 0)
        self.assertIn("uploaded", self.played)
        self.assertEqual(self.t.posts()[-1][2]["Idempotency-Key"], key)

    def test_json_without_job_id_keeps_press(self):
        self.t.handler = lambda m, p, h, b: Response(202, b'{"ok":true}') if m == "POST" else Response(404, b"{}")
        self.enqueue()
        self.run_service(3)
        self.assertEqual(self.up.pending(), 1)
        self.assertNotIn("uploaded", self.played)


class AppendAfterDrop(Base):
    def test_append_to_dropped_press_starts_new_question(self):
        # The first press is refused for good (e.g. 400); a double press meant for it
        # must not be glued onto some older, unrelated question via "previous".
        self.t.handler = lambda m, p, h, b: Response(400, b"{}") if m == "POST" else Response(404, b"{}")
        self.enqueue()
        self.run_service(1)
        self.assertEqual(self.up.pending(), 0)
        self.t.handler = self.t.default
        self.enqueue(append=True, frames=[img("page2.jpg")])
        self.run_service(1)
        self.assertNotIn("appendTo", self.t.meta_of("job1"))
