# Project plan

Date: 2026-11-07. Current position: simulator prototype finished, nothing tested on hardware, nothing committed.

The rule of this plan: **measure before building.** The two facts that can end the project as specified are
whether x/y/z carry usable head motion, and whether IMU samples keep arriving with the Android phone locked. No
source settles either. See [FEASIBILITY.md](FEASIBILITY.md).

Effort figures are ASSUMPTION, for one person. HT numbers are in [HARDWARE-TESTS.md](HARDWARE-TESTS.md). Q and D
numbers are in [SPEC-V0.3.md](SPEC-V0.3.md) section 14.

## Phases and gates

| Phase | Goal | Effort | Exit gate |
| --- | --- | --- | --- |
| 0 | Hardware experiments | 2 to 4 days | G0 |
| 1 | Gestures and recovery on real motion | 1 to 2 weeks | G1 |
| 2 | Backend and result delivery, no camera | 1 week | G2 |
| 3 | Camera | 2 to 3 weeks, including parts delivery | G3 |
| 4 | Integration and acceptance | 1 week | G4 |
| 5 | Only if needed: BLE companion | 2 weeks | None planned |

Do not start a phase until the gate before it says go. Do not buy camera parts or set up a server before G0.

## Phase 0: hardware experiments

Scope: no new features. Only the logger additions L1 to L4 listed in HARDWARE-TESTS, which need approval before
any code is changed.

Tasks:

1. Owner approves or adjusts the spec changes (D6).
2. Install by QR. Run HT-1, HT-2 and HT-3 on the current build.
3. Add L1 to L4. Publish a Beta build.
4. Run HT-4.
5. Record results and decide at G0.

### Gate G0

Go only if all three hold: IMU flows on a blank page or a marker page (HT-1), head motion is readable with enough
samples (HT-2, HT-3), and the plugin keeps working while locked (HT-4).

| Outcome | Decision |
| --- | --- |
| HT-1, HT-2, HT-3, HT-4 pass | **Go** to Phase 1 |
| HT-4 reloads but recovers | **Go**, after the owner decides Q1 |
| Blank page stops the IMU | **Go** with a marker page or menu restore, after the owner accepts the change |
| Data is accelerometer-only, or rate is under 10 a second | **Pause.** Redesign shake or make it optional. Owner approves the gesture change |
| No IMU data at all | **No-go** for head gestures. Offer a touch-only assistant, or stop |
| HT-4 fails | **No-go as specified.** Owner chooses below (Q2) |

If HT-4 fails, the options are as follows. There is no direct Bluetooth route for a plugin. VERIFIED
D/build/device-apis.

| Option | Keeps | Loses | Cost |
| --- | --- | --- | --- |
| A. Battery Unrestricted, pin the Even app, retest | Everything, if it works | Nothing | Hours. Always try first. ASSUMPTION SUP/known |
| B. Phone unlocked in the pocket, screen on | All gestures | "Locked phone" goal. Accidental touches, battery | Low |
| C. Reduced locked mode | Firmware Wear Detection, Silent Mode, menu `Display off`. Results wait until unlock | Head gestures and live answers while locked | Low |
| D. Ask Even for a background sensor mode | Possibly everything, later | Time, and it is out of our hands | Low. Do it alongside the others |
| E. iPhone as the bridge | Possibly everything. Docs say the iOS WebView keeps running. VERIFIED [S23]; GH#16 reports otherwise | Needs a second phone. Still untested | Medium |
| F. Unofficial BLE stack | Possibly everything | Unsupported, may conflict with the Even app, IMU not confirmed | High. Not recommended |

## Phase 1: gestures and recovery on real motion

Tasks:

1. Build the missing spec items: contextual menu, phone `Show`, return to start line at the hold limit, setup
   checklist, scroll speed cap. SPEC section 15 has the list.
2. Build a CSV replay tool, so real logs run through `app/src/core` in Node tests.
3. Add an adapter mode if HT-2 requires it.
4. Replace the synthetic defaults with values from real logs.
5. Run HT-5 to HT-13.
6. Decide D3, D4, D5, D7.
7. Hide the simulator tools from Beta builds.

### Gate G1

**Go** if acceptance tests 1 to 7 and 11 pass on hardware, and HT-9 shows a working recovery with the IMU silent.

**No-go** if accidental hides cannot be brought under the agreed rule: keep shake but move scrolling to touch, or
take the menu as the normal hide. Either one is a spec change for the owner.

## Phase 2: backend and delivery

Tasks:

