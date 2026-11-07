# Even G2 Personal Assistant: specification V0.3

Date: 2026-11-07. Status: **draft, waiting for owner approval.** Nothing has been tested on real glasses.

The baseline is the owner's original [SPEC-V0.2.md](SPEC-V0.2.md). The table below was first written from a
summary, then compared with the original, which added the AI input scope in section 10 and corrected row 14 and D4.

## How to read this document

Requirements are decisions, so they carry no label. Facts they depend on are labelled:

- **VERIFIED**: read in the cited source, or seen by running the code. It proves what the source says, not
  that the hardware behaves that way.
- **EXPERIMENT NEEDED**: only the real G2 and Android phone can answer it. HT numbers point to
  [HARDWARE-TESTS.md](HARDWARE-TESTS.md).
- **ASSUMPTION**: an inference, a third-party report, or a starting value.

Source keys (DTS, RM, SK/, D/, SUP/, GH#, CN/, SL) are defined in [SDK-APIS.md](SDK-APIS.md). Camera sources
[S1] and up are defined in [CAMERA-AND-BACKEND.md](CAMERA-AND-BACKEND.md).

Where this spec differs from those studies, this spec wins. Five known cases: no phone alert in V1 (the camera study
keeps a fixed-text alert), line offset instead of pages, no re-basing of neutral after a long hold, the press
pattern kept alongside the menu until HT-9, and one stored answer on the phone (the camera study says 20).

## Changes from V0.2 and why

| # | V0.2 | V0.3 | Why |
| --- | --- | --- | --- |
| 1 | Restart must not reveal | The app always starts blank and in HIDDEN. The Visible/Hidden mode is never stored | A saved value can never reveal content. VERIFIED by test and in the simulator (`app/test/acceptance.test.ts`, `npm run sim:e2e`) |
| 2 | Only shake restores; a fallback must exist | Shake is the normal restore. Menu `Show` and a confirmed phone `Show` are deliberate recovery paths | Risk 8. A failed IMU must not trap the app. Section 7 |
| 3 | Tilt down scrolls | Tilt needs a fast start from neutral, a band, a hold limit and a scroll lock | Risk 5. A plain threshold cannot tell reading a page from a command. Section 3.2 |
| 4 | Study Lens notification fallback existed | V1 has no phone notification path at all | Risk 3. Forwarded notifications reach the lens and the plugin cannot stop them. VERIFIED SUP/notifications |
| 5 | No phone setup listed | Required setup: Wear Detection on, HeadUp off or high, Auto Display off, battery Unrestricted | Risk 4 and risk 2. Apps cannot change these settings. VERIFIED by absence in DTS. Section 2 |
| 6 | Continuous scroll | Repeated line steps, about 3 lines a second | Risk 6. No programmatic scroll position exists. VERIFIED D/build/device-apis |
| 7 | Not stated | V1 shows text only on the glasses | One text container means one call hides everything. VERIFIED design, `app/src/glasses.ts` |
| 8 | REMOVED + worn -> HIDDEN, always | Guaranteed only if the plugin was running at removal | Firmware brings active features back on re-wear. VERIFIED SUP/wear, with Translate as the example. A plugin page may behave the same: EXPERIMENT NEEDED (HT-6). Section 8 |
| 9 | Not stated | V1 is a personal Beta build, not a store app | Blank screens break store rules. Local and Private builds die or fail on lock. VERIFIED D/ship/app-submission, D/test/local-testing, D/test/private-testing |
| 10 | Hidden hides "all app content" | Same words, plus a list of what Hidden cannot hide | Dashboard, system menus and other apps' notifications are outside the plugin. Section 8 |
| 11 | Wear is worn or removed | Wear is worn, removed or unknown. A missing value reads as removed | SDK 0.0.16 turns a missing `isWearing` into `false`, in the constructor and in `DeviceStatus.fromJson`. VERIFIED by running the SDK, `app/test/hostEvents.test.ts` |
| 12 | Reconnect must not reveal | Losing the connection also hides content, and wear becomes unknown | Safe default. ASSUMPTION that this is the owner's wish (D3) |
| 13 | Six flat states | Same six names, built from `mode` plus `job` | A camera job runs whatever the lens shows. Hidden and Removed always win |
| 14 | Shake restores the exact screen | True unless a new answer arrived while hidden. Then the new answer shows from its first line | V0.2 section 7 says to queue answers while hidden, but the prototype keeps only the newest one. Owner to decide (D4) |
| 15 | Gesture engine assumed usable IMU data | Engine sits behind an adapter. Axis, sign, scale and mode come from calibration | Risk 1. Units are "still TBD". VERIFIED D/reference/faq |
| 16 | Locked phone was a test | Locked phone is the project gate. If it fails, the owner chooses a reduced product | Risk 2. Sources conflict. Section 12 |
| 17 | ESP32-S3 candidate | XIAO ESP32-S3 Sense. External LED on before capture, no off setting, must look like a camera | CAMERA-AND-BACKEND sections 1, 9, 11 |
| 18 | Not stated | Phone hotspot first, home Wi-Fi second, no native Android app in V1 | A native app cannot draw on the lens or wake the plugin. CAMERA-AND-BACKEND section 5 |
| 19 | "Short answer, details by scrolling" | `short` at most 140 characters, plus `detail`, plus a label computed by the backend. Images deleted when the job ends | CAMERA-AND-BACKEND sections 9, 10 |
| 20 | 12 acceptance tests, no numbers | Same 12, with proposed pass rules and links to hardware tests | Section 13 |

## 1. Purpose and scope

A hands-free personal assistant for Even Realities G2 glasses. The user presses a button on a small
separate camera, the photo goes to an AI backend, and a short explanation appears on the lens. The user
reads details by tilting the head, and hides everything with a head shake. The phone is meant to stay
locked in a pocket as a bridge.

Intended use: personal study and explanation of pages, screens and objects.

Out of scope, and must not be designed: exam or test use, covert recording, video, timed capture, remote
capture, audio recording, identifying people.

Hardware facts:

| Fact | Label |
| --- | --- |
| The user's phone is Android | Given |
| G2 has no camera, and the SDK has no audio output. Plugins have no direct Bluetooth | VERIFIED D/build/device-apis |
| App logic runs on the phone; glasses render and send input | VERIFIED D/get-started/architecture |
| Display is 576 x 288, 4-bit green, at most 10 lines | VERIFIED D/build/display, SK/font-measurement |

## 2. Required setup

The app cannot read or change any of these. VERIFIED by absence in DTS:1219 to 1533. The phone panel must
list them as a checklist.

| Setting | Required value | Reason | Label |
| --- | --- | --- | --- |
| Wear Detection (My Devices) | On | Firmware blanks the display on removal, backing up the app | VERIFIED SUP/wear |
| HeadUp Display (Dashboard) | Off, or angle clearly above the tilt-up threshold | It is on by default and can light the display on a head raise | VERIFIED SUP/dashboard. Collision EXPERIMENT NEEDED (HT-7) |
| Notifications, Auto Display | Off | Otherwise other apps' notifications can draw on the lens during Hidden | VERIFIED SUP/notifications. Overlap EXPERIMENT NEEDED (HT-8) |
| Battery for the Even app | Unrestricted, and locked in recents | May keep the WebView alive | ASSUMPTION SUP/known, G1 article. HT-4 |
| Hotspot | On, auto-off disabled, 2.4 GHz available, Data Saver off | A sleeping camera counts as "no device connected" | VERIFIED [S16] for Pixel phones. Other phones: EXPERIMENT NEEDED (HT-14) |
| Install type | Beta build | The only mode that behaves like a published app when locked | VERIFIED D/test/beta-testing |

## 3. Gestures

Gestures are ignored unless wear is `worn`, and for `wearSettleMs` (1.5 s) after re-wear, because putting
glasses on looks like wild motion.

All thresholds below are starting values chosen against synthetic motion. ASSUMPTION until HT-2, HT-3 and
HT-11 replace them. "Degrees" means degree-equivalents after calibration: the real unit is unknown.

### 3.1 Signal source

- The app calls `imuControl(true, pace)` after the start page exists, and reads
  `event.sysEvent.imuData {x, y, z}`. VERIFIED DTS:1436, DTS:968, SK/device-features.
- Pace values are protocol codes, not Hz. VERIFIED D/build/device-apis.
- Meaning of x/y/z, real rate, and direction of the pace codes are unknown. EXPERIMENT NEEDED (HT-2, HT-3).
- All of these live in settings, behind `imuAdapter`, never in the engine: axis, sign, scale, mode.
- The adapter supports orientation-like and rate-like data today. Accelerometer-only data would need a
  third mode and a new shake design, because gravity gives no yaw. ASSUMPTION about the physics, HT-2
  decides whether it applies.
- A missing axis value is treated as 0, because the SDK omits zero values. VERIFIED SK/handle-input (general rule),
  `app/src/core/imuAdapter.ts`. A report with no axes at all is dropped.
- The IMU is re-armed on foreground, after reconnect, and every 10 s while the sensor is reported lost. It is
  stopped on exit events 6 and 7, not on 5. VERIFIED D/build/contextual-menu, SK/handle-input, `app/src/hostLink.ts`.

### 3.2 Tilt: scroll up and down

Tilt up scrolls up, tilt down scrolls down, repeating while tilted and stopping near neutral. All of these
must hold before scrolling starts:

1. The head starts in the dead zone (`deadZoneDeg` 6). After any stop it must return there to re-arm.
2. It reaches the threshold (`tiltUpDeg` 16, `tiltDownDeg` 18) within `tiltEntryMaxMs` (250 ms). A slow look
   down locks tilt.
3. It stays between the threshold and `tiltMaxDeg` (38) for `tiltMinDurationMs` (350 ms). Further locks tilt.
4. No yaw motion that could be a shake or a glance.

Then:

- Scrolling runs at `scrollLinesPerSec` (3), in whole lines. Upper limit 4 to 5 lines a second. ASSUMPTION
  from about 83 ms per update, CN/even-g2-notes. HT-10 measures it.
- One tilt scrolls for at most `tiltMaxHoldMs` (6 s). Then it stops and locks until the head returns to
  neutral. A pose held down therefore cannot keep scrolling.
- When the limit is reached, the text returns to the line where that tilt began. This covers the known gap:
  a fast look down of 18 to 38 degrees that stays there. Not built yet. HT-11 confirms it helps (D5).
- With nothing to scroll, a tilt has no effect.
- A scroll lock toggle exists in the contextual menu, and `tiltEnabled` exists in phone settings.

**Change from the feasibility proposal S3:** the pose is not adopted as a new neutral after a long hold.
If it were, lifting the head back to level would itself be a fast tilt up and would scroll. Tilt stays
locked until the head is back near neutral. Slow posture change is still followed (`driftTauMs`).

### 3.3 Shake: hide and show

A deliberate left-right shake toggles between VISIBLE and HIDDEN.

- At least `shakeSwings` (3) alternating swings, each `shakeMinAmpDeg` (26) to `shakeMaxAmpDeg` (90) peak to
  peak, within `shakeMaxTotalMs` (1600 ms).
- Pitch must stay small compared with yaw.
- `shakeCooldownMs` (1200 ms) stops one shake firing twice.
- Shake has priority over tilt. Tilt pauses while a shake may be forming.

Known weak points (all synthetic, not hardware-validated, VERIFIED only as output of `npm run report`):

| Finding | Result |
| --- | --- |
| Detection falls with sample rate | 100% at 15 Hz and above, 98.0% at 10 Hz, 88.3% at 7 Hz, 60.3% at 5 Hz |
| Talking false fires | 0 in 5 hours at intensity 1.0, rising to 301 at 2.0. A large conversational "no" of about 13 degrees each way can hide the screen |
| Shake while walking | 286 of 300 detected, never fired twice |
| Quick left-right look | A short pause at each side can fire a shake: 4 of 12 cases at 100 ms or less, 2 of 12 at 150 ms, 0 at 200 ms. From the adversarial review, not from `npm run report`. Lowering `shakeMaxDwellMs` from 180 to 120 removes the 150 ms case, but cost detection at 7 Hz (91 to 86 of 100). Decide after HT-3 and HT-11 |

Minimum sample rate for shake: 10 per second. ASSUMPTION from the table above. One report suggests P100 gives
about 10 per second. ASSUMPTION CN/zenn. HT-3 measures it.

### 3.4 Removal and re-wear

- Glasses removed: content is hidden automatically (state REMOVED).
- Glasses put back on: state becomes HIDDEN and stays there until a restore action.
- Wear comes from `onDeviceStatusChanged` and `getDeviceInfo`. VERIFIED DTS:1483, DTS:1344.
- `isInCase` counts as removed. The simulator gives no wear events. VERIFIED SK/test-with-simulator.
- SDK 0.0.16 converts a missing `isWearing` to `false`, so "no report" looks like "removed". VERIFIED by
  running the SDK. A battery-only status update might therefore hide the screen. That is the safe direction,
  but HT-5 must measure how often it happens.
- If the host never reports wear, the app would stay in REMOVED. The exit is the phone setting "Trust the wear
  sensor". Turning it off treats the glasses as always worn and stops automatic hiding. It must say so.

## 4. States and transitions

Internally there are two fields. `mode` is what the lens may show. `job` is the camera and AI work. The
six spec states are a view of those two: if `mode` is not VISIBLE, or `job` is idle, the state is `mode`.
Otherwise it is `job`.

| Field | Values |
| --- | --- |
| `mode` | VISIBLE, HIDDEN, REMOVED |
| `job` | IDLE, PROCESSING, RESULT_READY, ERROR |
| `wear` | worn, removed, unknown |
| `unseen` | True when a result or error arrived while nothing could be shown |

| From | Event | Condition | To | Lens | Built |
| --- | --- | --- | --- | --- | --- |
| Any start | Boot | None | HIDDEN | Blank | Yes |
| VISIBLE | Shake | Worn | HIDDEN | Blank | Yes |
| HIDDEN | Shake | Worn | VISIBLE | Stored screen, or new answer | Yes |
| HIDDEN | Menu `Show` | Wear not removed | VISIBLE | As above | No |
| HIDDEN | Press pattern | Wear not removed, past settle time | VISIBLE | As above | Yes |
| HIDDEN | Phone `Show`, confirmed | Wear not removed | VISIBLE | As above | No |
| VISIBLE | Menu `Hide` | None | HIDDEN | Blank | No |
| VISIBLE or HIDDEN | Removed | None | REMOVED | Blank | Yes |
| REMOVED | Worn | None | HIDDEN | Blank | Yes |
| REMOVED | Shake, touch, tilt | None | REMOVED | Blank | Yes |
| VISIBLE | Wear unknown | None | HIDDEN | Blank | Yes |
| VISIBLE | Connection lost | None | HIDDEN, wear unknown | Blank if it can be sent | Yes |
| VISIBLE | Exit event 6 or 7 | None | HIDDEN | Blank if it can be sent | Yes |
| Any | Reconnect | None | Unchanged | Current plan re-sent | Yes |
| HIDDEN | Tilt or swipe | None | HIDDEN (ignored) | Blank | Yes |
| VISIBLE | Tilt | Worn, not locked | VISIBLE | Scrolls | Yes |
| VISIBLE | Swipe | None | VISIBLE | Moves one screen less one line | Yes |
| Any | AI started | None | `job` PROCESSING | Status line only if VISIBLE | Yes |
| HIDDEN or REMOVED | AI result or error | None | `unseen` true. A result is stored. An error is kept in memory only, so it is lost on restart | Blank | Yes |
| VISIBLE | AI result | None | RESULT_READY | Answer from line 1 | Yes |
| VISIBLE | AI error | None | ERROR | Error text | Yes |
| RESULT_READY | Press or scroll | Visible | VISIBLE | Answer stays | Yes |
| ERROR | Press | Visible | VISIBLE | Answer stays | Yes |

"Built" refers to the simulator prototype in `app/`. The state logic is pure and tested. VERIFIED
`app/test/stateMachine.test.ts`.

Rules that apply everywhere:

- **Never reveal after reconnect or restart.** Only shake, menu `Show`, the press pattern or phone `Show` can
  move the app to VISIBLE.
- **One decision point.** `plan()` in `app/src/core/assistant.ts` is the only place that decides what the lens
  shows. If `mode` is not VISIBLE, the answer is always blank.
- **The phone panel never shows answer text.** VERIFIED `app/src/core/assistant.ts`, `Snapshot`.

## 5. Display and scrolling

- Blank page: one borderless full-screen text container with `isEventCapture: 1` and `content: ' '`.
  VERIFIED SK/glasses-ui, D/build/display. `textColor: 0` is not off, so it is not used. VERIFIED D/build/display.
- Hide and show use `textContainerUpgrade`, one call, no rebuild flicker. 0 lit pixels in the simulator.
  VERIFIED `npm run sim:e2e`. Real lens EXPERIMENT NEEDED (HT-1).
- Whether a blank page keeps the IMU and touch flowing: EXPERIMENT NEEDED (HT-1). If not, the fallback is a
  minimal dim marker on the "blank" page, or restoring by menu only.
- Scrolling is app-managed. Firmware scroll position cannot be read or set. VERIFIED D/build/device-apis, GH#45.
- The app wraps text with `@evenrealities/pretext`, owns a line offset, and sends only the lines that fit, so
  text never overflows. Firmware scrolling should therefore not engage. EXPERIMENT NEEDED (HT-10).
- Restoring position is re-sending the stored window. Pixel-identical in the simulator. VERIFIED `npm run sim:e2e`.
- Screen: a header line (label, line range, `! sensor lost`) plus up to 9 lines of content.
- A non-overflowing container may not emit swipe events. EXPERIMENT NEEDED (HT-10). If it does not, the
  contextual menu gets `Page up` and `Page down` items. A real simulator swipe did scroll. VERIFIED
  `npm run sim:e2e`, but the simulator does not settle it.
- All bridge calls run one at a time, each with a 2.5 s limit, display calls first. Only the newest display plan
  is kept, so a hide never queues behind older updates. It can still wait up to about 2.5 s for one hung call in
  flight. VERIFIED SK/glasses-ui for the rule, `app/src/core/bridgeLane.ts`, `app/src/core/renderQueue.ts`.
- There is no audio cue. VERIFIED D/build/device-apis. HIDDEN has no cue at all.

## 6. Calibration

All values are stored settings, changed on the phone page with no code change. Stored with `setLocalStorage`.
VERIFIED DTS:1358. Corrupt values fall back to the default on load, or to the current value on an update.
Out-of-range numbers are clamped to the range. Combinations that would make a shake or the press pattern impossible
are repaired. VERIFIED `app/src/core/settings.ts`, `app/test/storage.test.ts`, `app/test/adversarial.test.ts`.

| V0.2 item | Setting | Built |
| --- | --- | --- |
| Neutral pose | `neutralPitch`, plus automatic capture when still | Yes |
| Up and down thresholds | `tiltUpDeg`, `tiltDownDeg`, `tiltMaxDeg`, `deadZoneDeg` | Yes |
| Shake sensitivity | `shakeSensitivity`, wizard sets amplitude and rate | Yes |
| Smoothing | `smoothingMs` | Yes |
| Cooldown | `shakeCooldownMs`, `tiltCooldownMs` | Yes |
| Scroll speed | `scrollLinesPerSec` | Yes |
| Minimum gesture duration | `tiltMinDurationMs` | Yes |
| New: axis mapping | `imuMode`, `pitchAxis`, `yawAxis`, signs, `imuScale` | Yes |
| New: IMU pace | `imuPace` | Yes |

The calibration wizard asks for still, tilt up, tilt down and shake, works out axis, sign, mode and thresholds
from raw samples, and proposes them. Nothing changes until the user accepts. The user's own tilt is defined as
22 degree-equivalents, which makes the raw unit irrelevant. VERIFIED `app/test/calibration.test.ts`, on
synthetic data with remapped axes, rate data and radians.

Settings can be changed only with the phone in hand. That is acceptable: calibration is a setup task.

## 7. Recovery

A sensor failure must never trap the app in Hidden, and a recovery must never fire by accident or off the head.

| Path | How | Needs | Status |
| --- | --- | --- | --- |
| Shake | Normal restore | IMU | Built |
| Menu `Show` | Tap, long press, select item. Neutral item name. The OS holds the menu without waking the WebView. VERIFIED D/build/contextual-menu | Whether a click reaches a suspended plugin: EXPERIMENT NEEDED (HT-9) | **Not built** |
| Press pattern | 4 presses in 3 s, a double press counts as 2 | Touch events on the blank page (HT-1) | Built. Removed if the menu passes HT-9 |
| Phone `Show` | Button on the plugin page with a confirm step | Phone unlocked | **Not built** |
| Trust-wear off | Phone setting for a wear sensor stuck on removed. Two deliberate steps: turn it off, then `Show` | Phone unlocked | Built (setting only) |
| Relaunch | Close the plugin and start again. It starts blank, then use any path above | Phone or glasses menu | Available |

Rules:

- Touch swipes never restore.
- On-glasses recovery requires wear not `removed`. It is also dead off the head with Wear Detection on.
  VERIFIED SUP/wear.
- The menu must be re-sent on every `rebuildPageContainer`, because omitting `menuObject` clears it.
  VERIFIED D/build/page-lifecycle.
- Opening the menu lights the display with system UI, even in Hidden. Accepted, because the user asked for it.

Hiding when the IMU has failed while VISIBLE, in order: menu `Hide`, the system `Display off` slot, Silent Mode
(hold both touchpads about 1 second, needs no WebView. ASSUMPTION for that last part, VERIFIED SUP/silent for the
gesture), double press for the exit dialog.

## 8. What Hidden does and does not guarantee

Hidden guarantees: **while the plugin is running, this app draws nothing, stores what arrives, and reveals
only on a restore action.**

Hidden cannot stop the following:

| Case | Status | Mitigation |
| --- | --- | --- |
| Other apps' forwarded notifications | VERIFIED SUP/notifications. No SDK control | Auto Display off. HT-8 |
| HeadUp Dashboard on a head raise while the lens is dark | VERIFIED SUP/dashboard for display off. Whether a blank page counts as off: EXPERIMENT NEEDED (HT-7) | HeadUp off |
| System menus the user opens | VERIFIED D/build/contextual-menu | Accepted |
| Plugin frozen while content was showing: the old page stays, and a shake does nothing | EXPERIMENT NEEDED (HT-4) | Silent Mode, Display off |
| Plugin frozen at removal: firmware may bring the old page back on re-wear, because active features reappear | VERIFIED SUP/wear for active features, with Translate as the example. Plugin pages and the frozen case: EXPERIMENT NEEDED (HT-6) | Hide before taking the glasses off. Silent Mode |

The last row is a likely limit of V0.2's "re-wear stays hidden". It holds only if the blank reached the glasses
first.

Hidden does not hide the camera from other people. Capture during Hidden still lights the LED.

## 9. Camera

Design from [CAMERA-AND-BACKEND.md](CAMERA-AND-BACKEND.md). Nothing is built or flashed. VERIFIED [S1] for Study
Lens firmware being unflashed.

- Seeed XIAO ESP32-S3 Sense, 300 to 500 mAh LiPo, external LED, shutter button, power switch. About
  45 x 32 x 22 mm and EUR 30 to 80. ASSUMPTION (estimates).
- Deep sleep with a 5-minute stay-awake window. About 1.3 to 4 days at 20 captures a day, depending on how
  many stay-awake windows run, against 4 to 7 hours always on. ASSUMPTION, computed from VERIFIED Seeed figures [S2].
- A photo is taken only by a physical press on the camera. No remote, timed or glasses trigger.
- **Capture indication:** an outward-facing LED lights at least 500 ms before capture and stays on through
  upload. No setting, build flag or remote command can disable it. It must be visible at 2 m in daylight (HT-16).
- It must look like a camera: visible lens, no watch shape, no disguise. § 8 TDDDG bans disguised recording
  devices. VERIFIED [S30] for the text. Application to this device is ASSUMPTION, and this is not legal advice.
- No video and no microphone. Firmware never initialises the Sense microphone.
- Images live in PSRAM only, never on flash or SD.
- Connectivity: phone hotspot first, home Wi-Fi second. No native Android app in V1. Build a BLE foreground
  service only if the hotspot fails HT-14. LTE is rejected for V1 on size and power.
- LED patterns report: capturing, uploaded, failed, and "uploaded, glasses app not listening".

## 10. Backend and AI

The AI must handle technical questions and document analysis, printed and handwritten text, and diagrams.
Answers start in English, with more languages configurable later. How well each of these works has not been
measured. HT-15 and the Phase 2 gate must cover handwriting and diagrams, not only printed pages.

Reuse most of Study Lens, with the changes in [PLAN.md](PLAN.md). Never run with real hardware. VERIFIED [S1].

- Upload: HTTPS, device token bound to the device ID, idempotency key reserved before the image is written,
  rate limit.
- The upload response carries `glassesListening`, so the camera can show its LED pattern. This replaces any
  phone notification.
- Delivery: the plugin long-polls and is the only path to the lens. Results wait on the server until fetched.
- Acks are split: `receivedAt` (stored by the plugin) and `displayedAt` (user could see it).
- **No ntfy in V1.** No notification service is deployed. A fixed-text phone alert or an opt-in lens fallback
  (CAMERA-AND-BACKEND section 7) may be reconsidered only after HT-4 and HT-8, and only by the owner's choice.
  `NOTIFY_MODE=always` is removed. `/v1/display-state` is built only if such a fallback is ever added.
- The plugin must not draw results at cold start. Study Lens's `main.ts` does. VERIFIED by reading SL
  `glasses-app/src/main.ts`, reported in CAMERA-AND-BACKEND section 12.
- Answer format: `short` at most 140 characters, `detail` at most 8 items under 400 characters, `caveats`,
  and separate `reading` and `reasoning` confidence. Full schema in CAMERA-AND-BACKEND section 10.
- The plugin joins these into one document and scrolls it by line. Section 10 of that study assumed pages.
  **Line offset replaces page index** (risk 6 closed).
- The label is computed by the backend, never by the model: `CHECKED`, `LIKELY`, `UNSURE`, `CHECK FAILED`,
  `RETAKE`. `CHECKED` means listed steps were confirmed by a computer, not that the page was read correctly.
- Model: `claude-opus-5-5` behind the `SolveProvider` interface.
- Answers are plain text. Unknown glyphs are dropped silently. VERIFIED D/build/display. HT-15 checks German
  letters.
- Latency target: median under 15 s from press to first text. Budget 5 to 21 s connected, 6 to 26 s from deep
  sleep. ASSUMPTION (estimates). The plugin shows `PROCESSING` within 2 s of upload when VISIBLE.

## 11. Privacy, security and use

- This repository is public. No tokens, `.env`, `config.h`, keys or IMU logs in it. Only `*.example` files.
  `.gitignore` covers `.env`, keys and IMU logs today. VERIFIED `.gitignore`. Add `config.h` with the firmware in Phase 3.
- The provider key stays on the backend. The plugin's client token is entered at runtime and never committed.
- Every network origin is listed in the `app.json` whitelist, and CORS still applies. VERIFIED D/build/networking.
- Images are deleted when the job reaches `done` or `failed`, with a hard limit of 1 hour. Result text 30 days.
  Job stub 7 days. Study Lens deletes nothing today. VERIFIED CAMERA-AND-BACKEND section 9.
- Logs carry IDs and timings, never answer text.
- Text in a photo is untrusted input. The prompt says so, and the SymPy check stays in its restricted sandbox.
- The prompt tells the model not to identify people or describe bystanders.
- Point the camera at pages, screens and objects, not at people. Do not use it in exams, changing rooms,
  toilets, medical settings, or anywhere recording or aids are not allowed.

## 12. Locked phone and reliability

**Status: unresolved, and the largest project risk.** Sources conflict. D/build/background-lifecycle says the
WebView "May be suspended under memory pressure", D/reference/faq says suspended on background, SK/background-state
describes a headless WebView, and D/ship/app-submission requires apps to work while locked. None mentions the
IMU. `setBackgroundState` and `onBackgroundRestore` are not exported by SDK 0.0.16. VERIFIED DTS:1535.

Behaviour by case:

| Function | Plugin keeps running | Plugin frozen | Plugin reloaded on lock |
| --- | --- | --- | --- |
| Tilt, shake | Work | Nothing happens | Work after reload, if the IMU re-arms |
| Wear auto-hide | Works | Firmware only | Works after reload |
| Lens content | Stays as it was | Stays as it was | Blank at every lock (Q1) |
| AI result | Shown or stored | Waits on server | Fetched after reload |
| Hidden state | Kept | Kept on the lens | Boots HIDDEN |

All code assumes a cold start can happen at any time:

- Start blank, then read storage.
- If `createStartUpPageContainer` returns anything but 0, use `rebuildPageContainer`. ASSUMPTION GH#32, which
  reports 1 after a reload in the simulator.
- Do not treat events 4 and 5 as lifecycle signals alone: the menu fires them too. VERIFIED D/build/contextual-menu.
- Use `bridge.setLocalStorage` as the source of truth, debounced. VERIFIED SK/glasses-ui.
- Re-arm the IMU on foreground, after reconnect, and while the sensor is lost.
- Treat exit events 6 and 7 as a hide. Event 6 keeps the subscriptions, unlike the plugin guide, so recovery stays
  possible. ASSUMPTION that this is right. Event 7 removes them.

If HT-4 fails there is no alternative route, since plugins have no direct Bluetooth. VERIFIED D/build/device-apis.
Options are in [PLAN.md](PLAN.md), gate G0, and the owner must choose (Q2).

## 13. Acceptance tests

Pass rules are proposals for the owner to confirm. All must pass on real hardware with the phone in its stated
condition. Simulator or unit results do not count. "Logic" means `app/test/acceptance.test.ts` passes on
synthetic motion. That suite has 31 tests, all passing. VERIFIED `npm test`.

| # | Test | Proposed pass rule | Depends on | Status today |
| --- | --- | --- | --- | --- |
| 1 | Scroll up | 9 of 10 deliberate tilts scroll up. Stops within 1 s of returning to neutral | HT-2, HT-3, HT-7 | Logic passes |
| 2 | Scroll down | Same, downward | HT-2, HT-3 | Logic passes |
| 3 | Hide | 9 of 10 shakes blank the lens within 1 s of the last swing | HT-1, HT-3 | Logic passes |
| 4 | Show | 9 of 10 shakes restore. 10 of 10 restore the same screen and line | HT-1 | Logic passes |
| 5 | Accidental activation | In 30 minutes each of walking, talking, and looking sideways: 0 hides, at most 1 scroll. Reading a paper 15 minutes: at most 2 tilts, text back at its start line | HT-11 | Logic passes on guesses |
| 6 | Removal | 19 of 20 removals blank within 2 s, unlocked and locked | HT-5 | Logic passes |
| 7 | Re-wear | 20 of 20 re-wears stay dark until a restore action. No flash of content | HT-6 | Logic passes. Locked case at risk |
| 8 | Camera to AI | 10 of 10 presses reach the lens. Median under 15 s. No duplicates | HT-14 to HT-16 | Display side only, fake result |
| 9 | Hidden AI result | 10 of 10 results stay dark until a restore, including across backend and phone restarts | HT-8, HT-17 | Logic passes, including restart |
| 10 | Connectivity recovery | After Bluetooth and network loss: no reveal, app works again within 30 s of reconnect, no duplicate result | HT-13 | Logic passes with injected events |
| 11 | Competing gestures | Shake during a tilt hides, 9 of 10, with no more than 2 lines of scroll first | HT-11 | Logic passes |
| 12 | Locked phone | All of tests 1, 3, 4, 6 and 8 pass after 30 minutes locked in a pocket, 3 runs | HT-4 | Cold-start logic only |

## 14. Open decisions

| ID | Decision | Recommended | Needed by |
| --- | --- | --- | --- |
| Q1 | If Android reloads the plugin on every lock, "never reveal after restart" blanks the lens at each lock. Keep the rule? | Keep it for V1 and measure how often it happens | G0 |
| Q2 | If HT-4 fails: phone unlocked in pocket, or reduced locked mode? | Depends on what fails. See PLAN gate G0 | G0 |
| D3 | Connection lost while VISIBLE hides content | Keep. It is the safe direction | Phase 1 |
| D4 | V0.2 asks to queue answers while hidden. The prototype keeps only the newest, and the next shake shows it from line 1 | Build a real queue in Phase 2, when the backend already holds the last 20 results. Until then, one stored answer is a known gap | Phase 1 |
| D5 | At the hold limit, return to the starting line, or stop where it is | Return, then confirm with HT-11 | Phase 1 |
| D6 | Approve the changes table above, including personal Beta only | Approve | Before Phase 1 |
| D7 | Pass rules in section 13 | Confirm or adjust | Before Phase 1 |

## 15. Built and not built

The simulator prototype passes typecheck, 361 of 361 unit tests, and 17 of 17 real simulator checks. VERIFIED
`npm test`, `npm run sim:e2e`, both run on 2026-11-07. It does not implement these parts of this spec:

| Spec item | Section |
| --- | --- |
| Contextual menu (`Show`, `Hide`, `Scroll lock`), including `menuItemClickEvent` handling | 3.2, 7 |
| Phone `Show` button with confirm step | 7 |
| Return to starting line at the hold limit | 3.2 |
| Setup checklist on the phone panel | 2 |
| Scroll speed cap at 5 lines a second (range allows 30) | 3.2 |
| Removing the simulator tools from the Beta build | 4 |
| Network client, `app.json` whitelist, client token entry | 10, 11 |
| Backend, camera firmware, camera hardware | 9, 10 |

Known limits of what is built:

- If the bridge takes longer than 3 s to appear at start, the page stays dead until a reload.
- A hide can wait up to about 2.5 s behind one hung bridge call.
- A stored neutral more than 15 degree-equivalents wrong leaves tilt dead until recalibration.
- Calibration assumes a wrap period of 360, so it cannot infer one for radian data. HT-2 decides whether this matters.
- In rate mode, leftover sensor bias is not corrected.
