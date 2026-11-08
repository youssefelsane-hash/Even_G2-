"""Real HTTP over a loopback socket: the urllib transport and multipart encoding
against a tiny stand-in server that follows docs/API.md for the camera endpoints."""

from __future__ import annotations

import json
import random
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from evencam.clock import FakeClock
from evencam.transport import TransportError, UrllibTransport
from evencam.uploader import Uploader
from tests.helpers import TempDirCase, burst_frames, make_settings, parse_multipart


class StandIn(BaseHTTPRequestHandler):
    jobs: dict = {}
    keys: dict = {}

    def log_message(self, *a):
        pass

    def _send(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authed(self):
        return self.headers.get("Authorization") == "Bearer dev-token-123" and self.headers.get("X-Device-Id") == "cam1"

    def do_GET(self):
        if not self._authed():
            return self._send(401, {"error": "unauthorized"})
        if self.path == "/v1/camera/config":
            return self._send(200, {"defaultMode": "burst", "burstFrames": 5, "keepBest": 2})
        if self.path.startswith("/v1/captures/"):
            job = self.path.rsplit("/", 1)[1]
            if job not in self.jobs:
                return self._send(404, {"error": "not found"})
            return self._send(200, {"status": "retake", "retakeReason": "glare"})
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._authed():
            return self._send(401, {"error": "unauthorized"})
        body = self.rfile.read(int(self.headers["Content-Length"]))
        key = self.headers["Idempotency-Key"]
        if key in self.keys:
            return self._send(200, {"jobId": self.keys[key], "status": "queued", "duplicate": True})
        parts = parse_multipart(self.headers["Content-Type"], body)
        job = "j%d" % (len(self.jobs) + 1)
        self.keys[key] = job
        self.jobs[job] = parts
        return self._send(202, {"jobId": job, "status": "queued"})


class LoopbackHttp(TempDirCase):
    def setUp(self):
        super().setUp()
        StandIn.jobs, StandIn.keys = {}, {}
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), StandIn)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = "http://127.0.0.1:%d" % self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        super().tearDown()

    def test_full_cycle_over_http(self):
        clock = FakeClock()
        played = []
        s = make_settings(self.tmp, server_url=self.url)
        up = Uploader(s, UrllibTransport(), clock.monotonic, played.append, random.Random(0))
        cfg = up.fetch_config_now()
        self.assertEqual((cfg.burst_frames, cfg.keep_best), (5, 2))
        frames = burst_frames()[1:3]
        meta = {"mode": "burst", "capturedAt": "2026-11-08T10:00:00.000Z",
                "frames": [{"name": "frame%d" % i, "score": 0.9, "width": 640, "height": 480} for i in range(2)]}
        up.enqueue(meta, frames)
        up.service()
        self.assertEqual(list(StandIn.jobs), ["j1"])
        parts = StandIn.jobs["j1"]
        self.assertEqual(json.loads(parts["meta"][1]), meta)
        self.assertEqual(parts["frame0"], ("image/jpeg", frames[0]))
        self.assertEqual(parts["frame1"], ("image/jpeg", frames[1]))
        clock.advance(2.1)
        up.service()
        self.assertEqual(played, ["uploaded", "retake"])

    def test_wrong_token_is_permanent(self):
        clock = FakeClock()
        played = []
        s = make_settings(self.tmp, server_url=self.url, device_token="wrong")
        up = Uploader(s, UrllibTransport(), clock.monotonic, played.append)
        up.enqueue({"mode": "single", "capturedAt": "x", "frames": []}, [burst_frames()[0]])
        up.service()
        self.assertEqual(up.pending(), 0)
        self.assertEqual(played, ["error"])

    def test_connection_refused_is_transport_error(self):
        port = self.server.server_address[1]
        self.server.shutdown()
        self.server.server_close()
        with self.assertRaises(TransportError):
            UrllibTransport().request("GET", "http://127.0.0.1:%d/v1/camera/config" % port, {}, None, timeout=2)
        # restart a server so tearDown can shut it down cleanly
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), StandIn)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
