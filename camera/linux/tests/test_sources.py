"""Capture sources with a fake process runner: command lines, frame extraction,
clip deletion, failure handling. No camera is needed."""

from __future__ import annotations

import os
import subprocess

from evencam.sources import CaptureError, FakeSource, LibcameraSource, V4L2FfmpegSource, make_source
from tests.helpers import TESTDATA, TempDirCase, burst_frames


class FakeRunner:
    """Pretends to be ffmpeg / rpicam. Writes `stream` to the -o/-y path or stdout."""

    def __init__(self, stream=b"", returncode=0, stderr=b"", exc=None):
        self.stream = stream
        self.returncode = returncode
        self.stderr = stderr
        self.exc = exc
        self.cmds = []
        self.files_written = []

    def __call__(self, cmd, **kw):
        self.cmds.append(cmd)
        if self.exc:
            raise self.exc
        out = self.stream
        target = None
        if "-y" in cmd:
            target = cmd[-1]
        elif "-o" in cmd and cmd[cmd.index("-o") + 1] != "-":
            target = cmd[cmd.index("-o") + 1]
        if target:
            with open(target, "wb") as f:
                f.write(self.stream)
            self.files_written.append(target)
            out = b""
        return subprocess.CompletedProcess(cmd, self.returncode, out, self.stderr)


def assert_no_audio(test, cmd):
    joined = " ".join(cmd)
    test.assertNotIn("alsa", joined)
    test.assertNotIn("pulse", joined)
    test.assertNotIn("audio", joined)
    test.assertNotIn("-f alsa", joined)


class V4L2(TempDirCase):
    def src(self, runner, **kw):
        return V4L2FfmpegSource(workdir=os.path.join(self.tmp, "work"), runner=runner, **kw)

    def test_burst_command_and_frames(self):
        r = FakeRunner(b"".join(burst_frames()))
        frames = self.src(r).burst(4, 1.0, 2592, 1944)
        self.assertEqual(frames, burst_frames())
        cmd = r.cmds[0]
        self.assertEqual(cmd[0], "ffmpeg")
        self.assertIn("-an", cmd)
        assert_no_audio(self, cmd)
        self.assertEqual(cmd[cmd.index("-video_size") + 1], "2592x1944")
        self.assertEqual(cmd[cmd.index("-frames:v") + 1], "4")
        self.assertEqual(cmd[cmd.index("-r") + 1], "4.000")
        self.assertEqual(cmd[cmd.index("-i") + 1], "/dev/video0")
        self.assertEqual(cmd[-1], "pipe:1")
        self.assertNotIn("-input_format", cmd)

    def test_burst_trims_extra_frames(self):
        r = FakeRunner(b"".join(burst_frames() * 2))
        self.assertEqual(len(self.src(r).burst(3, 1.0, 640, 480)), 3)

    def test_mjpeg_input_copies_in_clip(self):
        r = FakeRunner(b"".join(burst_frames() * 5))
        s = self.src(r, input_format="mjpeg")
        frames = s.clip(2.0, 1920, 1080, 12)
        self.assertEqual(len(frames), 12)
        cmd = r.cmds[0]
        self.assertEqual(cmd[cmd.index("-c:v") + 1], "copy")
        self.assertEqual(cmd[cmd.index("-input_format") + 1], "mjpeg")
        self.assertEqual(cmd[cmd.index("-t") + 1], "2.00")
        self.assertIn("-an", cmd)

    def test_yuv_input_encodes_clip(self):
        r = FakeRunner(b"".join(burst_frames()))
        self.src(r).clip(2.0, 1280, 720, 12)
        cmd = r.cmds[0]
        self.assertEqual(cmd[cmd.index("-c:v") + 1], "mjpeg")

    def test_clip_file_is_deleted(self):
        r = FakeRunner(b"".join(burst_frames()))
        s = self.src(r)
        s.clip(2.0, 1280, 720, 6)
        self.assertEqual(len(r.files_written), 1)
        self.assertFalse(os.path.exists(r.files_written[0]))
        self.assertEqual(os.listdir(os.path.join(self.tmp, "work")), [])

    def test_clip_file_deleted_even_on_failure(self):
        r = FakeRunner(b"\x00\x01 not a video")
        s = self.src(r)
        with self.assertRaises(CaptureError):
            s.clip(2.0, 1280, 720, 6)
        self.assertEqual(os.listdir(os.path.join(self.tmp, "work")), [])

    def test_ffmpeg_failure(self):
        r = FakeRunner(b"", returncode=1, stderr=b"line1\n/dev/video0: Device or resource busy\n")
        with self.assertRaises(CaptureError) as cm:
            self.src(r).burst(4, 1.0, 640, 480)
        self.assertIn("busy", str(cm.exception))

    def test_ffmpeg_missing_and_timeout(self):
        with self.assertRaises(CaptureError):
            self.src(FakeRunner(exc=FileNotFoundError())).burst(4, 1, 640, 480)
        with self.assertRaises(CaptureError):
            self.src(FakeRunner(exc=subprocess.TimeoutExpired("ffmpeg", 5))).burst(4, 1, 640, 480)

    def test_no_frames(self):
        with self.assertRaises(CaptureError):
            self.src(FakeRunner(b"")).burst(4, 1.0, 640, 480)


