# Test images

Synthetic 640x480 "photos" of a printed exercise page, made by `generate.py` (Pillow,
fixed seed). They test the pipeline and the on-device scorer. They are not real camera
photos and say nothing about real optics.

| File | Condition | Camera scorer says |
| --- | --- | --- |
| `clean.jpg` | Sharp, even light | no issue |
| `blur.jpg` | Out of focus | blurry |
| `motion.jpg` | Sideways shake | blurry (weak signal) |
| `dark.jpg` | Very dim, with sensor noise | too dark |
| `glare.jpg` | Bright reflection over the middle | glare |
| `cutoff.jpg` | Top of the page outside the frame | no issue: only the AI can tell |
| `page2.jpg` | Second page of the same exercise | no issue |
| `burst/frame0-3.jpg` | Hand-held burst; frame1 is the sharp one | picks frame1, then frame2 |
| `dark-burst/frame0-2.jpg` | Every frame too dark | too dark (triggers the automatic second try) |

Regenerate: `camera/.venv/bin/python -I camera/testdata/generate.py`
