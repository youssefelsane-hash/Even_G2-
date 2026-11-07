# G2 Assistant: simulator prototype

Hands-free assistant app for Even Realities G2 glasses. This prototype covers the gesture engine, the
Visible/Hidden state machine, content paging, calibration and a raw IMU logger. **It has never run on real
glasses, and its gesture thresholds are not hardware-validated.** The camera and AI backend are not part of
it: a fake answer is injected instead.

Claims below are labelled **VERIFIED** (with the source), **EXPERIMENT NEEDED** or **ASSUMPTION**.

## Commands

```bash
npm install
npm run typecheck
npm test            # unit and acceptance tests, no hardware needed
npm run report      # synthetic false-positive and detection figures
npm run build
npm run sim:e2e     # starts Vite and the real simulator, screenshots to ../docs/screenshots, stops both
npm run dev         # panel at http://127.0.0.1:5174
```

Requires Node 22.18 or later, which runs TypeScript directly.

## Layout

| Path | Purpose |
|---|---|
| `src/core/imuAdapter.ts` | Raw `{x,y,z,t}` to pitch/yaw signals. Mapping, sign, scale and mode are settings |
| `src/core/shakeDetector.ts`, `gestureEngine.ts` | Shake and tilt recognition |
| `src/core/stateMachine.ts` | Spec states and transitions, as a pure reducer |
| `src/core/paging.ts` | App-managed lines and scroll position for 576x288 |
| `src/core/renderQueue.ts` | Serial display updates. Only the newest plan is kept, so a hide never queues behind older updates |
| `src/core/bridgeLane.ts` | Runs every bridge call one at a time with a 2.5 s limit, display calls first |
| `src/core/storage.ts`, `settings.ts` | Stored settings and last answer. The Visible/Hidden mode is never stored |
| `src/core/calibration.ts` | Wizard. Finds axis, sign, mode and thresholds from the user's own motion |
| `src/core/imuLogger.ts` | Phase 0 raw logger with CSV and JSON export |
| `src/core/synth.ts`, `scenarios.ts` | Synthetic motion generator and scenarios |
| `src/core/assistant.ts` | Connects the above, with an injected clock and store. No SDK imports |
| `src/main.ts`, `glasses.ts`, `hostEvents.ts` | The thin SDK layer |
| `src/hostLink.ts` | Host events, device status, IMU start and retry, exit handling. Takes a small bridge interface, so it runs in Node tests |
| `src/panel.ts`, `index.html` | Phone-side panel |

## How the risks are handled

**1. Unknown IMU meaning.** The SDK gives `{x,y,z}` with no units, and the pace values are codes, not Hz
(VERIFIED: SDK `dist/index.d.ts`, `device-features` skill). The adapter hardcodes nothing. It supports
orientation-like and rate-like data. Timestamps are arrival time, and the rate is measured from arrivals.
The wizard finds axis, sign and mode from raw samples, and scales values so the user's own tilt equals 22
degree-equivalents, which makes the unit irrelevant (tested with remapped axes, rate data and radians).
If Phase 0 shows accelerometer-only data, a third adapter mode is needed. Gravity gives pitch but not yaw,
so shake would have to be redesigned (EXPERIMENT NEEDED).

**2. WebView suspended when the phone is locked.** Not solvable in this prototype and possibly the biggest
project risk. Nothing here can run if the host stops JavaScript. Three findings make it sharper:
- The plugin docs describe a move to a headless WebView when the app is backgrounded, relying on
  `setBackgroundState`, and that function is not in SDK 0.0.16 (VERIFIED: `background-state` skill, and a
  test asserts it is not exported).
- So a phone lock may reload the app. By the spec that means booting Hidden: content would vanish on every
  lock, with the position kept and a shake bringing it back (ASSUMPTION about the reload; the behaviour on
  reload is tested as AT-10b).
- The logger records wall-clock arrival times, a boot counter, and saves a log tail to phone storage every
  5 seconds, so a Phase 0 lock test can show gaps and restarts afterwards (EXPERIMENT NEEDED).

**3. Notifications bypassing Hidden.** This app sends no notifications and has no network permission. The
rule for the backend: no phone notification fallback while the app may be Hidden, because G2 notification
forwarding could show it on the lens. The Study Lens ntfy fallback must not be carried over as it is.

