"""MJPEG splitting, frame scoring on the synthetic hard-condition images, best-K pick,
and upload preparation."""

from __future__ import annotations

import io
import shutil
import subprocess
import tempfile
import os
import unittest

from PIL import Image

from evencam.mjpeg import sample_evenly, split_mjpeg
from evencam.scoring import FrameScore, common_issue, prepare_upload, score_jpeg, select_best
from tests.helpers import burst_frames, img


def jpeg_with_exif_thumbnail() -> bytes:
    """A JPEG whose APP1 segment holds a complete thumbnail JPEG (its own FFD8..FFD9)."""
    thumb = io.BytesIO()
    Image.new("RGB", (16, 16), (200, 10, 10)).save(thumb, "JPEG")
    payload = b"Exif\x00\x00" + thumb.getvalue()
    app1 = b"\xff\xe1" + (len(payload) + 2).to_bytes(2, "big") + payload
    main = img("clean.jpg")
    return main[:2] + app1 + main[2:]


class Mjpeg(unittest.TestCase):
    def test_split_concatenated(self):
        frames = burst_frames()
        self.assertEqual(split_mjpeg(b"".join(frames)), frames)

    def test_garbage_between_and_truncated_tail(self):
        f = burst_frames()
        stream = b"junk" + f[0] + b"\x00\x01garbage" + f[1] + f[2][: len(f[2]) // 2]
        self.assertEqual(split_mjpeg(stream), [f[0], f[1]])

    def test_exif_thumbnail_does_not_split_frame(self):
        j = jpeg_with_exif_thumbnail()
        out = split_mjpeg(j + j)
        self.assertEqual(len(out), 2)
        self.assertEqual(out[0], j)
        Image.open(io.BytesIO(out[1])).load()

    def test_empty(self):
        self.assertEqual(split_mjpeg(b""), [])
        self.assertEqual(split_mjpeg(b"\xff\xd8\xff"), [])

    def test_sample_evenly(self):
        xs = list(range(10))
        self.assertEqual(sample_evenly(xs, 3), [0, 4, 9])  # round(4.5) is 4 (banker's rounding)
        self.assertEqual(sample_evenly(xs, 1), [5])
        self.assertEqual(sample_evenly(xs, 20), xs)
        self.assertEqual(sample_evenly([], 3), [])
        self.assertEqual(sample_evenly(xs, 0), [])

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg not installed")
    def test_split_real_ffmpeg_mjpeg_output(self):
        """ffmpeg's own -f mjpeg output, the format the V4L2 source reads."""
        d = tempfile.mkdtemp()
        try:
            for i, f in enumerate(burst_frames()):
                with open(os.path.join(d, "in%d.jpg" % i), "wb") as fh:
                    fh.write(f)
            out = subprocess.run(
                ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-framerate", "4",
                 "-i", os.path.join(d, "in%d.jpg"), "-an", "-c:v", "mjpeg", "-q:v", "3", "-f", "mjpeg", "pipe:1"],
                stdout=subprocess.PIPE, check=True, timeout=60,
            ).stdout
        finally:
            shutil.rmtree(d, ignore_errors=True)
        frames = split_mjpeg(out)
        self.assertEqual(len(frames), 4)
        scores = [score_jpeg(f, i) for i, f in enumerate(frames)]
        self.assertEqual(select_best(scores, 1)[0].index, 1)


