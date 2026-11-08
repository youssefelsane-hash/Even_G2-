# G2 Assistant: simulator prototype

Hands-free assistant app for Even Realities G2 glasses. This prototype covers the gesture engine, the
Visible/Hidden state machine, content paging, calibration, a raw IMU logger and the client for the assistant
backend (`../backend`, API in `../docs/API.md`). **It has never run on real glasses, a real phone or against a
deployed backend, and its gesture thresholds are not hardware-validated.** Every backend test uses a fake
server.

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
npm run mutate      # mutation check: plants 23 small bugs in a copy of the source, checks the tests catch each
npm run replay -- <log.csv> [settings.json]   # replay a raw IMU log against its marks
npm run traces      # regenerate the SYNTHETIC sample traces in test/traces
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
| `src/core/backend.ts` | Backend client: results long-poll with a stored cursor, acks, presence, camera settings. Injected fetch and storage |
| `src/core/inbox.ts` | The newest 20 answers, newest first, with an unseen flag. The hidden-result queue |
| `src/core/activity.ts` | Measures background head motion (walking, talking) and raises gesture thresholds while it is high |
| `src/core/personal.ts` | Personal calibration from the user's own recorded examples, with a before and after score |
| `src/core/population.ts` | Synthetic population of simulated people, for tests and the report |
| `src/core/imuReplay.ts` | Parses raw logger CSV or JSON and replays it against its marks |
| `test/fakeBackend.ts` | Fake backend, in memory or over real HTTP on 127.0.0.1 |
| `test/traces/` | SYNTHETIC sample traces in the logger format, from `tools/make-traces.ts` |

## Backend connection

Set up on the phone panel, under Backend: the server origin and the client token. Both are stored in the
WebView's `localStorage` on the phone, never in the repository. The token field is never filled back in. The
server origin must also be listed in `app.json` under the `network` permission's `whitelist`, which ships with
the placeholder `https://g2-assistant.example.com`. Replace it with your server before packing. The panel warns
when the saved origin is not in the whitelist. CORS on the backend must allow the plugin's origin (VERIFIED
D/build/networking for the rule, `../backend/src/server.ts` for `CORS_ORIGIN`).

What the client does (`src/core/backend.ts`, tested against `test/fakeBackend.ts`):

- Long-polls `GET /v1/results?cursor=N&wait=25`. A request that hangs 10 s past the wait is aborted and retried.
  Errors back off from 1 s up to 30 s with jitter. A rejected token stops fast polling and says so on the panel.
- Saves the cursor only after every event of a page was handed to the app and stored, so a reload fetches them
  again. Repeats are dropped by job and sequence number, and the inbox drops a job it already has.
- Sends `received` acks once a final result is stored on the phone, and `displayed` acks when the answer was on
  the lens. Acks wait in storage while offline and are sent once.
- Reports presence (`VISIBLE`, `HIDDEN`, `REMOVED`, `UNKNOWN`). Only the newest value is sent. `UNKNOWN` is
  sent while the glasses are disconnected or the wear state is unknown.
- Wakes at once on foreground, network back, and when the page becomes visible.
- Treats server data as untrusted: unknown statuses and labels are dropped or downgraded, and text is clipped.
- Never busy-loops. A reply with no events that comes back in under 1 s (a server or proxy ignoring `wait`)
  is followed by a pause of 1 s, doubling up to 30 s. `more: true` with no events is not "poll again at once".
- A catch-up from the start of the stream (cursor `0`: fresh install, wiped `localStorage`, or a reset server)
  is history, not news, for jobs created more than 15 minutes ago (`createdAt`): no camera status, no retake,
  and answers are stored as already seen, in server order behind the answers the phone kept. The cursor lives
  in `localStorage` and the answers in the SDK store, so one can be lost without the other. Jobs from the last
  15 minutes, and events without `createdAt`, are handled as usual. This relies on the phone clock being
  roughly right (ASSUMPTION).

What the lens shows (only while VISIBLE; nothing at all in HIDDEN or REMOVED):

| Event | Header line |
| --- | --- |
| received | `RECEIVED 3 PHOTOS` (and `(page 2)` for an added page) |
| processing | `READING...` |
| ready | The backend label, for example `CHECKED`, then `2p` for a two-page answer. The answer text below |
| retake | `RETAKE`, with "Retake: too dark. Press the camera button again." |
| failed | `ERROR`, with a fixed message. Server error text is never shown |

Answers that arrive while hidden are stored (newest 20) and marked unseen. After a restore the newest is shown
first, and the header says `+2 new` while more are waiting. A press opens the next one. A restart or reconnect
never reveals anything. Camera settings (single press burst or one photo, N photos per burst, K best photos
sent, long press clip or long burst, resolution) are read and saved under Camera on the panel, through
`GET` and `PUT /v1/camera/config`. Only those fields are ever sent.

## Smarter gestures

All of this is SYNTHETIC: tuned and tested on generated motion only (figures below).

