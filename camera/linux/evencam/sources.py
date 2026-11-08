"""Where frames come from. Every source returns a list of JPEG byte strings.

- FakeSource: reads JPEGs from a folder, or plays scripted frame sets. For tests and
  for running the whole client on a laptop.
- V4L2FfmpegSource: any /dev/videoN camera through ffmpeg. This is the NanoPi Duo2
  path (OV5640 on the sun6i CSI driver, which gives YUV, not MJPEG, per the
  FriendlyElec wiki, so ffmpeg encodes in software). Also works for USB webcams.
- LibcameraSource: Raspberry Pi cameras through rpicam-vid / rpicam-still
  (called libcamera-vid / libcamera-still on older Raspberry Pi OS).

Audio is never opened: every command passes -an or has no audio input at all.
Clip mode writes a short MJPEG file into a private work directory (RAM disk under
/run on the device), splits it into frames, and deletes it in a finally block.
The clip is never uploaded.
"""

from __future__ import annotations

import glob
import os
import shutil
import subprocess
import tempfile
from typing import Callable

from .mjpeg import sample_evenly, split_mjpeg

Runner = Callable[..., "subprocess.CompletedProcess[bytes]"]


class CaptureError(RuntimeError):
    pass


class CaptureSource:
    name = "base"

    def burst(self, n: int, seconds: float, width: int, height: int) -> list:
        """n frames spread over about `seconds`."""
        raise NotImplementedError

    def clip(self, seconds: float, width: int, height: int, max_frames: int) -> list:
        """Record a silent clip locally, return up to max_frames frames, delete the clip."""
        raise NotImplementedError

    def close(self) -> None:
        pass


class FakeSource(CaptureSource):
    """Frames from a folder of JPEGs (sorted, cycled), or from scripted sets.

    `script` is a list of frame lists; each call to burst() or clip() takes the next
    set. When the script runs out, the folder is used. A script entry may also be an
    Exception instance, which is raised, to simulate a camera fault.
    """

    name = "fake"

    def __init__(self, folder: str | None = None, script: list | None = None) -> None:
        self.files: list[str] = []
        if folder:
            self.files = sorted(glob.glob(os.path.join(folder, "*.jpg")) + glob.glob(os.path.join(folder, "*.jpeg")))
        self.script = list(script or [])
        self._pos = 0
        self.calls: list[tuple] = []
        self.clip_files_seen: list[str] = []

    def _from_folder(self, n: int) -> list:
        if not self.files:
            raise CaptureError("fake source has no images")
        out = []
        for _ in range(n):
            with open(self.files[self._pos % len(self.files)], "rb") as f:
                out.append(f.read())
            self._pos += 1
        return out

    def _next(self, n: int) -> list:
        if self.script:
            item = self.script.pop(0)
            if isinstance(item, Exception):
                raise item
            return list(item)
        return self._from_folder(n)

    def burst(self, n: int, seconds: float, width: int, height: int) -> list:
        self.calls.append(("burst", n, seconds, width, height))
        return self._next(n)

    def clip(self, seconds: float, width: int, height: int, max_frames: int) -> list:
        self.calls.append(("clip", seconds, width, height, max_frames))
        frames = self._next(max_frames)
        return sample_evenly(frames, max_frames)


def _run(runner: Runner, cmd: list, timeout: float) -> bytes:
    try:
        proc = runner(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, check=False)
    except FileNotFoundError as e:
        raise CaptureError("%s not installed" % cmd[0]) from e
    except subprocess.TimeoutExpired as e:
        raise CaptureError("%s timed out" % cmd[0]) from e
    if proc.returncode != 0:
        err = (proc.stderr or b"").decode("utf-8", "replace").strip().splitlines()
        raise CaptureError("%s failed: %s" % (cmd[0], err[-1] if err else "exit %d" % proc.returncode))
    return proc.stdout or b""


def purge_stale_clips(workdir: str) -> int:
    """Remove clip folders left by a crash or kill mid-recording. Video must never
    outlive the press that made it. Returns how many were removed."""
    try:
        names = os.listdir(workdir)
    except OSError:
        return 0
    n = 0
    for name in names:
        p = os.path.join(workdir, name)
        if name.startswith("clip-") and os.path.isdir(p) and not os.path.islink(p):
            shutil.rmtree(p, ignore_errors=True)
            n += 1
    return n


class _ClipMixin:
    workdir: str

    def _with_clip_file(self, record: Callable[[str], None], max_frames: int, skip: int = 0) -> list:
        os.makedirs(self.workdir, mode=0o700, exist_ok=True)
        tmpdir = tempfile.mkdtemp(prefix="clip-", dir=self.workdir)
        path = os.path.join(tmpdir, "clip.mjpeg")
        try:
            record(path)
            if not os.path.exists(path):
                raise CaptureError("clip was not written")
            with open(path, "rb") as f:
                frames = split_mjpeg(f.read())
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)
        frames = frames[skip:] if len(frames) > skip else frames
        if not frames:
            raise CaptureError("clip had no frames")
        return sample_evenly(frames, max_frames)


