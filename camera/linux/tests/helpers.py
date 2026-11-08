from __future__ import annotations

import email.parser
import email.policy
import json
import os
import shutil
import tempfile
import unittest

from evencam.config import LocalSettings
from evencam.transport import Response, Transport, TransportError

HERE = os.path.dirname(os.path.abspath(__file__))
TESTDATA = os.path.normpath(os.path.join(HERE, "..", "..", "testdata"))


def img(name: str) -> bytes:
    with open(os.path.join(TESTDATA, name), "rb") as f:
        return f.read()


def burst_frames() -> list:
    return [img("burst/frame%d.jpg" % i) for i in range(4)]


def make_settings(state_dir: str, **kw) -> LocalSettings:
    base = dict(
        server_url="https://cam.example.test",
        device_token="dev-token-123",
        device_id="cam1",
        camera_source="fake",
        gpio_backend="fake",
        button_pin=2,
        led_pin=3,
        state_dir=state_dir,
    )
    base.update(kw)
    return LocalSettings(**base)


def parse_multipart(content_type: str, body: bytes) -> dict:
    """name -> (content_type, bytes)."""
    raw = b"Content-Type: " + content_type.encode() + b"\r\nMIME-Version: 1.0\r\n\r\n" + body
    msg = email.parser.BytesParser(policy=email.policy.HTTP).parsebytes(raw)
    out = {}
    for part in msg.iter_parts():
        name = part.get_param("name", header="content-disposition")
        out[name] = (part.get_content_type(), part.get_payload(decode=True))
    return out


class FakeTransport(Transport):
    """Scripted server. `handler(method, path, headers, body)` returns Response, or
    raises TransportError. Default handler acts like a healthy backend."""

    def __init__(self, handler=None) -> None:
        self.requests: list = []
        self.handler = handler or self.default
        self.jobs: dict = {}
        self.keys: dict = {}
        self.status_script: dict = {}  # jobId -> list of statuses to return in order
        self.config_body: dict | None = {"defaultMode": "burst", "burstFrames": 4, "keepBest": 3}

    def request(self, method, url, headers, body=None, timeout=20.0):
        path = url.split("://", 1)[1]
        path = path[path.index("/"):]
        self.requests.append((method, path, dict(headers), body))
        return self.handler(method, path, headers, body)

    def default(self, method, path, headers, body):
        if method == "GET" and path == "/v1/camera/config":
            if self.config_body is None:
                return Response(404, b"{}")
            return Response(200, json.dumps(self.config_body).encode())
        if method == "POST" and path == "/v1/captures":
            key = headers["Idempotency-Key"]
            if key in self.keys:
                return Response(200, json.dumps({"jobId": self.keys[key], "status": "queued", "duplicate": True}).encode())
            job = "job%d" % (len(self.jobs) + 1)
            self.keys[key] = job
            self.jobs[job] = parse_multipart(headers["Content-Type"], body)
            return Response(202, json.dumps({"jobId": job, "status": "queued"}).encode())
        if method == "GET" and path.startswith("/v1/captures/"):
            job = path.rsplit("/", 1)[1]
            seq = self.status_script.get(job, ["processing"])
            st = seq.pop(0) if len(seq) > 1 else seq[0]
            body = {"status": st}
            if st == "retake":
                body["retakeReason"] = "blurry"
            return Response(200, json.dumps(body).encode())
        return Response(404, b"{}")

    def posts(self) -> list:
        return [r for r in self.requests if r[0] == "POST"]

    def meta_of(self, job: str) -> dict:
        return json.loads(self.jobs[job]["meta"][1])


def offline(method, path, headers, body):
    raise TransportError("network down")


class TempDirCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="evencam-test-")

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)