class Libcamera(TempDirCase):
    def src(self, runner, **kw):
        return LibcameraSource(vid="rpicam-vid", still="rpicam-still", workdir=os.path.join(self.tmp, "w"),
                               runner=runner, **kw)

    def test_burst_skips_warmup_and_samples(self):
        frames = burst_frames() * 7  # 28 frames: 12 warm-up at 15 fps, 16 usable
        r = FakeRunner(b"".join(frames))
        out = self.src(r).burst(4, 1.0, 2304, 1296)
        self.assertEqual(len(out), 4)
        cmd = r.cmds[0]
        self.assertEqual(cmd[0], "rpicam-vid")
        self.assertIn("-n", cmd)
        self.assertEqual(cmd[cmd.index("--codec") + 1], "mjpeg")
        self.assertEqual(cmd[cmd.index("-t") + 1], "1800")
        self.assertEqual(cmd[cmd.index("--autofocus-mode") + 1], "continuous")
        self.assertEqual(cmd[-2:], ["-o", "-"])
        assert_no_audio(self, cmd)

    def test_single_uses_still_with_autofocus(self):
        r = FakeRunner(burst_frames()[1])
        out = self.src(r).burst(1, 1.0, 4608, 2592)
        self.assertEqual(out, [burst_frames()[1]])
        self.assertEqual(r.cmds[0][0], "rpicam-still")
        self.assertIn("--autofocus-on-capture", r.cmds[0])

    def test_no_autofocus_option(self):
        r = FakeRunner(b"".join(burst_frames() * 7))
        self.src(r, autofocus=False).burst(4, 1.0, 640, 480)
        self.assertNotIn("--autofocus-mode", r.cmds[0])

    def test_clip_written_and_deleted(self):
        r = FakeRunner(b"".join(burst_frames() * 10))
        out = self.src(r).clip(2.0, 1920, 1080, 12)
        self.assertEqual(len(out), 12)
        self.assertFalse(os.path.exists(r.files_written[0]))
        self.assertEqual(os.listdir(os.path.join(self.tmp, "w")), [])


class Fake(TempDirCase):
    def test_folder_cycles(self):
        s = FakeSource(folder=os.path.join(TESTDATA, "burst"))
        self.assertEqual(s.burst(4, 1, 640, 480), burst_frames())
        self.assertEqual(s.burst(2, 1, 640, 480), burst_frames()[:2])

    def test_script_then_error(self):
        s = FakeSource(script=[[b"a"], CaptureError("x")])
        self.assertEqual(s.burst(1, 1, 1, 1), [b"a"])
        with self.assertRaises(CaptureError):
            s.burst(1, 1, 1, 1)
        with self.assertRaises(CaptureError):
            s.burst(1, 1, 1, 1)  # empty folder

    def test_make_source(self):
        self.assertIsInstance(make_source("fake", fake_dir=TESTDATA), FakeSource)
        self.assertIsInstance(make_source("v4l2"), V4L2FfmpegSource)
        with self.assertRaises(ValueError):
            make_source("rtsp")


class LeftoverClips(TempDirCase):
    """A clip left behind by a crash, OOM kill or SIGKILL mid-recording must not
    stay on the device: the next start removes it."""

    def _plant(self, workdir):
        stale = os.path.join(workdir, "clip-crashed")
        os.makedirs(stale)
        with open(os.path.join(stale, "clip.mjpeg"), "wb") as f:
            f.write(b"".join(burst_frames()))
        with open(os.path.join(workdir, "keep.txt"), "w") as f:
            f.write("not a clip")
        return stale

    def test_make_source_removes_leftover_clips(self):
        for kind in ("v4l2", "libcamera"):
            with self.subTest(kind=kind):
                workdir = os.path.join(self.tmp, kind)
                stale = self._plant(workdir)
                make_source(kind, workdir=workdir)
                self.assertFalse(os.path.exists(stale))
                self.assertTrue(os.path.exists(os.path.join(workdir, "keep.txt")))

    def test_missing_workdir_is_fine(self):
        make_source("v4l2", workdir=os.path.join(self.tmp, "does-not-exist"))
