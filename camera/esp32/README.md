# ESP32 firmware (Seeed XIAO ESP32-S3 Sense)

Ported from the Study Lens firmware to burst mode and the shared button grammar.

**Never compiled with the Arduino toolchain and never flashed.** No toolchain was
installed where this was written. What was checked:

- `logic.h` (button grammar, LED patterns, best-frame choice, backoff, JSON reading) is
  plain C++ and has host tests: `test/run.sh`, 54 checks, with address and undefined
  behaviour sanitizers.
- `even_cam.ino` is type-checked on a PC against stand-in headers in `test/stubs/`. That
  catches C++ mistakes only. It says nothing about the real ESP32 libraries.

## What it does

| Press | Action |
| --- | --- |
| Single | Burst of N frames (config `burstFrames`, default 4) over about 1 s, best K (config `uploadFrames`, at most 3) uploaded |
| Double | Same, with `appendTo` set to the last job id (or `previous`) |
| Long (0.8 s) | Burst of 8 frames (`longBurstFrames`), best K uploaded. No video on the ESP32 |

- The external LED is on 500 ms before the first frame and stays on until the first upload
  attempt ends. No setting changes this.
- Frame choice uses JPEG size as a sharpness proxy: at a fixed quality, a sharp, well-lit
  page compresses less. Dark, blurry and blown-out frames come out smaller. ASSUMPTION;
  EXPERIMENT NEEDED with real pages.
- Photos stay in PSRAM. Up to 3 presses wait for the network, retried with backoff (2 s
  doubling to 60 s) for up to 15 minutes with the same Idempotency-Key.
- After a 202 it polls `GET /v1/captures/:jobId` every 2 s for `statusPollSeconds`
  (default 30) and shows ready, retake or error on the LED.
- Config (`GET /v1/camera/config`) is read at wake and every 5 minutes, and kept in RTC
  memory through deep sleep.
- Deep sleep after 5 minutes idle. The button (GPIO2) wakes it. The press that wakes it
  counts: a quick tap that ends before the CPU starts counts as a single press.
- The microphone is never initialised.

## Build (untested)

1. Arduino IDE or arduino-cli with the esp32 core 3.x. Board "XIAO_ESP32S3", PSRAM "OPI PSRAM".
2. `cp even_cam/config.example.h even_cam/config.h` and fill it in. `config.h` is
   git-ignored: it holds the Wi-Fi password and device token.
3. Wire the button to D1 (GPIO2) and GND, the LED through a transistor to D3 (GPIO4), and
   optionally the motor to D4 (GPIO5). See `../linux/WIRING.md` for the circuits. Pin
   choice is an ASSUMPTION from the Seeed pinout.
4. Flash, open the serial monitor at 115200, press the button.

## Things to check on the real board

- It compiles at all, including `driver/rtc_io.h` and the `esp_camera` field names.
- GPIO2 wakes the board from deep sleep with `ext0`.
- JPEG size ranks real frames the same way a person would (sharp > blurry).
- Upload of 3 frames at 2048x1536 through the phone hotspot takes under 5 s.
- The 0.5 s LED lead time and the wake-up time feel acceptable.