- **Quick-glance rejection.** The V0.3 weakness was a left-right look with a short rest at each side firing a
  shake. The shake detector now measures how long the head rests near each turning point (within 5 % of the
  swing, with interpolated crossing times, so it no longer depends on where the highest sample falls). A rest
  longer than `shakeMaxPlateauMs` (110 ms) breaks the chain. For slow shakes the limit grows to 0.45 of the swing
  that led into the turning point (at most 1.4 times 110 ms), because a slow sine rests longer too; without
  this, real shakes at 1.2 to 1.3 Hz were refused. Below about 12 samples a second, one sample period
  of slack is added, because the rest cannot be measured better than that.
- **Activity awareness.** `activity.ts` measures the yaw and pitch range in 500 ms buckets over the last 8 s,
  ignoring the newest 1.5 s and any recognised gesture, so a shake does not raise the bar for the next one.
  A steady drift shared by every bucket (gyro bias in rate mode) is taken off the
  ranges, so it does not read as busy. While the head is busy, the minimum shake swing rises up to 1.6 times and the tilt thresholds up to 6
  degree-equivalents, but never past 80 % of `shakeMaxAmpDeg`, so a shake always stays possible. Switch it off with "Ask for clearer gestures while walking or talking". The cost: shakes
  while walking are missed more often (section 5 of the report).
- **Confidence.** Every shake and tilt start carries a 0 to 1 confidence, from the margins over each limit. It is
  logged and shown on the panel. It does not gate anything yet: real data must show what a useful cut-off is.
- **Undo hide.** After a shake hides the lens, a double press within `undoHideMs` (4 s) brings back the same
  screen. It cannot leak content: it needs a double press, wear must be `worn`, and it restores only if the
  screen would be exactly what was hidden. A new answer or camera status, a wear or connection change, an exit,
  a settings change or a restart cancels it. It never applies to a hide by removal or connection loss. 0 turns
  it off.
- **Personal calibration.** After the axis wizard, the user records at least 3 examples each of shake, tilt up
  and tilt down, plus ordinary movement that must not count. Thresholds are derived from those examples, then
  replayed against them. Ordinary-movement examples that still fire push the limits up step by step. The panel
  shows "current settings on your examples" against "proposal on your examples". Nothing changes until Accept.
  Shake examples smaller than 14 degree-equivalents from side to side are refused, and no proposal sets the
  minimum below that (synthetic talking fires about 17 shakes an hour at 14, over 80 at 10). The whole-chain
  time limit grows with slow shakes, so a proposal can actually fire on them. A warning appears when the
  proposal catches fewer than half of any gesture's examples.
- **Tilt off.** "Tilt to scroll" on the panel (`tiltEnabled`). A property test checks that nothing scrolls with
  it off, whatever the motion.

## Tests

`npm test` runs 469 tests, all passing (2026-11-08). On top of the 361 from V0.3:

| Kind | File | What it checks |
| --- | --- | --- |
| Backend client | `test/backend.test.ts` | Cursor, repeats, acks, presence, backoff, bad tokens, bad data, camera settings, one run over real HTTP |
| Job flow | `test/jobs.test.ts` | Status lines, retake, pages, hidden queue, inbox limit, restart, reconnect, end to end with the fake server |
| Smart gestures | `test/smartGestures.test.ts` | Glance rejection, confidence, activity awareness, undo hide and its leak cases, tilt off |
| Property-based | `test/property.test.ts`, `test/prop.ts` | Random sequences of every event never light the lens unless visible, and only a restore action reveals (120 sequences, coverage checked). Pager, settings, parser, inbox, cooldown, broken sensor data. Seeded; failures print `PROP_SEED` and a shrunk case |
| Metamorphic | `test/metamorphic.test.ts` | Same gestures after scaling the raw unit, rewiring axes and signs, mirroring, shifting the clock, a yaw offset, a different sample rate, and rate instead of angle data |
| Trace replay | `test/replay.test.ts` | Replays `test/traces/*.csv` (logger format, SYNTHETIC) against their marks. Real Phase 0 logs can be dropped in with a `.settings.json` |
| Population | `test/population.test.ts` | 60 simulated people: detection and false-fire bounds against the legacy settings |
| Personal calibration | `test/personal.test.ts` | Small shakers caught, ordinary motion guard, wrong-way tilts refused, nothing applied before Accept |
| Break-it review | `test/breakit.test.ts` | Defects found by trying to break the smart gestures and privacy rules, one failing test each before its fix: bad personal examples, boost past the maximum, gyro drift read as activity, slow shakes refused as glances, long-poll busy loops, a lost cursor bringing old answers back as new |
| Mutation check | `tools/mutation-check.ts` | 31 planted bugs in a temporary copy; each must make a test fail. 31 of 31 caught |

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

**3. Notifications bypassing Hidden.** This app sends no notifications. Its only network use is the backend client. The
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

- A result that arrived while hidden replaces the old screen, so the next shake shows the newest answer from its
  first line, not the exact previous screen. The newest 20 answers are kept, and the others wait behind a press
  (decision D4 in the spec, now built).
