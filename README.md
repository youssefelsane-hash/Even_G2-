# Even G2 Personal Assistant

A hands-free personal assistant for Even Realities G2 smart glasses. Press a button on a small separate camera, and a
short explanation of what it sees appears on the lens. One press takes a quick burst of photos, the camera keeps the
sharpest ones, and the AI reads them together, so one blurred or glary frame does not spoil the answer. If nothing is
readable, the lens and the camera LED say why ("too dark", "blurry", "glare", "page cut off"). Tilt your head to scroll. Shake your head to hide or show
everything. The Android phone is meant to stay locked in your pocket as a bridge.

## Status

**Simulator only. Nothing here has been tested on real glasses, a real phone or a real camera.**

| Part | State |
| --- | --- |
| Glasses app (`app/`) | Prototype. Runs in the official simulator with injected motion and wear |
| Gesture thresholds | Tuned against synthetic motion only. Not validated |
| Backend and AI (`backend/`) | Built. Tested with the mock AI only; the Anthropic provider is type-checked, never called |
| Camera (`camera/`) | Linux client tested with fake GPIO and a fake sensor. ESP32 firmware never compiled. No real board used |
| Whole system (`tools/e2e-system/`) | 15 of 15 scenarios pass on one computer: backend (mock AI), camera client (fakes), app in the simulator |
| Locked-phone use | **Unknown, and the biggest project risk** |

Last checked results, on 2026-11-08: see the table under "Test results" below. These show that the logic does what
the spec says. They say nothing about how real glasses behave. The simulator has no IMU
and no wear events.

The project depends on two facts that no source settles: whether the IMU's x/y/z values carry usable head motion, and
whether samples keep arriving with an Android phone locked. Phase 0 measures both before any further building.

## Camera control

The camera has one physical button. Nothing else can start a capture.

| Press | What happens |
| --- | --- |
| Single | Burst: 4 frames in about 1 s, scored on the camera, the best 1 to 3 sent |
| Long (0.8 s or more) | Linux board: about 2 s of frames scanned locally, best 3 sent, the clip deleted. ESP32: an 8-frame burst |
| Double | Adds a page to the previous question (up to 4 pages, 12 photos in one AI request) |

The LED lights before any capture and cannot be turned off. LED patterns (and an optional vibration motor) report
captured, uploaded, retake needed and error. Settings (mode, number of frames, resolution) come from the backend
and can be changed from the phone panel. Details: [docs/CAPTURE-STRATEGY.md](docs/CAPTURE-STRATEGY.md),
[docs/API.md](docs/API.md).

Which board to buy in Egypt, with prices: [docs/CAMERA-HARDWARE-EGYPT.md](docs/CAMERA-HARDWARE-EGYPT.md).

## Quick start

Requires Node 22.18 or later.

```bash
cd app
npm install
npm run typecheck
npm test            # unit and acceptance tests, no hardware needed
npm run report      # synthetic false-positive and detection figures
npm run build
npm run dev         # phone panel at http://127.0.0.1:5174
npm run sim:e2e     # starts Vite and the simulator, saves screenshots to docs/screenshots, stops both
```

Whole system on one computer (backend, camera client and app together; needs `backend/` and `camera/.venv`
set up first): `node tools/e2e-system/run.mjs`. See [tools/e2e-system/README.md](tools/e2e-system/README.md).

To try it on real glasses, follow the install steps in [docs/HARDWARE-TESTS.md](docs/HARDWARE-TESTS.md). Start with
experiment HT-1.

## Documentation

| Document | What it covers |
| --- | --- |
| [docs/SPEC-V0.3.md](docs/SPEC-V0.3.md) | Current specification, with changes from V0.2. Draft, waiting for owner approval |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components and data flows: capture to lens, Hidden mode, locked phone |
| [docs/HARDWARE-TESTS.md](docs/HARDWARE-TESTS.md) | Ordered checklist for the real glasses and phone, including the raw IMU logger |
| [docs/PLAN.md](docs/PLAN.md) | Phases, go/no-go gates, Study Lens reuse, risks and fallbacks |
| [docs/FEASIBILITY.md](docs/FEASIBILITY.md) | Which requirements the platform can support, and the hardware unknowns |
| [docs/SDK-APIS.md](docs/SDK-APIS.md) | SDK 0.0.16 and platform facts, with sources and known doc conflicts |
| [docs/API.md](docs/API.md) | The HTTP contract between camera, backend and glasses app, matching the code |
| [docs/CAPTURE-STRATEGY.md](docs/CAPTURE-STRATEGY.md) | Burst, clip and multi-page capture, frame scoring, retake rules, AI fusion prompt, cost |
| [docs/CAMERA-HARDWARE-EGYPT.md](docs/CAMERA-HARDWARE-EGYPT.md) | Camera boards you can buy in Egypt, prices, shopping lists, first tests |
| [docs/CAMERA-AND-BACKEND.md](docs/CAMERA-AND-BACKEND.md) | Earlier study: connectivity, locked phone, privacy, German recording rules, Study Lens reuse |
| [app/README.md](app/README.md) | Prototype layout, synthetic results, how each risk is handled in code |

Claims in the docs are labelled VERIFIED (with a source), EXPERIMENT NEEDED or ASSUMPTION.

## Intended use

This is a personal assistant for explanation and study.

- It is **not for exams or tests**, and has no exam mode. Do not use it where aids are not allowed.
- It is **not for covert recording**. The camera captures only on a physical press, with a visible LED that cannot be
  turned off. No video ever leaves the camera or is kept: a long press scans about 2 seconds of frames locally, keeps
  up to 3 photos and deletes the rest. There is no audio, timed capture or remote trigger, and the device must look
  like a camera.
- Hidden mode hides your display. It does not hide the camera from other people.
- Point it at pages, screens and objects, not at people. Respect local rules and other people's privacy.

The legal notes in the docs are an engineer's reading and are not legal advice.

## Secrets

This repository is public. Never commit tokens, `.env` files, device config or IMU logs. `.gitignore` covers the common
cases, but check before every commit.
