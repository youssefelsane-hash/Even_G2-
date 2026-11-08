# Camera

The camera is a small separate device with one button and a visible LED. A press takes
pictures of a page, picks the clearest ones, and sends them to the backend. The answer
appears on the glasses. The camera never sees the answer text.

**Nothing in this folder has run on real hardware.** The Linux client runs on a laptop
with fake GPIO and a fake camera, and against the real backend with the mock AI. The
ESP32 firmware has never been compiled with the Arduino toolchain (none was installed);
its logic is tested on a PC and the sketch is type-checked against stand-in headers.

Claim labels: **VERIFIED** (checked, with a source), **EXPERIMENT NEEDED** (only a real
device can settle it), **ASSUMPTION** (reasoning, not confirmed), **ESTIMATE** (an
assumed number).

| Folder | What |
| --- | --- |
| [linux/](linux/README.md) | Python client for NanoPi Duo2 or Raspberry Pi. Main path |
| [esp32/](esp32/README.md) | Arduino firmware for the XIAO ESP32-S3 Sense. Burst only |
| [testdata/](testdata/) | Synthetic page photos with blur, darkness, glare, motion, cut-off; and the script that makes them |
| [../tools/fake-camera.mjs](../tools/fake-camera.mjs) | Uploads test photos exactly like the camera, for backend testing |

## How you control it

One button. No app, no remote, no timer, no microphone.

| Press | What the camera does |
| --- | --- |
| **Single** (short) | Takes 4 pictures over about 1 second, scores each one, sends the best 1 to 3 |
| **Double** (two short presses) | Same, but the pictures are added as another page of the last question |
| **Long** (hold 0.8 s) | Linux: records about 2 seconds of silent video **on the camera only**, pulls the frames out, sends the best 1 to 3, deletes the video. ESP32: takes 8 pictures instead |

The press counts are settings: the phone panel changes them on the backend
(`PUT /v1/camera/config`) and the camera reads them at start and every 5 minutes.
Settings can change how many pictures, how many are sent, resolution, clip length and
whether a single press means 1 picture or a burst. **No setting can switch the LED off,
start a capture, or set a timer.**

What the LED and the optional vibration motor tell you:

| Pattern | Meaning |
| --- | --- |
| Solid on | Taking pictures and sending. On at least 0.5 s before the first picture |
| 2 short blinks | Server has the pictures |
| 1 long blink + short buzz-buzz | Answer is ready on the glasses |
| 5 quick blinks + 2 buzzes | Take it again. The reason is on the lens ("too dark", "blurry", "glare", "page cut off") |
| 5 slow blinks | No network. Pictures kept in memory and sent when the network is back (up to 15 min) |
| 1 very long blink + long buzz | Failed for good (bad token, too old, camera error) |
| 9 very fast blinks | Too many unsent presses waiting. This press was ignored |

The camera asks the server for the job status for 30 s after sending, only to drive the
retake signal. It never downloads answers.

## Working in hard conditions

You asked whether to use video or several photos. Both are built, and they work together:

1. **Several photos are the default.** A press takes 4 photos at full resolution. The
   camera scores each one on the spot: sharpness (blur and shake), brightness, and glare.
   The best 1 to 3 go to the AI **in one request**. The AI reads all of them together,
   uses the clearest parts of each, and says which parts it could not read. If none of
   them is readable, the answer is "retake" with a short reason.
2. **Video is the long press.** It gives many more candidates (12 frames from 2 s),
   which helps when walking or with shaky hands. Video frames are smaller (1080p) than
   photos, so for small print the burst is usually better (ASSUMPTION). The video is
   recorded into memory, frames are extracted, and the file is deleted. It never leaves
   the camera, so it costs no extra data and no extra AI money.
3. **Why not send the video to the AI?** It would cost much more mobile data and AI time,
   video frames are lower resolution than photos, and sending video of people around you
   is a privacy problem. Picking the best frames on the camera gets most of the benefit.

Extra rules that make it hold up in bad conditions:

- **Automatic second try.** If every picture of a press is blurry or too dark, the camera
  takes one more round straight away (LED still on) and picks the best from both rounds.