- **ASSUMPTION:** the camera job runs independently of the lens, so state is `mode` plus `job`, and
  `flatState` returns the single spec state. Hidden and Removed always win.
- **ASSUMPTION:** a lost connection hides the content and sets wear to unknown, so a shake works again only
  after a fresh wear report.
- If the IMU fails while Visible, a shake cannot hide. The way out is a double press, which opens the exit dialog.
- Gestures wait `wearSettleMs` (1.5 s) after re-wear, because putting glasses on looks like wild motion.

## Tests against the 12 acceptance tests

`test/acceptance.test.ts` runs the full pipeline on synthetic motion with a fake clock. All 469 unit tests pass,
and all 23 simulator checks pass (2026-11-08).

| Test | Status without hardware |
|---|---|
| 1 scroll up, 2 scroll down, 3 hide, 4 show | Logic passes. Real feel and thresholds need hardware |
| 5 accidental activation | Logic passes on synthetic walking, talking and glances. Real motion needs hardware |
| 6 removal, 7 re-wear | Logic passes with injected wear. Real wear events need hardware |
| 8 camera to AI | Display side and backend client, against a fake server. No camera, real backend or AI |
| 9 hidden AI result | Logic passes, including across a restart |
| 10 connectivity recovery | Logic passes with injected events. Real Bluetooth loss needs hardware |
| 11 competing gestures | Logic passes |
| 12 locked phone | Cold-start logic only. The test itself cannot run without a real phone and glasses |

## Synthetic results (`npm run report`)

**These do not validate anything on hardware.** The motion models are guesses, and the defaults were chosen
against them, so the zeros at intensity 1.0 are expected. The useful part is where the numbers start to fail.

"Legacy" is the V0.3 defaults (no activity awareness, no rest limit). "Now" is the current defaults. Both run on
exactly the same generated samples. Run on 2026-11-08.

False fires over 5 hours of each activity (50 Hz, 8 ms jitter, 2% drops). Intensity scales all background
motion. Walking and tilts were 0 for both at every intensity.

| Talking intensity | Shakes, legacy | Shakes, now |
|---|---|---|
| 1.0 | 0 | 0 |
| 1.25 | 0 | 0 |
| 1.5 | 3 | 1 |
| 2.0 | 301 | 15 |
| 3.0 | 977 | 182 |

Detection over 300 randomised trials per row, standing still: unchanged. 100% for shake and both tilts at 15 Hz
and above (with jitter, drops and batches), shake 98.0% at 10 Hz, 88.3% at 7 Hz, 60.3% at 5 Hz, tilts 100%.

Shake while walking (300 trials, 50 Hz): legacy 286 detected, now 281. Neither ever fired twice.

Quick left-right looks, 12 cases per rest time (fired / 12):

| Rest at each side | Legacy 50 Hz | Now 50 Hz | Legacy 15 Hz | Now 15 Hz |
|---|---|---|---|---|
| 0 ms | 3 | 3 | 4 | 4 |
| 50 ms | 2 | 2 | 1 | 1 |
| 100 ms | 2 | 0 | 2 | 1 |
| 150 ms | 1 | 0 | 1 | 0 |
| 200 ms | 1 | 0 | 0 | 0 |

A look with no rest at all is the same movement as a shake, so it still fires. Below 12 samples a second the
rest limit gets one sample period of slack, and glances at 10 Hz still fire in some cases.

Synthetic population of 200 people (shake 10-30 degrees each way at 1.3-3.2 Hz, tilts 16-34, background 0.6-2.2
times the models, 15, 25 or 50 Hz):

| Settings | Shake | Tilt up | Tilt down | Shake while walking | False shakes per hour | False tilts per hour | People with a false shake | People missing most shakes |
|---|---|---|---|---|---|---|---|---|
| Legacy | 78.0% | 97.6% | 95.9% | 66.0% | 6.48 | 9.57 | 35 | 32 |
| Now | 78.0% | 97.6% | 95.9% | 48.5% | 1.18 | 3.09 | 8 | 32 |
| Now + personal calibration | 92.0% | 100% | 100% | 53.5% | 6.18 | 4.71 | 29 | 7 |

What this says, on synthetic data only:

- False shakes in ordinary motion fall by about 82 % and false tilts by about 68 %. That matters most while
  hidden, because a false shake there shows the content.
- The price is shakes while walking: 66 % to 48.5 % across the population, and 286 to 281 of 300 in the
  single walking model. People with small shakes are hit hardest. Turning activity awareness off restores it.
- The rest limit first cost about 2 points of standing detection, from very slow shakes. Letting the limit grow
  with slow swings won that back (78.0 %, same as legacy), at the price of one more glance in 12 firing at a
  50 ms rest (50 Hz) and at a 100 ms rest with the shortest turns (15 Hz), and slightly more false shakes
  (1.03 to 1.18 an hour).
- Personal calibration catches far more of each person's own gestures, but for people with small shakes it also
  lowers the limit, so their false shakes rise again. Five or more ordinary-movement examples help.

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