1. Bring in the Study Lens backend with the changes below.
2. Replace the answer schema, prompt and label logic.
3. Add the plugin client, `network` permission, whitelist and runtime token entry.
4. Test with `tools/fake-camera.mjs`, then the phone camera through `captureImageFromCamera()`. The second gives a real
   AI path before any camera exists. VERIFIED DTS:1390.
5. Deploy on a small EU server. Check that no secrets are in the repo.

### Gate G2

**Go** if a fake capture reaches the real lens, locked, with no duplicate, a hidden result stays hidden across restarts,
images are gone after the job, and the median latency without the camera hop leaves room for the 15 s target.

**No-go** if results do not arrive while locked although HT-4 passed: long-poll is suffering where the IMU is not. Check
network in the background (`in-flight requests stall`, VERIFIED D/reference/faq) and consider shorter polls.

## Phase 3: camera

Tasks:

1. Buy parts. Check which sensor arrives. VERIFIED [S2]: boards may ship with OV5640 or OV3660.
2. Change the firmware: external LED before capture, deep sleep window, new LED patterns, no microphone.
3. Flash and test on the bench. Nothing in this firmware has ever been flashed. VERIFIED [S1].
4. Design the enclosure: must look like a camera, LED beside the lens, vents.
5. Run HT-14, HT-15, HT-16.

### Gate G3

**Go** if the hotspot works locked, 18 of 20 pages are legible, and the LED passes HT-16. HT-16 cannot be waived.

**No-go** routes: hotspot fails, go to Phase 5. Image quality fails, try the other sensor, or a larger device. LED fails,
fix before any further use.

## Phase 4: integration

Tasks: run HT-17 and HT-18. Run for a week of normal use, with notes. Fix what breaks.

### Gate G4

**Done** when all 12 acceptance tests pass on a Beta build, or the owner has accepted a named limit in writing. V1 stays a
personal Beta build. It is not aimed at store review, because blank screens break the store rules. VERIFIED
D/ship/app-submission.

## Phase 5: only if needed

BLE foreground-service companion, only if the hotspot fails HT-14. Scope: receive JPEG from the camera, post to the same
endpoint with the same key. It does not help with the lens, the IMU or the locked-phone problem. See
[CAMERA-AND-BACKEND.md](CAMERA-AND-BACKEND.md) section 5.

## Reuse of Study Lens

Study Lens has never run on real hardware. VERIFIED [S1]. Reusing it saves writing code, not testing it. Copy from it.
Do not modify the original.

| Part | Action | Phase | Notes |
| --- | --- | --- | --- |
| `backend/src/auth.ts` | Reuse, then change | 2 | Bind token to device ID. Reload without a restart |
| `backend/src/verify.ts`, `backend/scripts/verify_math.py` | Reuse | 2 | SymPy check with timeout |
| `backend/src/presence.ts` | Reuse | 2 | Feeds `glassesListening` |
| `SolveProvider`, `classify()` | Reuse | 2 | Provider boundary and retries |
| `backend/src/server.ts` | Change | 2 | `received` event, `receivedAt` and `displayedAt`, rate limits, `glassesListening`, bind to localhost |
| `backend/src/store.ts` | Change | 2 | Delete images on finish, retention sweep, reserve idempotency key before writing |
| `backend/src/worker.ts` | Change | 2 | Remove all notification calls |
| `backend/src/notify.ts` | **Do not carry over** | | Risk 3. Three faults that break Hidden. CAMERA-AND-BACKEND section 7 |
| `backend/src/providers/anthropic.ts`, `types.ts` | Change | 2 | New schema, prompt moves from "solve" to "explain" |
| `glasses-app/src/client.ts` | Reuse, then change | 2 | Polling, backoff, persisted acks. Split the ack |
| `glasses-app/src/main.ts` | **Do not carry over** | | Draws results at cold start, which breaks "never reveal after restart" |
| `glasses-app/src/viewer.ts`, `pages.ts`, `glasses.ts` | Do not carry over | | Replaced by `app/src/core` |
| `firmware/study_cam/study_cam.ino` | Change | 3 | Pin map, camera init, retry and debounce are kept. External LED, deep sleep, no microphone |
| `firmware/study_cam/config.example.h` | Reuse | 3 | Only the example file. Never a real `config.h` |
| `tools/fake-camera.mjs`, `tools/e2e-sim.mjs` | Reuse | 2 | Test without hardware |
| `docs/TEST-PLAN.md` | Reuse | 3 | The 50-capture run, in HT-15. Remove the ntfy setup step |
| `docs/ANDROID.md` | Change | 3 | Remove the Auto Display and ntfy steps |
| `.gitignore` | Already merged | | Root `.gitignore` covers secrets. Add `firmware/**/config.h` in Phase 3 |