- **Fill light.** If you wire a small white LED as a fill light, the camera switches it on
  for the second try when the first round was too dark. It can also be set always on or
  off.
- **Bad frames are not sent.** A frame far worse than the best one (under 35 % of its
  score) is left out, because a blurry extra picture can confuse the AI more than it helps.
- **Offline queue.** No network? The press is kept in memory (never on the SD card) and
  sent when the hotspot is back, with the same key so it is never answered twice.
- **Retake signal.** The camera tells you to take it again within seconds, by LED and
  buzz, without looking at the glasses.

What the camera cannot judge: a page that is cut off. Only the AI sees that, so it comes
back as a retake with "page cut off". Thresholds were tuned on synthetic images only; real
thresholds need real photos (EXPERIMENT NEEDED, see "First tests" below).

## Which camera to buy in Egypt

Prices and stock below were read on 2026-11-08 and change often.

### Your choice: NanoPi Duo2 with 5MP camera (Makers Electronics, 4,250 EGP, in stock)

It is a reasonable start and the software supports it. Before you pay, ask the seller
(WhatsApp on the product page) three questions, because the product page does not answer
them [1]:

1. **Is the camera module in the box?** Some shops sell the board and the camera
   separately [2].
2. **Is it the autofocus (AF) version of the OV5640?** This matters most. Reading a page
   at 25 to 40 cm needs the lens focused close. Many fixed-focus modules are focused far
   away, and close text comes out soft (ASSUMPTION). If it is fixed-focus, ask whether the
   lens can be turned to focus closer.
3. **Which system image do they recommend?** The page lists FriendlyCore 16.04 [1]. That
   ships Python 3.5, which is too old for this client (needs 3.8). Use a newer FriendlyCore
   or Armbian image if one supports the camera (EXPERIMENT NEEDED).

Other things to know (all ASSUMPTION or ESTIMATE until tested):

- The Duo2 camera gives raw YUV, not JPEG, and on the 4.14 kernel JPEG is encoded in
  software [3]. At full 5MP a 4-picture burst may take 2 to 4 seconds on the 1.2 GHz
  CPU (ESTIMATE). If too slow, set the resolution to 2048x1536 or 1920x1080 on the phone
  panel.
- No battery circuit. Power it from a small USB power bank (simplest), or a LiPo cell with
  a charger board and a 5 V boost board. See [linux/WIRING.md](linux/WIRING.md).
- It is Linux, so it takes 20 to 40 seconds to boot (ESTIMATE). Leave it on while you use it.
- Size is 55 x 25 mm for the board [3], plus the camera, power and an enclosure.

### Would something else make a real difference?

**Yes, in one case: a Raspberry Pi Zero 2 W with Camera Module 3.** The Camera Module 3 has
real autofocus, better low-light and HDR, and a well-maintained camera stack. For reading
small print at arm's length that is the biggest single improvement available (ASSUMPTION
from the published specs, EXPERIMENT NEEDED against the Duo2). The client already supports
it (`CAMERA_SOURCE=libcamera`).

The catch is buying it in Egypt. Makers Electronics lists the Pi Zero 2 W at 2,150 EGP but
**out of stock** [4]. The Camera Module 3 is not listed there; Ubuy Egypt imports it at
about 2,900 to 3,000 EGP plus shipping [5]. The Zero also needs the short "Zero" camera
cable. So it costs more (about 5,500 to 6,500 EGP, ESTIMATE) and takes more effort.

| Option | Where | Price | Autofocus | Verdict |
| --- | --- | --- | --- | --- |
| NanoPi Duo2 + OV5640 | Makers Electronics, in stock [1] | 4,250 EGP | Unknown, ask | **Buy if the seller confirms the camera is included and AF** |
| Pi Zero 2 W + Camera Module 3 | Zero: Makers, out of stock [4]; Camera: Ubuy import [5] | about 5,500-6,500 EGP | Yes | **Better pictures, harder to buy.** Choose it if the Duo2 camera is fixed-focus |
| ESP32-CAM (OV2640) | Makers, 495 EGP [6] | 495 EGP | No, 2MP | Only for testing the pipeline. Too weak for small print |
| XIAO ESP32-S3 Sense | Not found at Makers | - | OV5640 version has AF | Firmware is in [esp32/](esp32/), but buying it in Egypt was not confirmed |
| Your phone camera | Already have it | 0 | Yes | Best pictures, but not hands-free. Good for testing the AI path |

