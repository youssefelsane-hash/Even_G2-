# Feasibility study: Even G2 Personal Assistant

Checked on 2026-11-07 against SDK 0.0.16. No part of this has been run on real glasses.

The rows below were written from a summary of [SPEC-V0.2.md](SPEC-V0.2.md). Differences found when comparing
with the original are recorded in [SPEC-V0.3.md](SPEC-V0.3.md).

Labels (VERIFIED, EXPERIMENT NEEDED, ASSUMPTION) and source keys (DTS, RM, SK/, D/, SUP/, GH#, CN/, SL)
are defined in [SDK-APIS.md](SDK-APIS.md).

This study came first. Where it differs from [SPEC-V0.3.md](SPEC-V0.3.md) or
[HARDWARE-TESTS.md](HARDWARE-TESTS.md), those win. For example, the spec drops the re-basing of neutral in S3,
and HT-4 replaces the H1 durations and heartbeat interval.

**Status** in the matrix means:

- **Supported**: a documented API or a plain software design covers it, and no hardware unknown blocks it.
- **Experimental**: an API exists, but success depends on a hardware unknown below.
- **Unsupported**: no API exists, and it cannot be built as stated.

## Verdict

The gesture design is buildable only if two hardware facts turn out well: x/y/z must carry usable
head motion, and the plugin must keep running with the Android phone locked. No source settles either.
Both can be measured in a short Phase 0 with a raw logger, before any gesture code is tuned.

The rest (state machine, app-managed scrolling, calibration, camera path) is ordinary software and
can start now, as long as it sits behind an adapter and is tested with recorded or synthetic samples.

## Deciding hardware unknowns

Ordered by how much of the project each one can kill. All are EXPERIMENT NEEDED.

**Test on a Beta build.** Local Testing dies the moment the phone locks and Private builds fail the
5-minute lock test (VERIFIED D/test/local-testing, D/test/private-testing). A locked-phone test on
either says nothing. Beta needs no Even review (VERIFIED D/test/beta-testing).

| ID | Question | How to measure | If the answer is bad |
| --- | --- | --- | --- |
| H1 | With the Android phone locked in a pocket, do IMU samples keep reaching the plugin? For how long? | Beta build. Log a sample counter and heartbeat to the backend every 5 s. Lock for 5, 30 and 120 minutes. Run with battery set to Unrestricted, and without. | Gestures, wear hiding and hidden state all stop while locked. See "If H1 fails" below |
| H2 | What are x/y/z? Does a held tilt stay visible in the signal, and is a left-right head shake visible? | Log still, held pitch up and down, roll, yaw turn, shake, walk, talk. | If rate-only: held tilt needs integration and will drift. If accelerometer-only: pitch is easy, but yaw shake is weak. Spec gestures may need to change |
| H3 | Real sample rate and jitter per pace code, and which direction the codes run | Count samples per second for all 10 codes. | A deliberate shake needs roughly 10 samples per second or more (ASSUMPTION). At 2 to 3 shakes per second, slower pacing aliases it. One report suggests P100 is 10 per second (ASSUMPTION CN/zenn), which is marginal |
| H4 | Does `isWearing` arrive reliably, how fast, is false sent as false, and does it need Wear Detection on? | Remove and re-wear 50 times with timestamps, with the setting on and off, phone locked and unlocked. | Without it, auto-hide falls back to a stillness heuristic, which is weaker |
| H5 | On re-wear, does stale content flash? | Show text, remove, wait, re-wear, watch. Repeat with the phone locked. | Firmware brings active features back on re-wear (VERIFIED SUP/wear, with Translate as the example). If a plugin page behaves the same (EXPERIMENT NEEDED) and the blank did not reach the glasses first, the old page returns. This is a privacy failure of the "stay hidden" rule |
| H6 | What happens to the JS when the phone locks: same context, headless reload, or frozen? Does `imuControl` survive? Does create return 1? | Per-load random run ID in every log line. Record `onLaunchSource`, create and rebuild results. | If each lock is a reload, the app must re-arm the IMU and rebuild the page every time, and the "never reveal after restart" rule hides content on every lock (see Q1) |
| H7 | Does HeadUp or the Dashboard fire while the plugin is in front? Does it take focus from the plugin? | Tilt up past the set angle in the plugin with HeadUp on, then off. Repeat on the blank page. | Require HeadUp off, or keep the scroll threshold below the HeadUp angle |
| H8 | Do forwarded notifications appear over a blank plugin page? | Send test notifications during HIDDEN, with Auto Display on and off. | Auto Display must be off for Hidden mode to mean anything |
| H9 | Does a blank page keep IMU and touch flowing, or does the display sleep and stop them? Can `textContainerUpgrade` write `' '`? | Blank for 30 minutes, log IMU, then shake to show. | If the IMU stops on a blank page, a shake cannot restore. Fall back to a minimal dim marker, or to touch restore |
| H10 | Cost of the IMU stream: phone and glasses battery, and whether it starves other bridge calls | Two hour run at the chosen pace. | Use a slower pace, or stop the IMU when there is nothing to scroll (a shake must still work) |

### If H1 fails

There is no alternative route. A plugin has no direct Bluetooth (VERIFIED D/build/device-apis), and
the BLE byte-pipe request is still open (GH#28). Options, in order of preference:

1. Battery set to Unrestricted, Even app pinned in recents, and retest. (ASSUMPTION SUP/known, G1 article.)
2. Phone stays unlocked with screen on in the pocket. This breaks the "locked phone" goal and needs the
   user's decision.
3. Accept reduced behaviour while locked. Hide then relies on firmware: Wear Detection for removal,
   and Silent Mode (both touchpads, 1 second) or the menu's Display off slot for manual hiding.
   The menu is stated to be held by the OS. That Wear Detection and Silent Mode need no WebView is an ASSUMPTION, since they are firmware features.
4. Ask Even for a background sensor mode through the Discord or the plugin repo.

## Risks 1 to 8

| # | Risk | Finding | Answer |
| --- | --- | --- | --- |
| 1 | x/y/z and rate unknown | Still unknown. FAQ says "A units table is still TBD" (VERIFIED D/reference/faq). Two community projects also had to treat axes as unknown (ASSUMPTION CN/note, CN/g2Rest) | Gesture engine takes normalised signals from an adapter. All axis choice, sign, scale and rate are calibration data. Phase 0 raw logger comes first. One hint: the HeadUp setting works in degrees from a calibrated zero, so firmware knows pitch, but that does not mean x/y/z expose it (ASSUMPTION) |
| 2 | WebView suspended when locked | Official sources conflict (SDK-APIS discrepancy 5). The strongest positive evidence is that reviewers require apps to work locked, and the Beta test expects the app to survive 5 minutes (VERIFIED D/ship/app-submission, D/test/beta-testing). Strongest negative: FAQ says suspended and "foreground-only". The IMU is not named anywhere | Still the largest risk. Measure as H1 and H6 before building further. Design everything to survive a cold start |
| 3 | ntfy bypasses Hidden mode | Confirmed by design: SL `backend/src/notify.ts` sends answer text as a normal notification, and Auto Display shows it on the lens (VERIFIED SUP/notifications, SL docs/ANDROID.md). The plugin cannot intercept it. Even a content-free "ready" message would light the display | **Do not carry the ntfy fallback over.** Default is no phone notifications from the backend. Results wait on the server until the plugin fetches them. If H1 fails and a locked-phone display path is wanted, make it an opt-in setting with a stated warning that it can show during Hidden. Also turn ntfy off in Even app > Settings > Notifications |
| 4 | HeadUp collides with tilt-up | Real risk. HeadUp is on by default and wakes the display when the display is off and the head rises past the set angle (0 to 60 degrees) (VERIFIED SUP/dashboard). Behaviour while a plugin is in front is not stated. It can be switched off by the user, but not by an app (VERIFIED by absence in DTS) | Setup step: turn HeadUp off, or set the angle clearly above the scroll-up threshold. In HIDDEN, a tilt up could still raise the Dashboard, which is not app content but does light the display. Measure as H7 |
| 5 | Looking down at paper causes scrolling | No source covers this. A plain threshold cannot tell reading a page from a scroll command | See spec change S3 below: scrolling happens only when there is overflow; a tilt must start from neutral with a quick onset; a tilt held past a limit stops, re-bases neutral and returns to where it started; and a touch-toggled scroll lock exists. The auto-rebase idea follows g2Rest (ASSUMPTION CN/g2Rest, not hardware-tested) |
| 6 | Scroll must be app-managed | Confirmed. No programmatic scroll position, and the firmware offset cannot be read or set (VERIFIED D/build/device-apis, GH#45) | App owns a line offset. Text is pre-wrapped with `@evenrealities/pretext`, and only the lines that fit are sent with `textContainerUpgrade`, so nothing overflows and firmware scroll never engages. Restoring scroll is then just re-sending the stored window. Scrolling moves in line steps, not smooth pixels. At about 83 ms per update (ASSUMPTION CN/even-g2-notes), 4 to 5 lines a second is a safe target |
| 7 | Blank page contents | Partly answered. A page needs one text container with `isEventCapture: 1` and `content: ' '` (VERIFIED SK/glasses-ui, D/build/display). `textColor: 0` is not off (VERIFIED D/build/display). Whether the IMU flows on a blank page is unknown | Blank page is one borderless text container holding a single space. Hide with `textContainerUpgrade`, which avoids the rebuild flicker and state loss. V1 stays text-only with one content container, so one call hides everything. H9 confirms |
| 8 | Only shake restores vs recovery | Resolved in design. A deliberate fallback exists: the contextual menu, which needs tap then long press then selecting an item, is held by the OS, and does not use the IMU (VERIFIED D/build/contextual-menu). Touch does nothing off the head when Wear Detection is on (VERIFIED SUP/wear) | See spec change S2 below |

## Proposed spec changes

These need the user's approval.

- **S1. Fail closed at startup.** The start page is always blank. `createStartUpPageContainer` never
  carries content. State defaults to HIDDEN before storage is read, so a crash between hide and save
  cannot reveal. This also fixes a race: blank first, then save.
- **S2. Restore paths.** Change "only shake restores" to: shake is the normal restore; a neutrally
  named `Show` item in the contextual menu is the on-glasses recovery; a `Show` button on the phone
  plugin page is the last resort. On-glasses recovery requires `isWearing !== false`. The phone
  button may override a stuck "removed" reading after an explicit confirmation, because a failed
  wear sensor is exactly the trap the recovery exists for. If Wear Detection is on, firmware keeps
  the display off when not worn anyway. Touch swipes never restore.
- **S3. Answer to tilt-down reading.** Add: head scroll is active only when the content overflows;
  needs a clear onset from neutral; a tilt held longer than a limit (default to be set from Phase 0)
  stops scrolling, returns to the line where it began, and adopts the new pose as neutral; and a
  scroll lock toggle exists in the contextual menu.
- **S4. Notifications.** Remove the ntfy fallback from the default design. Add setup steps: Auto
  Display off (or at least the backend's topic off). Say plainly that Hidden hides this app, not the
  phone's other forwarded notifications, unless Auto Display is off (depends on H8).
- **S5. Required phone setup.** Wear Detection on (the firmware blanks on removal, which backs up the
  app). HeadUp off or high. Battery Unrestricted. Keep Silent Mode as the instant manual hide that
  needs no WebView. Note that Silent Mode cannot be read or changed by the app, and it blocks touch.
- **S6. "Continuous" scroll means repeated line steps.** Smooth pixel scrolling is not available.
- **S7. V1 is text-only on the glasses.** Hiding images would need another call and a rebuild, and
  showing the exit dialog can break image updates for the session (ASSUMPTION GH#18).
- **S8. Lock-state handling of REMOVED.** The hide must reach the glasses before re-wear. If the
  plugin is suspended when the glasses come off, it cannot blank them, and firmware may restore
  the old page on re-wear. The spec's REMOVED+worn->HIDDEN cannot be guaranteed in that case (H5).
- **S9. Personal build.** Blank screens conflict with store rules ("Never a black screen", "Every
  gesture has a visible response", VERIFIED D/ship/app-submission). State that V1 ships
  as a Beta build for personal use and is not aimed at public review.

### Questions for the user

- **Q1.** If Android reloads the plugin on every lock (H6), "never reveal after restart" makes the
  screen go blank each time the phone locks, even mid-reading. Recommended: keep the rule for V1 and
  measure how often it happens. The alternative is a short "recent VISIBLE" grace window, which
  weakens the rule.
- **Q2.** If H1 fails, is an unlocked phone acceptable, or is the reduced locked mode preferred?

## Requirements matrix

### Gesture A: tilt up, scroll up

| Requirement | Status | Evidence | Fallback |
| --- | --- | --- | --- |
| Detect head tilt up | Experimental | `imuControl` and samples VERIFIED (DTS:1436, DTS:968). Meaning EXPERIMENT NEEDED (H2) | Touch swipe scroll |
| Scroll while tilted, stop at neutral | Experimental | App timer and `textContainerUpgrade` VERIFIED. Held-tilt signal depends on H2. Timers may stall (ASSUMPTION GH#16) | Line-per-gesture stepping |
| No collision with native HeadUp | Experimental | SUP/dashboard. Behaviour with a plugin in front unknown (H7) | User turns HeadUp off |

### Gesture B: tilt down, scroll down

| Requirement | Status | Evidence | Fallback |
| --- | --- | --- | --- |
| Detect head tilt down | Experimental | As gesture A | Touch swipe scroll |
| Scroll while tilted, stop at neutral | Experimental | As gesture A | Line-per-gesture stepping |
| Not triggered by reading paper or looking at someone | Experimental | No source. ASSUMPTION that S3 gating works. Tested in Phase 1 | Scroll lock in the menu |

### Gesture C: left-right shake

| Requirement | Status | Evidence | Fallback |
| --- | --- | --- | --- |
| Detect a deliberate shake | Experimental | Depends on H2 and H3 | Menu item `Hide`/`Show`; Silent Mode for hiding |
| Toggle hide and show of all content | Supported | One `textContainerUpgrade` call (DTS:1412) writes `' '` or the stored window. Blank form VERIFIED SK/glasses-ui, H9 confirms | `rebuildPageContainer` |
| Restores exact screen and scroll position | Supported | App owns screen ID and line offset (risk 6). Firmware offset is never used, so nothing is lost | None needed |
| Shake has priority over tilt | Supported | Pure engine logic. Depends on detection above | Short tilt onset delay so a shake can claim the motion first |

### Gesture D: removal and re-wear

| Requirement | Status | Evidence | Fallback |
| --- | --- | --- | --- |
| Glasses removed means auto-hide | Experimental | `isWearing`, `onDeviceStatusChanged` VERIFIED (DTS:149, DTS:1483), FAQ promises events. Latency and locked delivery H4. Firmware blanks display with Wear Detection on (SUP/wear) | Firmware blanking; IMU stillness heuristic |
| Re-wear stays hidden until shake | Experimental | Firmware brings active features back on re-wear (SUP/wear). A plugin page may do the same, so the blank must already be on the glasses (H5, S8) | None if the plugin was suspended at removal. Silent Mode before removal |
| Gestures ignored while not worn | Supported | App gate on `isWearing`. Handles unknown as not worn for reveal | Touch is already dead off the head (SUP/wear) |

### State transitions

| Requirement | Status | Evidence | Fallback |
| --- | --- | --- | --- |
| States VISIBLE, HIDDEN, REMOVED, PROCESSING, RESULT_READY, ERROR | Supported | Pure app logic, testable without hardware | None needed |
| VISIBLE + shake -> HIDDEN | Experimental | Logic Supported; trigger depends on shake detection | Menu `Hide`; Silent Mode |
| HIDDEN + shake + worn -> VISIBLE | Experimental | Depends on shake and on IMU on a blank page (H9) | Menu `Show` (S2) |
| VISIBLE or HIDDEN + removed -> REMOVED | Experimental | H4 | Firmware blanking |
| REMOVED + worn -> HIDDEN | Experimental | H4 and H5 | Silent Mode |
| HIDDEN + AI result -> store, no reveal | Supported | App stores the result, draws nothing. Only if the plugin is running. No ntfy (risk 3) | Backend keeps it until fetched |
| HIDDEN + tilt -> ignored | Supported | App logic. HeadUp could still light the Dashboard (H7) | HeadUp off |
| VISIBLE + tilt -> scroll | Experimental | As gestures A and B | Touch swipe |
| Never reveal after reconnect | Supported | Stored state plus default HIDDEN (S1). On `isConnected()` resend the current page. Unknown what the glasses show during a Bluetooth drop | None needed |
| Never reveal after restart | Supported | Blank start page (S1). `setLocalStorage` VERIFIED. Create may return 1 after a reload, so fall back to rebuild (ASSUMPTION GH#32). See Q1 | Rebuild with blank page |

### Calibration

| Requirement | Status | Evidence | Fallback |
| --- | --- | --- | --- |
| Neutral pose capture | Experimental | Needs H2. Same technique used by a community game (ASSUMPTION CN/note) | Fixed default from Phase 0 |
| Up and down thresholds | Supported | Stored values, read by the engine. Defaults need Phase 0 | Default profile |
| Shake sensitivity | Supported | As above | Default profile |
| Smoothing | Supported | As above. Must adapt to the measured rate (H3) | Default profile |
| Cooldown | Supported | As above | Default profile |
| Scroll speed | Supported | As above. Upper limit about 4 to 5 lines a second (risk 6) | Default profile |
| Minimum gesture duration | Supported | As above | Default profile |
| User adjustable without code changes | Supported | Settings on the plugin's phone page, stored with `setLocalStorage` (DTS:1358). Needs the phone unlocked | Reset to defaults |

### Recovery

| Requirement | Status | Evidence | Fallback |
| --- | --- | --- | --- |
| Touch fallback if sensors fail | Supported | Contextual menu held by the OS (D/build/contextual-menu). Needs SDK 0.0.14, have 0.0.16. Whether a click wakes a suspended WebView is unknown | Phone `Show` button |
| Phone fallback | Supported | Plugin page in the Even app, phone unlocked | Close and relaunch the plugin; startup is blank, so use menu `Show` |
| Fallback must be deliberate | Supported | Tap, long press, then select an item (D/build/contextual-menu) | Phone button needs confirmation |
| Fallback must not fire when not worn | Supported | App gate plus firmware gate (SUP/wear). Override rule in S2 | None needed |
| App can never be trapped in hidden | Supported | Three independent paths (S2). Assumes the menu survives; re-send `menuObject` on every rebuild (D/build/page-lifecycle) | Force-quit the Even app |

### Camera

| Requirement | Status | Evidence | Fallback |
| --- | --- | --- | --- |
| Separate small camera with physical button | Experimental | G2 has no camera (VERIFIED D/build/device-apis). SL firmware for XIAO ESP32-S3 compiles but was never flashed (VERIFIED SL firmware/README.md) | Phone camera `captureImageFromCamera`, needs the phone in hand |
| Visible capture indication | Supported | SL firmware blinks the on-board LED on capture (VERIFIED SL firmware/README.md). Requirement for this project: an outward-facing LED lights during capture and no setting can disable it | None. No capture without it |
| Secure upload | Experimental | SL has HTTPS, pinned root CA, device token, idempotency key, never hardware-tested | Queue and retry |
| Upload while phone is locked in pocket | Experimental | Camera uses Wi-Fi, so it depends on the Android hotspot staying on while locked. No source. SL test C covers this | Home Wi-Fi as second network |
| No covert or exam features | Supported | Design rule, no SDK involvement | None needed |

### AI

| Requirement | Status | Evidence | Fallback |
| --- | --- | --- | --- |
| AI backend produces an answer | Supported | SL backend has mock and Anthropic providers (VERIFIED SL backend/src/providers). Never run with real hardware. No glasses dependency | Mock provider |
| Delivery to plugin | Experimental | `fetch` with whitelist and CORS VERIFIED (D/build/networking). In-flight calls stall when suspended (VERIFIED D/reference/faq), so H1 decides | Result fetched on next resume |
| PROCESSING and ERROR shown | Supported | Short status text in the same container, only when VISIBLE | None needed |
| Keep secrets off the glasses app | Supported | Provider key stays on the backend; plugin holds a client token set at runtime, never in the public repo | None needed |

### UI

| Requirement | Status | Evidence | Fallback |
| --- | --- | --- | --- |
| Short answer on the glasses | Supported | Text container, about 400 to 500 characters a screen (D/build/display) | None needed |
| Details by scrolling | Experimental | App-managed window Supported (risk 6); head trigger Experimental | Touch swipes. A non-overflowing text container may not emit swipe events (SDK-APIS section 4), so test early. If it does not, add paging items to the contextual menu |
| Long text beyond one call | Supported | App sends one window at a time, under the 2000 character limit | None needed |
| Missing glyphs handled | Supported | Unknown characters are dropped silently (D/build/display). Backend returns plain text | Replace unsupported symbols |
| Root double-tap shows exit dialog | Supported | `shutDownPageContainer(1)` (DTS:1442) | None needed |
| Audio cues | Unsupported | No speaker or audio output (VERIFIED D/build/device-apis) | Visual only. Hidden mode has no cue at all |

### Reliability

| Requirement | Status | Evidence | Fallback |
| --- | --- | --- | --- |
| Phone stays locked in pocket as a bridge | Experimental | H1. Biggest project risk | See "If H1 fails" |
| Hidden state survives suspension | Supported | Stored on change; default HIDDEN | None needed |
| Gesture and wear handling during suspension | Experimental | Cannot run if JS is frozen (H1, H6) | Firmware Wear Detection and Silent Mode |
| Reconnect after Bluetooth or network loss | Experimental | `connectType` VERIFIED. Re-arm the IMU after reconnect; whether it stays on is unknown | Resume re-arms everything |
| Duplicate WebViews do not fight | Experimental | Reported on Android (ASSUMPTION GH#16). Use a run ID, stop on exit events | Force-quit the Even app |
| Stop the IMU on exit | Supported | On events 6 and 7 (SK/handle-input). Not on 5, which the menu also fires | None needed |
| Testable without hardware | Supported | Simulator gives no IMU or status events (VERIFIED SK/test-with-simulator), so use injected samples behind the adapter | Hardware only for final tuning |

### Acceptance tests

None can pass in the simulator as written. "Harness" means injected or recorded samples in unit tests.

| Test | Status | Evidence | Fallback |
| --- | --- | --- | --- |
| 1. Scroll up | Experimental | H2, H3, H7. Harness for logic | Touch scroll |
| 2. Scroll down | Experimental | H2, H3 | Touch scroll |
| 3. Hide | Experimental | H2, H3 | Menu `Hide`, Silent Mode |
| 4. Show | Experimental | H2, H3, H9 | Menu `Show` |
| 5. Accidental activation (walking, talking, looking sideways) | Experimental | Needs recorded real motion. The rate limit in H3 may make walking hard to separate | Raise thresholds; scroll lock |
| 6. Removal | Experimental | H4 | Firmware blanking |
| 7. Re-wear | Experimental | H4, H5. Unlocked likely passes; locked is at risk (S8) | Silent Mode |
| 8. Camera-to-AI | Experimental | Hardware path never run (SL). Needs H1 if the phone is locked | Phone unlocked |
| 9. Hidden AI result | Supported | Logic only, if the plugin is running and ntfy is removed. H8 for other notifications | Backend holds the result |
| 10. Connectivity recovery | Experimental | Glasses behaviour during a drop unknown | Resume path |
| 11. Competing gestures | Experimental | Priority logic Supported in harness; real overlap needs hardware | Longer tilt onset |
| 12. Locked phone | Experimental | H1, on a Beta build only | See "If H1 fails" |

## Recommended order of work

1. Phase 0 raw logger as a Beta build: IMU, status events, run ID, sent to the backend. Answers H1 to H4, H6.
2. Decide using the results. Stop and talk to the user if H1 or H2 fails.
3. Meanwhile, build the state machine, adapter, app-managed scroll and harness. None of it depends on
   Phase 0 results.
4. Tune against recorded real motion, then run the 12 acceptance tests on hardware.