**4. Native head-up dashboard gesture.** The plugin skills do not mention it, but Even's support pages do: HeadUp
is on by default and wakes a dark display on a head raise (see `docs/SDK-APIS.md`, section 9). Up and down
thresholds are separate settings and tilt can be switched off. Whether tilt-up collides with the firmware needs a
hardware test (EXPERIMENT NEEDED).

**5. Looking down to read.** To scroll, all of these must hold:
1. The head starts from neutral. After any stop, it must return to the dead zone before tilt re-arms.
2. It moves from the dead zone to the threshold within `tiltEntryMaxMs` (250 ms). A slow look down locks tilt.
3. It stays between the threshold and `tiltMaxDeg` (38) for `tiltMinDurationMs` (350 ms). Further down locks tilt.
4. There is no yaw motion that could be a shake or a glance.

One tilt scrolls for at most `tiltMaxHoldMs` (6 s), so staying down cannot keep scrolling.

Remaining gap: a fast look down of 18 to 38 degrees that stays there does scroll, for up to 18 lines at the
default speed. The position stays clamped and nothing is lost. Tilt can also be switched off in settings.
Real reading posture is unmeasured (EXPERIMENT NEEDED).

**6. Scrolling.** The SDK has no call to read or set a firmware text scroll position (VERIFIED: `index.d.ts`;
`textContainerUpgrade` only replaces text). So the app sends exactly one screen of lines, at most 10 lines at
the 27 px line height (VERIFIED: `font-measurement` skill), wrapped with the firmware font metrics from
`@evenrealities/pretext`. Position is a line index owned by the app, so restoring it is exact. In the simulator
the restored screen was pixel-identical. Text never overflows, so firmware scrolling should not engage
(EXPERIMENT NEEDED on hardware).

**7. Blank display.** A page needs exactly one event-capture container and text cannot be empty (VERIFIED:
`glasses-ui` skill). The app uses one borderless full-screen text container and blanks it with a single
space: one update, atomic, and 0 lit pixels in the simulator (VERIFIED: `npm run sim:e2e`). Whether the IMU
and touch keep flowing on a blank page on hardware is an EXPERIMENT NEEDED.

**8. Recovery versus "only shake restores".** Shake stays the normal way. For a failed IMU there is a
deliberate fallback: 4 presses within 3 seconds, a double press counting as 2. It works when wear is worn or
unknown. It cannot fire while removed, during the settle time after re-wear, or with presses from before a
removal. `LONG_PRESS_EVENT` exists in the SDK and may be a better choice after hardware tests.

## Wear data: a finding that changes the design

The spec expected `isWearing` could be undefined. In practice **SDK 0.0.16 turns a missing `isWearing` into
`false`** (VERIFIED by running the SDK; `test/hostEvents.test.ts` pins it). So "the host sent nothing" looks
exactly like "removed":
- Partial status updates, such as battery only, might read as removal (EXPERIMENT NEEDED). Result: an
  unwanted hide, which is the safe direction.
- If the host never reports wear, the app stays in REMOVED, and touch recovery is refused by design. The way
  out is a deliberate setting on the phone, "Trust the wear sensor". Turning it off treats the glasses as
  always worn and loses automatic hiding. The panel shows this hint whenever the state is removed.

`undefined` is still handled, for direct calls: Visible goes to Hidden, shake is refused, touch recovery works.

## Exit and stored settings

Exit events 6 and 7 hide the content, so a later foreground event cannot redraw it. Event 7 also removes the
listeners and timers. Event 6 keeps them, unlike the plugin guide, because that guide calls it an unexpected
disconnect and recovery must stay possible (ASSUMPTION).

Corrupt settings fall back to the default on load, or to the current value on an update. Out-of-range numbers are
clamped. Combinations that would make a shake or the press pattern impossible are repaired.

## Decisions to confirm

- **ASSUMPTION:** a result that arrived while hidden replaces the old screen, so the next shake shows the new
  answer from its first line, not the exact previous screen. Only one answer is kept.
- **ASSUMPTION:** the camera job runs independently of the lens, so state is `mode` plus `job`, and
  `flatState` returns the single spec state. Hidden and Removed always win.