class Scoring(unittest.TestCase):
    def test_burst_picks_sharp_frame_first(self):
        scores = [score_jpeg(f, i) for i, f in enumerate(burst_frames())]
        best = select_best(scores, 3)
        self.assertEqual(best[0].index, 1)
        self.assertEqual(best[1].index, 2)
        # frames 0 and 3 are far below the sharp one and are not uploaded
        self.assertEqual([s.index for s in best], [1, 2])

    def test_clean_page_has_no_issues(self):
        s = score_jpeg(img("clean.jpg"))
        self.assertEqual(s.issues, [])
        self.assertGreater(s.score, 0.9)
        self.assertEqual((s.width, s.height), (640, 480))

    def test_hard_conditions_detected(self):
        expect = {"blur.jpg": "blurry", "dark.jpg": "too dark", "glare.jpg": "glare", "motion.jpg": "blurry"}
        clean = score_jpeg(img("clean.jpg")).score
        for name, issue in expect.items():
            with self.subTest(name=name):
                s = score_jpeg(img(name))
                self.assertIn(issue, s.issues)
                self.assertLess(s.score, clean * 0.7)

    def test_cut_off_page_is_left_to_the_model(self):
        # The camera cannot tell a cut-off page from a short one. The server says
        # "page cut off" if the model sees it. Documented limit.
        self.assertEqual(score_jpeg(img("cutoff.jpg")).issues, [])

    def test_corrupt_frame_scores_zero(self):
        s = score_jpeg(b"\xff\xd8not a jpeg")
        self.assertEqual(s.score, 0.0)
        self.assertIn("unreadable frame", s.issues)

    def test_score_independent_of_resolution(self):
        big = Image.open(io.BytesIO(img("clean.jpg"))).resize((2560, 1920))
        buf = io.BytesIO()
        big.save(buf, "JPEG", quality=90)
        a, b = score_jpeg(img("clean.jpg")).score, score_jpeg(buf.getvalue()).score
        self.assertGreater(b, 0.5 * a)

    def test_common_issue(self):
        dark = [score_jpeg(img("dark-burst/frame%d.jpg" % i), i) for i in range(3)]
        self.assertEqual(common_issue(dark), "too dark")
        mixed = [score_jpeg(img("dark.jpg"), 0), score_jpeg(img("clean.jpg"), 1)]
        self.assertIsNone(common_issue(mixed))
        self.assertEqual(common_issue([]), "unreadable frame")

    def test_select_best_rules(self):
        mk = lambda i, sc: FrameScore(i, 1, 1, 0, 0, 0, 1, sc, [])  # noqa: E731
        self.assertEqual([s.index for s in select_best([mk(0, 0.2), mk(1, 0.9), mk(2, 0.8), mk(3, 0.85)], 3)], [1, 3, 2])
        self.assertEqual([s.index for s in select_best([mk(0, 0.0), mk(1, 0.0)], 3)], [0])  # never empty
        self.assertEqual(select_best([], 3), [])
        # Relative floor 0.5: a frame at 0.44 of the best is dropped, one at 0.5 is kept.
        self.assertEqual([s.index for s in select_best([mk(0, 0.9), mk(1, 0.4), mk(2, 0.45)], 3)], [0, 2])
        self.assertEqual(len(select_best([mk(i, 0.5) for i in range(8)], 3)), 3)
        self.assertEqual([s.index for s in select_best([mk(0, 0.5), mk(1, 0.5)], 1)], [0])  # ties: earliest


class PrepareUpload(unittest.TestCase):
    def test_small_clean_frame_passes_through(self):
        data = img("clean.jpg")
        out, w, h = prepare_upload(data, 2048, 2_500_000)
        self.assertEqual(out, data)
        self.assertEqual((w, h), (640, 480))

    def test_large_frame_is_resized(self):
        big = Image.open(io.BytesIO(img("clean.jpg"))).resize((2592, 1944))
        buf = io.BytesIO()
        big.save(buf, "JPEG", quality=95)
        out, w, h = prepare_upload(buf.getvalue(), 2048, 2_500_000)
        self.assertEqual((w, h), (2048, 1536))
        self.assertEqual(Image.open(io.BytesIO(out)).size, (2048, 1536))

    def test_default_upload_edge_gives_largest_4_3_size_under_token_limit(self):
        from evencam.config import CameraConfig
        big = Image.open(io.BytesIO(img("clean.jpg"))).resize((2592, 1944))
        buf = io.BytesIO()
        big.save(buf, "JPEG", quality=90)
        _, w, h = prepare_upload(buf.getvalue(), CameraConfig().upload_max_edge, 2_500_000)
        self.assertEqual((w, h), (2208, 1656))
        tiles = -(-w // 28) * -(-h // 28)
        self.assertLessEqual(tiles, 4784)

    def test_byte_limit_is_enforced(self):
        noisy = Image.effect_noise((2000, 1500), 120).convert("RGB")
        buf = io.BytesIO()
        noisy.save(buf, "JPEG", quality=100)
        self.assertGreater(len(buf.getvalue()), 300_000)
        out, _, _ = prepare_upload(buf.getvalue(), 4096, 300_000)
        self.assertLessEqual(len(out), 300_000)

    def test_exif_is_stripped(self):
        j = jpeg_with_exif_thumbnail()
        out, _, _ = prepare_upload(j, 2048, 2_500_000)
        self.assertNotIn(b"Exif", out)


if __name__ == "__main__":
    unittest.main()