## Risks, limitations and fallbacks

Likelihood is ASSUMPTION. "Unknown" means there is no evidence either way.

| # | Risk or limitation | Likelihood | Impact | Fallback | Test |
| --- | --- | --- | --- | --- | --- |
| 1 | x/y/z meaning unknown, may be unusable | Unknown | High | Adapter, wizard, redesign gesture | HT-2 |
| 2 | WebView stops when locked | Unknown. Sources conflict | Project-level | G0 options | HT-4 |
| 3 | Notifications bypass Hidden | Certain for ntfy, so it is removed | High for privacy | No ntfy. Auto Display off | HT-8 |
| 4 | HeadUp collides with tilt-up | Unknown. HeadUp is on by default | Medium | HeadUp off, as required setup | HT-7 |
| 5 | Looking down causes scrolling | Likely in part. A fast look down still scrolls | Medium | Gating, hold limit, return to start line, scroll lock | HT-11 |
| 6 | No programmatic scroll | Certain | Low, solved | App-managed line offset. Line steps, not smooth | HT-10 |
| 7 | IMU or touch stops on blank page | Unknown | High | Dim marker page, menu restore | HT-1 |
| 8 | Hidden trap when the IMU fails | Solved in design | High if unsolved | Menu, press pattern, phone `Show` | HT-9 |
| 9 | Old page returns on re-wear if plugin was frozen | Likely if HT-4 shows freezing | High for privacy | Hide first. Silent Mode. Stated limit | HT-6 |
| 10 | Sample rate too low for shake | Possible. One report says about 10 a second | High for shake | Slower gesture. Menu as normal hide | HT-3 |
| 11 | Accelerometer-only data: no yaw | Unknown | High for shake | Different gesture | HT-2 |
| 12 | Conversation triggers a hide | Likely in part. Synthetic weak spot | Medium. Fails safe | Raise thresholds | HT-11 |
| 13 | Missing `isWearing` reads as removed | Certain in SDK 0.0.16. Frequency unknown | Medium. Fails safe | Confirm time. Trust-wear setting | HT-5 |
| 14 | Non-overflowing text gives no swipe events | Unknown | Medium | Menu paging items | HT-10 |
| 15 | Lens goes dark on every lock, if lock reloads | Unknown | Medium | Q1 | HT-4 |
| 16 | Hotspot turns off or fails locked | Possible | Medium | Auto-off disabled. Home Wi-Fi. BLE companion | HT-14 |
| 17 | Hotspot traffic disturbs the IMU | Unknown | Medium | Smaller images | HT-14 |
| 18 | Photo unreadable at reading distance | Possible | Medium | Autofocus sensor. `RETAKE` | HT-15 |
| 19 | No viewfinder, poor aim | Likely at first | Medium | Chest clip. AI says what was cut off | HT-15 |
| 20 | Brown-out on small cells | Possible | Low | 300 mAh or larger | HT-15 |
| 21 | Latency over 15 s | Possible. AI is the largest share | Medium | Lower effort, send `short` first | HT-15 |
| 22 | Wrong answer that looks right | Certain sometimes | High for study use | Backend label, question as read shown last, Study Lens accuracy test | HT-15 |
| 23 | Camera misuse or legal exposure | Depends on use | High | Visible LED, looks like a camera, physical press only, no video or audio. Not legal advice. CAMERA-AND-BACKEND section 11 | HT-16 |
| 24 | Secret leaks into the public repo | Possible | High | `.gitignore`, `*.example` only, check before every commit | Each commit |
| 25 | SDK or Even app update changes behaviour | Likely over time | Medium | Record versions. Re-run HT-1 and HT-4 | After updates |
| 26 | `setBackgroundState` may arrive in a later SDK | Unknown | Could help | Watch the changelog and GH#16 | When released |
| 27 | Battery too short | Unknown | Medium | Slower pace | HT-12 |

Limitations that are permanent for V1, by design or platform:

- No smooth scrolling. No audio cue. Hidden has no feedback at all on the lens.
- Hidden cannot cover other apps' notifications unless Auto Display is off, or the Dashboard unless HeadUp is off.
- Settings and calibration need the phone in hand.
- Personal Beta build only.

## Waiting on the owner

| When | Item |
| --- | --- |
| Now | D6: approve the spec changes, or adjust them |
| Now | Approve logger additions L1 to L4 |
| Now | Run `evenhub login` yourself. Decide when to commit: nothing in this repo is committed yet |
| At G0 | Q1 and Q2, using the measured results |
| Phase 1 | D3, D4, D5, D7 |
