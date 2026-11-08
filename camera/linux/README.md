# Linux camera client (NanoPi Duo2, Raspberry Pi)

Python 3.8 or newer, plus Pillow. Nothing else from outside the OS. **Not run on a real
board yet.**

## Layout

| File | Job |
| --- | --- |
| `evencam/button.py` | Button grammar: single, double, long, stuck; debounce; ignores a button held at start |
| `evencam/gpio.py` | GPIO interface with three backends: `gpiod` (Pi, newer Armbian), `sysfs` (FriendlyCore 4.14), `fake` |
| `evencam/feedback.py` | LED and vibration patterns; the "busy" solid LED that cannot be disabled |
| `evencam/sources.py` | Camera interface: `v4l2` (ffmpeg), `libcamera` (rpicam-vid/still), `fake` (folder of JPEGs) |
| `evencam/mjpeg.py` | Splits a Motion-JPEG stream or clip into frames |
| `evencam/scoring.py` | Sharpness, brightness, glare, motion; best-K choice; resize and strip metadata for upload |
| `evencam/uploader.py` | RAM queue, retry with Idempotency-Key, append, status polling, config refresh |
| `evencam/controller.py` | Turns button events into captures; auto second try; fill light |
| `evencam/config.py` | Local settings from the environment; remote camera config parser |
| `run_camera.py` | Entry point used by systemd |
| `setup.sh` | Installer for FriendlyCore/Armbian on the Duo2 and Raspberry Pi OS |
| `gpio-export.sh` | Root helper run before start: exports sysfs pins to the service user |
| `systemd/even-g2-camera.service` | Service unit, runs as an unprivileged user |
| `camera.env.example` | Settings template. The real file holds the token: never commit it |
| `WIRING.md` | Button, LED, motor, fill light and battery wiring |
| `e2e_backend.py` | Drives the real client code against a running backend |
| `tests/` | Unit tests with a fake clock, fake GPIO, fake camera and fake server |

## Install on the board

```bash
git clone <this repo> && cd Even_G2
sudo camera/linux/setup.sh            # detects Pi or Duo2; --board pi|duo2 to force
sudo nano /etc/even-g2-camera/camera.env   # server URL, device token, device id, pins
sudo systemctl start even-g2-camera
journalctl -u even-g2-camera -f
```

`setup.sh --dry-run --board duo2` prints every step without changing anything.

The device token comes from the backend: `node backend/scripts/make-token.mjs device cam1`.
It is an upload-only token bound to the device id.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `SERVER_URL` | (required) | Backend base URL, https only unless `ALLOW_INSECURE_HTTP=1` |
| `DEVICE_TOKEN`, `DEVICE_ID` | (required) | Upload-only token and the id it is bound to |
| `CAMERA_SOURCE` | `v4l2` | `v4l2`, `libcamera` or `fake` |
| `V4L2_DEVICE`, `V4L2_INPUT_FORMAT` | `/dev/video0`, empty | `mjpeg` for most USB webcams; empty for the Duo2 OV5640 (YUV) |
| `GPIO_BACKEND`, `GPIO_CHIP` | `gpiod`, `/dev/gpiochip0` | `sysfs` on FriendlyCore 4.14 |
| `BUTTON_PIN`, `LED_PIN` | (required) | The client refuses to start without an LED pin |
| `MOTOR_PIN`, `FILL_LIGHT_PIN` | empty | Optional outputs |
| `LED_ACTIVE_LOW` | `0` | `1` if the LED lights when the pin is low |
| `STATE_DIR` | `/run/even-g2-camera` | RAM directory for the queue and clip work files |
| `CA_FILE` | empty | PEM file to pin the server's root CA |
| `BATTERY_FILE` | empty | File holding a 0-100 battery percent, sent with each press |
| `MAX_QUEUE` | `4` | Presses that may wait for the network |

Camera tuning comes from the backend (`GET /v1/camera/config`), not from this file:
`defaultMode`, `burstFrames`, `uploadFrames`, `longPressMode`, `clipSeconds`, `resolution`,
`jpegQuality`, `minUploadScore`, `statusPollSeconds`. The client also understands
`fillLight` (`auto`/`on`/`off`) and `autoRetry` (true/false) if the backend adds them.
Bad values fall back to defaults; unknown keys are ignored.

## What is sent per press

`POST /v1/captures`, multipart: `meta` JSON plus `frame0` to `frame2` (JPEG, at most 2.5 MB
each, longest edge at most 2208 px, metadata stripped).

```json
{"mode":"burst","capturedAt":"2026-11-08T10:00:00.000Z","appendTo":"<jobId or previous>","battery":80,
 "frames":[{"name":"frame0","score":0.93,"width":2048,"height":1536,
            "sharpness":1210.5,"brightness":182.4,"clipped":0.004,"issues":[]}]}
```

`score` is 0 to 1. `sharpness`, `brightness` and `clipped` are optional raw measurements
the backend may use to choose a retake reason. `issues` is the scorer's own verdict for the
frame (`too dark`, `too bright`, `glare`, `blurry`); the backend does not send a flagged frame
to the AI, and answers "retake" when every frame is flagged. `appendTo` only on a double press.

## Tests

```bash
camera/.venv/bin/python -I camera/linux/run_tests.py -v
```

The tests cover button timing edges and randomised contact bounce, every LED pattern, the
sysfs backend against a fake sysfs tree, ffmpeg and rpicam command lines with a fake
process runner, clip deletion even on failure, real ffmpeg MJPEG output (skipped if
ffmpeg is missing), frame scoring on the synthetic hard-condition images, the offline
queue, retry timing, permanent errors, idempotency, appending, restart recovery, status
polling, config parsing, the whole controller with a fake clock, real HTTP over loopback,
and starting and stopping the real entry point.

## Known limits

- The `gpiod` and `sysfs` backends, ffmpeg on `/dev/video0` and the rpicam commands have
  never touched real hardware. EXPERIMENT NEEDED.
- Scoring thresholds come from synthetic images. Retune with real photos (camera README, K7).
- Presses during a capture are ignored, by design: the button starts fresh after each capture.
- If a press fails for good and the next press is a double press, it is added to the
  question before it.
- Python 3.5 (FriendlyCore 16.04) is not supported.
