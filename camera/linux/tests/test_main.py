"""Start the real entry point as a process with fake GPIO and fake camera, then stop
it with SIGTERM. Checks start-up, config errors and a clean shutdown."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time

from tests.helpers import TESTDATA, TempDirCase

RUN = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "run_camera.py")


class EntryPoint(TempDirCase):
    def env(self, **kw):
        e = {
            "PATH": os.environ.get("PATH", ""),
            "SERVER_URL": "http://127.0.0.1:9",  # discard port: nothing listens
            "ALLOW_INSECURE_HTTP": "1",
            "DEVICE_TOKEN": "dev-token-123",
            "DEVICE_ID": "cam1",
            "CAMERA_SOURCE": "fake",
            "FAKE_SOURCE_DIR": os.path.join(TESTDATA, "burst"),
            "GPIO_BACKEND": "fake",
            "STATE_DIR": self.tmp,
        }
        e.update(kw)
        return e

    def test_starts_and_stops_cleanly(self):
        p = subprocess.Popen([sys.executable, "-I", RUN], env=self.env(),
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        try:
            time.sleep(1.5)
            self.assertIsNone(p.poll(), "client exited early")
            p.send_signal(signal.SIGTERM)
            out, _ = p.communicate(timeout=15)
        finally:
            if p.poll() is None:
                p.kill()
                p.wait()
        text = out.decode()
        self.assertEqual(p.returncode, 0, text)
        self.assertIn("ready", text)
        self.assertIn("stopped", text)
        self.assertNotIn("dev-token-123", text)

    def test_bad_config_exits_2(self):
        r = subprocess.run([sys.executable, "-I", RUN], env=self.env(DEVICE_TOKEN=""),
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30)
        self.assertEqual(r.returncode, 2)
        self.assertIn("DEVICE_TOKEN", r.stdout.decode())