Cheap additions that help more than a better sensor in some conditions:

- **A small white fill-light LED** next to the lens, with a diffuser (tracing paper). Fixes
  most "too dark" cases. Wire it to `FILL_LIGHT_PIN`.
- **A clip or mount that keeps the page at a fixed distance** (about 30 cm). Fixed distance
  helps a fixed-focus lens a lot.
- **A coin vibration motor** so you feel "retake" without looking.

Sources (read 2026-11-08):
[1] https://makerselectronics.com/product/nanopi-duo2-with-5mp-camera/
[2] https://www.theengineerstore.in/products/5mp-camera-module-for-nanopi-duo2 and https://www.neven7.eu/p/5mp-camera-module-nanopi-duo2
[3] https://wiki.friendlyelec.com/wiki/index.php/NanoPi_Duo2
[4] https://makerselectronics.com/?p=500046
[5] https://www.ubuy.com.eg/en/productde/IL58GWTTG-raspberry-rpi-camera-module-3-black-12mp
[6] makerselectronics.com search for "camera module 3", ESP32-CAM listing

## First tests on real hardware

In this order. Each one is EXPERIMENT NEEDED.

| ID | Test | Pass rule |
| --- | --- | --- |
| K1 | `v4l2-ctl --list-formats-ext -d /dev/video0` on the Duo2; take one picture with ffmpeg | Picture saved at 2592x1944 or the largest offered size |
| K2 | Photograph 10 printed pages at 30 cm. Read them yourself on a laptop | All legible. If not: focus problem, see camera advice |
| K3 | Time a 4-picture burst at 2592x1944 and at 2048x1536 | Under 3 s from press to "uploaded" on the hotspot |
| K4 | Button: 20 singles, 20 doubles, 20 longs | Every one recognised correctly. Adjust timing only if needed |
| K5 | LED seen by another person at 2 m in daylight | Seen every time |
| K6 | 10 pages each: dim room, glossy paper under a lamp, while walking | AI reads 8 of 10, or says retake with the right reason |
| K7 | Record the scores the camera logs for real good and bad pictures | Adjust thresholds in `linux/evencam/scoring.py` |
| K8 | Battery: power bank, presses every 2 minutes | Note hours until it stops |

## Tests that run without hardware

```bash
# once: Python test dependencies (pinned) in a local virtual environment
python3 -I -m venv camera/.venv
camera/.venv/bin/python -I -m pip install -r camera/requirements-dev.txt

camera/.venv/bin/python -I camera/testdata/generate.py     # remake the test images
camera/.venv/bin/python -I camera/linux/run_tests.py        # Linux client tests
camera/esp32/test/run.sh                                    # firmware logic tests + sketch type-check
node --test tools/fake-camera.test.mjs                      # fake camera tool tests
```

With a backend running (mock AI is enough):

```bash
SERVER_URL=http://127.0.0.1:8787 DEVICE_TOKEN=... DEVICE_ID=cam1 BUTTON_PIN=2 LED_PIN=3 \
  camera/.venv/bin/python -I camera/linux/e2e_backend.py
SERVER_URL=http://127.0.0.1:8787 DEVICE_TOKEN=... node tools/fake-camera.mjs --set burst
```

## Privacy and safety

- Pictures only from a physical press. LED on before every capture, through upload. No
  setting turns it off; if the LED pin cannot be driven, the camera refuses to capture.
- No audio is ever recorded. Clip mode is silent and the video never leaves the camera.
- Pictures live in RAM (`/run` on Linux, PSRAM on the ESP32), never on the SD card or flash,
  and are deleted after upload. The backend deletes them when the job ends.
- Not for exams or covert recording. Point it at pages and objects, not at people. The
  device must look like a camera.
