# Even G2 Personal Assistant

A hands-free personal assistant for Even Realities G2 smart glasses. Press a button on a small separate camera, and a
short explanation of what it sees appears on the lens. Tilt your head to scroll. Shake your head to hide or show
everything. The Android phone is meant to stay locked in your pocket as a bridge.

## Status

**Simulator only. Nothing here has been tested on real glasses, a real phone or a real camera.**

| Part | State |
| --- | --- |
| Glasses app (`app/`) | Prototype. Runs in the official simulator with injected motion and wear |
| Gesture thresholds | Tuned against synthetic motion only. Not validated |
| Backend and AI | Not in this repo yet. Designed in the docs |
| Camera | Not built. Designed in the docs |
| Locked-phone use | **Unknown, and the biggest project risk** |

Last checked results, on 2026-11-07: typecheck clean, 361 of 361 unit tests passing, 17 of 17 simulator checks passing. These
show that the logic does what the spec says. They say nothing about how real glasses behave. The simulator has no IMU
and no wear events.

The project depends on two facts that no source settles: whether the IMU's x/y/z values carry usable head motion, and
whether samples keep arriving with an Android phone locked. Phase 0 measures both before any further building.

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
| [docs/CAMERA-AND-BACKEND.md](docs/CAMERA-AND-BACKEND.md) | Camera choice, connectivity, backend, AI format, privacy, German recording rules |
| [app/README.md](app/README.md) | Prototype layout, synthetic results, how each risk is handled in code |

Claims in the docs are labelled VERIFIED (with a source), EXPERIMENT NEEDED or ASSUMPTION.

## Intended use

This is a personal assistant for explanation and study.

- It is **not for exams or tests**, and has no exam mode. Do not use it where aids are not allowed.
- It is **not for covert recording**. The camera takes single photos only, from a physical press, with a visible LED
  that cannot be turned off. There is no video, audio, timed capture or remote trigger, and the device must look like
  a camera.
- Hidden mode hides your display. It does not hide the camera from other people.
- Point it at pages, screens and objects, not at people. Respect local rules and other people's privacy.

The legal notes in the docs are an engineer's reading and are not legal advice.

## Secrets

This repository is public. Never commit tokens, `.env` files, device config or IMU logs. `.gitignore` covers the common
cases, but check before every commit.