- **ASSUMPTION:** a lost connection hides the content and sets wear to unknown, so a shake works again only
  after a fresh wear report.
- If the IMU fails while Visible, a shake cannot hide. The way out is a double press, which opens the exit dialog.
- Gestures wait `wearSettleMs` (1.5 s) after re-wear, because putting glasses on looks like wild motion.

## Tests against the 12 acceptance tests

`test/acceptance.test.ts` runs the full pipeline on synthetic motion with a fake clock. All 361 unit tests pass,
and all 17 simulator checks pass (2026-11-07).

| Test | Status without hardware |
|---|---|
| 1 scroll up, 2 scroll down, 3 hide, 4 show | Logic passes. Real feel and thresholds need hardware |
| 5 accidental activation | Logic passes on synthetic walking, talking and glances. Real motion needs hardware |
| 6 removal, 7 re-wear | Logic passes with injected wear. Real wear events need hardware |
| 8 camera to AI | Display side only, with a fake result. No camera, upload or backend |
| 9 hidden AI result | Logic passes, including across a restart |
| 10 connectivity recovery | Logic passes with injected events. Real Bluetooth loss needs hardware |
| 11 competing gestures | Logic passes |
| 12 locked phone | Cold-start logic only. The test itself cannot run without a real phone and glasses |

## Synthetic results (`npm run report`)

**These do not validate anything on hardware.** The motion models are guesses, and the defaults were chosen
against them, so the zeros at intensity 1.0 are expected. The useful part is where the numbers start to fail.

False fires over 5 hours of each activity (50 Hz, 8 ms jitter, 2% drops). Intensity scales all background motion.

| Intensity | Walking shakes | Walking tilts | Talking shakes | Talking tilts |
|---|---|---|---|---|
| 1.0 | 0 | 0 | 0 | 0 |
| 1.25 | 0 | 0 | 0 | 0 |
| 1.5 | 0 | 0 | 3 | 0 |
| 2.0 | 0 | 0 | 301 | 0 |
| 3.0 | 0 | 0 | 977 | 0 |

Talking is the weak spot: side-to-side head motion of about 13 degrees each way reaches the shake amplitude
limit, so a big conversational "no" can hide the screen. Only amplitude and timing separate it from a shake.

Detection over 300 randomised trials per row, standing still:

| Rate | Conditions | Shake | Tilt up | Tilt down |
|---|---|---|---|---|
| 100, 50, 25, 15 Hz | up to 10 ms jitter, 5% drops, batches of 4 | 100% | 100% | 100% |
| 10 Hz | clean | 98.0% | 100% | 100% |
| 7 Hz | clean | 88.3% | 100% | 100% |
| 5 Hz | clean | 60.3% | 100% | 100% |

Shake while walking: 286 of 300 detected (95.3%) at 50 Hz, never firing twice.

## Simulator limits

VERIFIED by running simulator 0.9.5: `imuControl` returns false and no IMU events arrive, and `getDeviceInfo`
reports a fixed `wearing=true` with no status events (the `test-with-simulator` skill agrees). So motion and
wear in `npm run sim:e2e` are injected inside the app by a development-only autopilot (`?autopilot`), since
the automation API can only send touch input. Touch recovery and swipes in that run use real simulator input.

## Phase 0 on real glasses

Use the "Raw IMU logger" panel. It records exactly what arrives, plus wear, connection and state changes.

1. Start, mark Still, hold 20 s. This gives noise and the real rate.
2. Mark and perform each of tilt up, tilt down, turn left, turn right, shake, 3 times each.
   Check which axis moves, its sign, and whether values stay offset during a hold (angle) or fall back (rate).
3. Repeat at `imuPace` 100, 500 and 1000 to learn what the pace codes do.
4. Walk and talk for 5 minutes each, for real false-positive data.
5. Mark Phone locked, lock the phone for 10 minutes, unlock, and look for gaps, boot count and the earlier-session log.
6. Mark Glasses off and on. Check when `wear` notes appear, and whether any appear with no real change.
7. Repeat 1 and 2 while Hidden, to check that the IMU flows with a blank page.

The shake needs enough samples: synthetic detection fell from 98% at 10 Hz to 60% at 5 Hz.