class V4L2FfmpegSource(_ClipMixin, CaptureSource):
    name = "v4l2"

    def __init__(
        self,
        device: str = "/dev/video0",
        input_format: str = "",
        framerate: int = 15,
        warmup_s: float = 0.6,
        jpeg_qscale: int = 3,
        workdir: str = "/run/even-g2-camera/work",
        ffmpeg: str = "ffmpeg",
        runner: Runner = subprocess.run,
    ) -> None:
        self.device = device
        self.input_format = input_format  # "" lets ffmpeg pick; "mjpeg" for most USB webcams
        self.framerate = framerate
        self.warmup_s = warmup_s  # auto exposure and white balance settle after the stream starts
        self.qscale = jpeg_qscale
        self.workdir = workdir
        self.ffmpeg = ffmpeg
        self.runner = runner

    def _input_args(self, width: int, height: int) -> list:
        args = [self.ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-f", "v4l2"]
        if self.input_format:
            args += ["-input_format", self.input_format]
        args += ["-video_size", "%dx%d" % (width, height), "-framerate", str(self.framerate), "-i", self.device, "-an"]
        return args

    def burst_command(self, n: int, seconds: float, width: int, height: int) -> list:
        fps = max(0.5, n / max(0.2, seconds))
        return self._input_args(width, height) + [
            "-ss", "%.2f" % self.warmup_s,
            "-r", "%.3f" % fps,
            "-frames:v", str(n),
            "-c:v", "mjpeg", "-q:v", str(self.qscale),
            "-f", "mjpeg", "pipe:1",
        ]

    def clip_command(self, seconds: float, width: int, height: int, path: str) -> list:
        codec = ["-c:v", "copy"] if self.input_format == "mjpeg" else ["-c:v", "mjpeg", "-q:v", str(self.qscale)]
        return self._input_args(width, height) + [
            "-ss", "%.2f" % self.warmup_s,
            "-t", "%.2f" % seconds,
        ] + codec + ["-f", "mjpeg", "-y", path]

    def burst(self, n: int, seconds: float, width: int, height: int) -> list:
        out = _run(self.runner, self.burst_command(n, seconds, width, height), timeout=seconds + self.warmup_s + 15)
        frames = split_mjpeg(out)
        if not frames:
            raise CaptureError("ffmpeg returned no frames")
        return frames[:n]

    def clip(self, seconds: float, width: int, height: int, max_frames: int) -> list:
        def record(path: str) -> None:
            _run(self.runner, self.clip_command(seconds, width, height, path), timeout=seconds + self.warmup_s + 20)

        return self._with_clip_file(record, max_frames)


class LibcameraSource(_ClipMixin, CaptureSource):
    """Raspberry Pi camera stack. Commands follow the rpicam-apps documentation;
    not run on a Pi yet (EXPERIMENT NEEDED)."""

    name = "libcamera"

    def __init__(
        self,
        vid: str | None = None,
        still: str | None = None,
        framerate: int = 15,
        warmup_s: float = 0.8,
        quality: int = 90,
        autofocus: bool = True,
        workdir: str = "/run/even-g2-camera/work",
        runner: Runner = subprocess.run,
    ) -> None:
        self.vid = vid or (shutil.which("rpicam-vid") and "rpicam-vid") or "libcamera-vid"
        self.still = still or (shutil.which("rpicam-still") and "rpicam-still") or "libcamera-still"
        self.framerate = framerate
        self.warmup_s = warmup_s  # also gives continuous autofocus time to settle
        self.quality = quality
        self.autofocus = autofocus
        self.workdir = workdir
        self.runner = runner

    def _vid_args(self, ms: int, width: int, height: int, out: str) -> list:
        args = [
            self.vid, "-n", "-t", str(ms),
            "--codec", "mjpeg", "-q", str(self.quality),
            "--width", str(width), "--height", str(height),
            "--framerate", str(self.framerate),
        ]
        if self.autofocus:
            args += ["--autofocus-mode", "continuous"]
        return args + ["-o", out]

    def still_command(self, width: int, height: int) -> list:
        args = [
            self.still, "-n", "-t", str(int(self.warmup_s * 1000) + 500),
            "--width", str(width), "--height", str(height),
            "-q", str(self.quality), "-e", "jpg",
        ]
        if self.autofocus:
            args += ["--autofocus-on-capture"]
        return args + ["-o", "-"]

    def _skip(self) -> int:
        return int(round(self.warmup_s * self.framerate))

    def burst(self, n: int, seconds: float, width: int, height: int) -> list:
        if n == 1:
            frames = split_mjpeg(_run(self.runner, self.still_command(width, height), timeout=20))
            if not frames:
                raise CaptureError("rpicam-still returned no image")
            return frames[:1]
        ms = int((self.warmup_s + seconds) * 1000)
        out = _run(self.runner, self._vid_args(ms, width, height, "-"), timeout=ms / 1000.0 + 15)
        frames = split_mjpeg(out)
        frames = frames[self._skip():] if len(frames) > self._skip() else frames
        if not frames:
            raise CaptureError("rpicam-vid returned no frames")
        return sample_evenly(frames, n)

    def clip(self, seconds: float, width: int, height: int, max_frames: int) -> list:
        ms = int((self.warmup_s + seconds) * 1000)

        def record(path: str) -> None:
            _run(self.runner, self._vid_args(ms, width, height, path), timeout=ms / 1000.0 + 20)

        return self._with_clip_file(record, max_frames, skip=self._skip())


def make_source(kind: str, **kw) -> CaptureSource:
    if kind == "fake":
        return FakeSource(folder=kw.get("fake_dir"))
    if kind in ("v4l2", "libcamera"):
        # Only this process records into workdir, so anything left there is from a crash.
        purge_stale_clips(kw.get("workdir", "/run/even-g2-camera/work"))
    if kind == "v4l2":
        return V4L2FfmpegSource(
            device=kw.get("device", "/dev/video0"),
            input_format=kw.get("input_format", ""),
            workdir=kw.get("workdir", "/run/even-g2-camera/work"),
        )
    if kind == "libcamera":
        return LibcameraSource(workdir=kw.get("workdir", "/run/even-g2-camera/work"))
    raise ValueError("unknown CAMERA_SOURCE %r (use v4l2, libcamera or fake)" % kind)
