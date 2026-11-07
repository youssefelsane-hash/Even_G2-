# Hardware tests

Ordered checklist for the physical G2 glasses and the Android phone. Date: 2026-11-07. **None of these has been
run.** Pass numbers are proposals, labelled ASSUMPTION as a group. Sources and labels are defined in
[SDK-APIS.md](SDK-APIS.md).

Do the tests in order. HT-1 to HT-4 are gate G0 in [PLAN.md](PLAN.md): stop after them and decide before doing
anything else. HT-1 comes first because it is cheap and everything else needs its answer. HT-4 is the test most
likely to change the project, so aim to reach it on day one. The camera study calls this test C1 and says to run it
first. It stays second in practice only because its data means little until HT-1 to HT-3 show that samples are usable.

Mapping to earlier studies: H numbers are from [FEASIBILITY.md](FEASIBILITY.md), C numbers from
[CAMERA-AND-BACKEND.md](CAMERA-AND-BACKEND.md).

## Results sheet

Fill this in as you go. Keep it outside the public repo if it holds anything personal.

| Test | Date | Phone, Android, Even app, firmware | Result | Decision taken |
| --- | --- | --- | --- | --- |
| HT-1 Blank, IMU, shake restore | | | | |
| HT-2 x/y/z meaning | | | | |
| HT-3 Sample rate | | | | |
| HT-4 Locked phone | | | | |
| HT-5 Wear reporting | | | | |
| HT-6 Re-wear flash | | | | |
| HT-7 HeadUp collision | | | | |
| HT-8 Notifications over Hidden | | | | |
| HT-9 Recovery paths | | | | |
| HT-10 Touch and scroll | | | | |
| HT-11 Real motion false triggers | | | | |
| HT-12 Battery and link cost | | | | |
| HT-13 Connection loss | | | | |
| HT-14 Hotspot and camera join | | | | |
| HT-15 Capture quality and latency | | | | |
| HT-16 LED visibility | | | | |
| HT-17 Hidden end to end | | | | |
| HT-18 Acceptance run | | | | |

## Before you start

### Record the baseline

Write down: phone model, Android version, Even app version, glasses firmware, app version from `app/app.json`.
Any change to these later can invalidate a result, so re-run HT-1 and HT-4 after an update.

### Phone and glasses settings for Phase 0

Unless a test says otherwise:

- Wear Detection: on.
- HeadUp: off. HT-7 turns it on.
- Auto Display: off. HT-8 turns it on.
- Even app battery: Unrestricted. HT-4 also runs without it.

### Install

Two install modes, and the difference matters:

| Mode | Use for | Why |
| --- | --- | --- |
| Local Testing (QR) | HT-1 to HT-3 and other unlocked tests | Fast. "dies the moment the phone locks". VERIFIED D/test/local-testing |
| Beta build | HT-4 and every locked test | Behaves "identically to a published app". No Even review. VERIFIED D/test/beta-testing |

A Private build is no use for lock tests: it does not pass the 5-minute lock test. VERIFIED D/test/private-testing.

**Local Testing.** `npm run dev` binds to 127.0.0.1, which the phone cannot reach. Use this instead, on a trusted
network only, with the laptop and phone on the same Wi-Fi:

```bash
cd app
npm install
npx vite --host 0.0.0.0 --port 5174 --strictPort
# in a second terminal
npx evenhub qr --url http://<laptop-ip>:5174
```

Scan the QR code in the Even app.

**Beta build.** Run `npx evenhub login` yourself first. It asks for a password. VERIFIED SK/build-and-deploy.

```bash
cd app
npm run build
npx evenhub pack app.json dist -o g2-assistant.ehpk
npx evenhub create g2-assistant.ehpk --name "G2 Assistant" --tagline "Personal assistant prototype"   # no --icon: a placeholder is used, which is fine for a personal Beta
npx evenhub testers add <your-email>
npx evenhub promote 0.1.0 --to beta
npx evenhub ls com.evenassistant.glasses                  # CHANNEL must read beta
npx evenhub testers --package-id com.evenassistant.glasses  # you must read Active
```

Accept the invitation email, then in the Even app go to Me, Beta tester, and tap Install. For later versions, raise
`version` in `app.json` and use `npx evenhub upload g2-assistant.ehpk -m "<what changed>"`, then promote the new
version. These commands were checked against the CLI help, not run: no one was signed in, and only `evenhub pack`
has been tried.

### Known limits of the current build

Read these first. They affect how the tests are run.

| Limit | Effect | Workaround today |
| --- | --- | --- |
| App starts HIDDEN and needs a restore before anything shows | You see a blank lens at first, which is correct | Reveal with 4 presses, or 4 taps on the panel's `Touch press` |
| Logger must be started by hand, and **a reload stops it** | After a reload on lock, nothing more is recorded | Compare `Boots recorded`, and read `Log from earlier session` |
| `Start` **clears the log** | Pressing Start again loses the previous run | Export before each new Start |
| Log tail saved for reload analysis is the last 3000 rows, every 5 s, to browser storage | Covers about 5 minutes at 10 samples a second. Browser storage may not persist. SDK-APIS discrepancy 6 | Enough to see when logging ended |
| No network permission | No heartbeat to a server, so long-poll survival cannot be tested yet | Needs L4 below |
| `imuControl` result and create result go only to the console | Not visible on the phone | Panel shows `IMU: no data` if nothing arrives. L2 fixes it |
| No `Talking`, `Reading` or `Hidden` mark buttons | | Use the nearest mark and keep paper notes, or add L3 |
| No contextual menu, no phone `Show` | HT-9 can only test the press pattern | Needs L5 |
| Simulator tools are in the build | `Answer arrives` is useful on hardware. **Do not press `Worn`, `Removed` or `Disconnect` in a test**: they inject fake events | |
| The app restarts the IMU by itself | On foreground, after reconnect, and every 10 s while the sensor is lost. A stop that recovers shows as a gap, not as a stop. Each restart goes only to the console | Compare gaps in the log. L2 should show restarts on the panel |

### Instrumentation to add before HT-4

These are the only code changes in Phase 0. They are not done yet. HT-1 to HT-3 can run on the current build.

| ID | Change | Needed for |
| --- | --- | --- |
| L1 | Restart logging automatically after a reload, with a random run ID per load | HT-4, so that a reload does not end the data |
| L2 | Show `imuControl` results, including automatic restarts, create result and launch source on the panel | HT-1, HT-4 |
| L3 | Add `Talking`, `Reading` and `Hidden` marks | HT-2, HT-11 |
| L4 | Heartbeat to a small HTTPS endpoint every 30 s with run ID, sample count and state, plus a `network` permission with `whitelist` in `app.json` | HT-4 stage D. Must never send answer text |
| L5 | Contextual menu, phone `Show`, and a `Stop IMU` button | HT-9 |

## Raw IMU logger procedure

The logger is in the phone panel under "Raw IMU logger (Phase 0)". It records exactly what arrives, with
wall-clock arrival time, plus marks, wear, connection and state changes. VERIFIED `app/src/core/imuLogger.ts`.

**Basic run:**

1. Open the plugin from the Even app, so the panel is on the phone.
2. Check the status block: `Bridge: true`, `Wear: worn`, and an `IMU:` rate rather than `no data`. If there is no
   data, press `Restart IMU`.
3. Press `Start`.
4. Press a mark button just **before** each action, for example `Tilt up`, then do it. Have a second person press
   marks if you can, so your head stays still.
5. Press `Stop`. The summary appears: `samples`, `meanHz`, `dtP50`, `dtP95`, `dtMax`, `gapsOver1s`, `discarded`, and
   min, max and mean of each axis.
6. Press `CSV`. If the WebView blocks the download, copy from the text box under the buttons.
7. Name the file `imu-log-<test>-<date>.csv`. These names are ignored by git. Do not commit logs.

CSV columns are `t_ms,x,y,z,note`. A row has either a sample or a note. `t_ms` is arrival time, not sensor time, so
samples arriving in batches look like jitter. The panel's `batched` counter shows how often that happens.

**Changing the pace:** Settings, Advanced JSON, change `imuPace` (100 to 1000 in steps of 100), `Save JSON`, then
`Restart IMU`. Check the rate changes. If it does not, the host may need `imuControl(false)` first, so close and
reopen the plugin. Settings are kept.

**Capture script for HT-2.** Sit upright. Hold each pose for the stated time and return to neutral between actions.
Do each action 3 times.

| Mark | Action | Time |
| --- | --- | --- |
| Still | Look straight ahead | 20 s |
| Tilt up | Raise chin about 20 degrees, hold | 5 s |
| Tilt down | Lower chin about 20 degrees, hold | 5 s |
| Turn left | Turn head left about 30 degrees, hold | 5 s |
| Turn right | Turn head right about 30 degrees, hold | 5 s |
| Shake | Left-right, 3 or 4 swings, firm but comfortable | 2 s |
| Note on paper | Roll: ear towards shoulder, each side | 5 s |

Stop if your neck is uncomfortable. Do walking tests only somewhere safe.

## Phase 0 tests (gate G0)

### HT-1. Blank display, IMU still flowing, shake restores

**Answers:** H9, part of H2, risk 7. Does a blank page keep the IMU alive, and can a shake bring content back?
**Build:** Local Testing. **Time:** about 1 hour.

Steps:

1. Launch. The lens must be dark, because every start is blank.
2. **Stage A, IMU on blank.** Look at the panel. Note the `IMU:` rate and whether `samples` is rising. Start the
   logger, stay still 60 s, stop, export. Note `Wear:` too. Shake works only when it reads `worn`. If it reads
   `removed` or `unknown` with the glasses on, turn off "Trust the wear sensor" for now and flag it for HT-5.
3. In a dark room, look at the lens. Note any lit pixels, border or glow.
4. **Stage B, visible comparison.** Press `Answer arrives`, then tap `Touch press` 4 times to reveal. Log 60 s with
   content showing, then compare the rate with stage A.
5. **Stage C, calibrate.** Open Calibration, press `Start`, follow the four steps, then `Accept`. Note the proposed
   mode, axes and any error message. Save the proposal text.
6. **Stage D, shake.** Scroll a few lines by tilt or swipe and write down the line range in the header. Shake to
   hide. Shake to show. Do this 10 times each way.
7. **Stage E, long blank.** Hide, then wait 30 minutes with the logger running. Do not touch anything. Then shake.
8. On the blank page, press the touchpad 4 times to test touch events on blank.

Record: IMU rate on blank and visible, `gapsOver1s`, `dtMax`, lit pixels seen, wizard proposal, shakes detected out
of 10 each way, whether the line range matched, whether the display or IMU slept during stage E, presses recognised.

**Pass:** blank is dark. Rate on blank is at least 80% of the rate on visible. No gap over 2 s in stage E. At least 9
of 10 shakes work each way. Every restore shows the same line range.

| Result | Decision |
| --- | --- |
| Pass | Keep the blank-page design. Go to HT-2 |
| No IMU on either page | Try other paces and relaunch. If still nothing, IMU gestures cannot be built: stop, report to Even, and take the touch-only option at G0 |
| IMU on visible, not on blank | Use a minimal dim marker as the "blank" page and retest, or restore by menu only. The owner must accept the changed meaning of blank |
| IMU stops after a time on blank (stage E) | Note the time. The app already retries `imuControl` every 10 s while the sensor is lost, so check whether that brought it back. Retest |
| IMU flows, wizard or shake fails | Not a blank-page problem. Go to HT-2 and HT-3 to find out why |
| Lens not fully dark | Find what is lit. If it cannot be removed, record it as a limit |
| Touch dead on blank | Press pattern cannot work. Menu `Show` becomes essential (HT-9) |

### HT-2. What x, y and z mean

**Answers:** H2, risk 1. **Build:** Local Testing. **Time:** about 1 hour.

Steps:

1. Run the capture script above at the default pace.
2. For each action, find which axis moves, the sign, and the size.
3. Check what happens during a hold.
4. Check the scale: turn your head or the glasses slowly through about 90 degrees and see if a value changes by a
   round number such as 90 or 1.57. The IMU may stop when the glasses are off the head, which is itself worth noting.
5. Repeat Still for 5 minutes to measure drift.

Record: axis per motion, sign, size, value during hold, noise on Still (standard deviation), drift over 5 minutes, any
wraparound near a limit, any axis often missing.

Read the data with this table:

| What you see | Meaning | Decision |
| --- | --- | --- |
| Value moves and **stays** during a hold, on separate axes for pitch and yaw | Orientation angles. Best case | Use `orientation` mode. Keep the spec gestures |
| Value spikes and **falls back** during a hold | Rate (gyroscope) | Use `rate` mode. Held tilt is integrated and will drift, so test re-zeroing at neutral. Scroll may need to become "one nod, one step" |
| Pitch and roll hold a value, total stays near 1 g or 9.8, **yaw barely changes** | Accelerometer only | Pitch works. Shake must be redesigned: try a roll shake or a double nod. **Changes the spec, needs owner approval** |
| Mixed or noisy, no clear axis | Unknown fusion | Ask Even through the plugin repo or Discord. Try more paces |

**Pass:** one axis tracks pitch and holds or integrates well, and a left-right shake shows at least 3 clear swings
well above Still noise (at least 5 times the standard deviation, the wizard's own test).

If this passes, set the adapter by wizard and go to HT-3. If it fails, change the gesture before tuning anything.

### HT-3. Sample rate per pace

**Answers:** H3. **Build:** Local Testing. **Time:** about 1 hour.

Steps:

1. For each pace code 100 to 1000: set it, restart the IMU, log 60 s still, then 3 shakes.
2. Note the `Stop` summary each time. Export before the next `Start`.
3. Pick the best code and log 10 minutes of normal movement.

Record per code: `meanHz`, `dtP50`, `dtP95`, `dtMax`, `batched`, whether shakes show clear swings. Note which direction
the codes run. They are not Hz. VERIFIED D/build/device-apis.

**Pass:** a code gives at least 15 samples a second with `dtP95` under 150 ms. At least 10 a second is the minimum.
Synthetic detection was 100% at 15 Hz, 98.0% at 10 Hz, 88.3% at 7 Hz, 60.3% at 5 Hz. VERIFIED only as output of `npm run
report`, and the motion models are guesses.

| Result | Decision |
| --- | --- |
| 15 or more | Use that pace. Check battery in HT-12 |
| 10 to 15 | Usable. Use the lowest smoothing that works, and retest shake |
| 7 to 10 | Shake is marginal. Slow the gesture: fewer, wider swings. Offer the menu as the normal hide |
| Under 7 | Shake is not reliable. Tilt may still work. Make the shake optional, and ask the owner |

### HT-4. Locked phone

**Answers:** H1, H6, C1, risk 2. This is the largest project risk. **Build:** Beta only, with L1 and L2 at least.
Any result on Local Testing or Private means nothing. **Time:** most of a day, mostly waiting.

Start each stage from the Even app with the panel open, IMU flowing, logger running. Press the `Phone locked` mark,
then lock the phone and put it in a pocket. Keep wearing the glasses and move normally.

| Stage | Duration | Condition |
| --- | --- | --- |
| A | 5 minutes | Battery Unrestricted. Phone on a table |
| B | 30 minutes | Battery Unrestricted. Phone in pocket |
| C | 60 minutes, 3 runs | Battery Unrestricted. Phone in pocket |
| D | 60 minutes | As C, with L4 heartbeat and a pending long-poll |
| E | 30 minutes | Battery setting at its default, to see whether it matters |
| F | 30 minutes | Phone unlocked with the screen on, Even app in the background. Separates "backgrounded" from "locked" |

During each locked period, at noted times, do 5 shakes and 5 tilts and note what the lens does. Start visible,
so you can see the effect.

After unlocking, before anything else:

1. Note `Boots recorded` compared with before, and whether the logger is still recording.
2. Press `Phone unlocked`, `Stop`, export. Press `Log from earlier session` and save that too.
3. Note how long the panel took to respond, and whether the lens was blank or showing content.

Record: for each stage, the sample count, `gapsOver1s`, `dtMax`, reload count, last sample time before any gap, what
shakes did while locked, whether the IMU needed re-arming, create result after reload, heartbeat gaps (stage D).

**Pass (full):** in stages B to D, no IMU gap over 5 s, rate at least 80% of unlocked, no reloads, 9 of 10 locked shakes
work. **Partial:** samples continue, with gaps of 5 to 60 s, or reloads that recover by themselves. **Fail:** samples stop
for more than 60 s, or do not return until unlock.

| Result | Decision |
| --- | --- |
| Full pass | Spec works as written. Go on to Phase 1 |
| Reloads but recovers | Works, but the lens blanks on each lock. Owner decides Q1 |
| Frozen with battery default, fine with Unrestricted | Make Unrestricted a hard setup requirement |
| Gaps of 5 to 60 s | Measure the cause, then decide if gestures are acceptable with that lag |
| Fail | **Stop.** Owner chooses an option at gate G0 in [PLAN.md](PLAN.md). Do not buy camera parts or start the backend |

## Phase 1 tests: gesture behaviour

### HT-5. Wear reporting

**Answers:** H4, and the SDK finding that a missing `isWearing` becomes `false`. **Build:** Local Testing, then Beta for
locked runs. **Time:** 2 hours.

Steps:

1. Logger on. Remove and re-wear 50 times, with marks, phone unlocked. Vary the speed.
2. Repeat 20 times with Wear Detection off.
3. Repeat 20 times on Beta, phone locked.
4. Leave the glasses on for 30 minutes without removing them. Look for any `wear` note with no real change, such as
   on a battery update. Then put them on charge or in the case and note what arrives.

Record: delay from mark to the `wear` note, missed events, false `removed` notes, whether `false` arrives or is just
missing, behaviour with Wear Detection off.

**Pass:** at least 19 of 20 detected within 2 s. No false `removed` in 30 minutes.

| Result | Decision |
| --- | --- |
| Pass | Keep the design |
| False `removed` from partial updates | Require 2 consecutive reports or a short confirm time before REMOVED. Accept unwanted hides only if rare |
| Wear never reported | Turn off "Trust the wear sensor", rely on firmware blanking, drop auto-hide from the app, and consider IMU stillness |
| Slow, over 2 s | Firmware blanks first anyway. Check it with HT-6 |
| Fails only when locked | Same cause as HT-4. Accept firmware blanking only |

### HT-6. Stale content on re-wear

**Answers:** H5, S8. Privacy test. **Build:** Beta. **Time:** 1 hour.

Steps:

1. Unlocked: show text, remove the glasses, wait 10 s, re-wear while watching the lens closely. 20 times.
2. Also try a quick removal and re-wear within 1 s, 10 times.
3. Locked 10 minutes, showing text: remove, wait, re-wear. 10 times.
4. If HT-4 found the plugin freezes, repeat step 3 and watch for the old page.

Record: any flash of content, how long, and what state the panel shows afterwards.

**Pass:** 0 flashes and the lens stays dark until a restore action.

| Result | Decision |
| --- | --- |
| Pass | "Re-wear stays hidden" holds, in the tested conditions |
| Flash only on very fast re-wear | Record as a limit. The blank is racing the firmware |
| Old page returns when frozen | Expected risk. SPEC section 8 applies. Owner accepts it, or adopts "hide before removing" or Silent Mode as a habit |

### HT-7. HeadUp collision

**Answers:** H7, risk 4. **Build:** Local Testing. **Time:** 30 minutes.

Steps:

1. Note the HeadUp setting. Turn it on at the default angle.
2. With text showing, tilt up past the threshold and past the HeadUp angle, 10 times.
3. Repeat on the blank page.
4. Set the HeadUp angle well above `tiltMaxDeg`, repeat.
5. Turn HeadUp off, repeat.

Record: whether the Dashboard appears, whether the plugin keeps focus, whether IMU samples keep arriving, whether
scrolling still works, and whether the plugin page returns.

**Pass:** with the chosen setting, no Dashboard during scrolling, and none in Hidden.

| Result | Decision |
| --- | --- |
| No effect while plugin is in front | HeadUp can stay on. Recommend off for Hidden anyway |
| Fires only on blank | Required setting: HeadUp off, or Hidden has a known hole |
| Takes focus from the plugin | Required setting: HeadUp off |
| Fires even when off | Remove tilt-up scroll, keep tilt-down and touch, and ask the owner |

### HT-8. Notifications over Hidden

**Answers:** H8, C2, risk 3. **Build:** Local Testing. **Time:** 30 minutes.

Send a test message from another app to the phone, in each cell:

| Plugin | Auto Display on | Auto Display off |
| --- | --- | --- |
| Showing text | | |
| Blank | | |
| Glasses off, then re-worn | | |

Then look in the Even Notification Center, and check whether "Don't disturb other features" helps. Whether an Even
Hub plugin counts as a full-screen feature is unknown. EXPERIMENT NEEDED.

Record: what appears on the lens in each cell, and for how long.

**Pass:** with Auto Display off, nothing appears on the lens in every cell.

| Result | Decision |
| --- | --- |
| Pass | Keep Auto Display off as required setup |
| Still appears | Hidden cannot cover notifications. State the limit. Turn off forwarding for specific apps. ntfy stays out for good |

### HT-9. Recovery paths

**Answers:** risk 8. **Build:** Local Testing for press pattern. Beta with L5 for the rest. **Time:** 1 hour.

Steps:

1. Press pattern: 4 presses in 3 s from blank, 10 times. Then brush the touchpad while adjusting the glasses, 20
   times, and note accidental reveals.
2. With the glasses off, press the pattern. It must not reveal.
3. Contextual menu on the blank page: tap, long press. Note what the lens shows and whether IMU samples continue
   while it is open. Select `Show`. Do it 10 times.
4. Repeat step 3 with the phone locked. Does a click reach the plugin?
5. Check the system `Display off` slot and `Close [app name]`.
6. Phone `Show`: confirm step works and it is refused while `removed`.
7. Silent Mode: hold both touchpads about 1 second while text shows. Does it blank? How does it end, and what shows
   afterwards? Try with the phone locked.
8. Stop the IMU with the `Stop IMU` button (part of L5), then confirm a recovery path still works with no samples.
9. Also try raw long press alone and note any firmware menu. EXPERIMENT NEEDED per SDK-APIS section 5.
10. Duplicate check: with the logger on, press once at a time from blank, 10 times, slowly. If one press ever counts
    as two, the pattern needs a debounce. SDK-APIS section 5.
11. Exit dialog: with text showing, double press, then choose "No". Note what the lens shows. The prototype does not
    rebuild the page here, so text may be lost until the next update. SDK-APIS section 5.

Record: success rate for each path, locked and unlocked, accidental fires, what lights the lens.

**Pass:** at least one on-glasses path works 10 of 10, with the IMU silent. 0 accidental reveals. None fire off the head.

| Result | Decision |
| --- | --- |
| Menu works, locked too | Menu is the recovery. Remove the press pattern |
| Menu works only unlocked | Keep the press pattern too, if it is not accident-prone. Silent Mode for locked hiding |
| Press pattern fires by accident | Remove it, or raise `recoveryPresses` |
| No on-glasses path works | Phone `Show` is the only recovery. State the limit |

### HT-10. Touch and display scrolling

**Answers:** risk 6, SDK-APIS discrepancy 13. **Build:** Local Testing. **Time:** 30 minutes.

Steps:

1. Press `Answer arrives`, reveal. Swipe forward and back on each temple, 10 times. Does the app see swipes on a
   container that does not overflow?
2. Check firmware never scrolls the text itself: the header line must stay at the top.
3. Tilt-scroll at 2, 3, 4, 5 and 8 lines a second. Note flicker, lag and missed updates.
4. Check 10 lines fit without clipping, on real firmware. Check German letters if available.

Record: swipes seen out of 10, fastest clean scroll speed, how many lines fit, what the eye sees during an update.

**Pass:** swipes work, and scrolling at 3 lines a second is readable, with no firmware scroll.

| Result | Decision |
| --- | --- |
| Pass | Keep the design. Set the speed cap to the measured value |
| Swipes not delivered | Add `Page up` and `Page down` to the menu. Or let text overflow by one line to trigger events, then retest |
| Scrolling hard to read | Slower default, or step a half screen per tilt |
| Lines clipped | Reduce `TOTAL_LINES` |

### HT-11. Real motion and false triggers

**Answers:** risk 5, acceptance tests 5 and 11. **Build:** Beta with calibrated settings and L3. **Time:** half a day,
across real activities.

Log each with the phone unlocked first, then in a pocket once HT-4 passes:

| Activity | Duration |
| --- | --- |
| Walking indoors and outdoors | 30 minutes |
| Talking with someone, including nods and "no" | 30 minutes |
| Looking sideways, checking traffic safely, turning to people | 15 minutes |
| Reading a paper on a desk, looking down, looking up at someone | 15 minutes |
| Stairs, sitting down, standing up | 10 minutes |
| Deliberate shake during a tilt, and shake while walking | 20 each |

Steps:

1. Keep text showing. Keep paper notes of real events.
2. Count false hides, false scrolls, and real gestures that were missed.
3. Save all logs. Replay them through the engine with the replay tool (Phase 1 work) and tune settings against
   them, not against synthetic motion.

**Pass:** the rules for acceptance tests 5 and 11 in SPEC section 13.

| Result | Decision |
| --- | --- |
| Pass | Freeze the defaults |
| False hides while talking | Expected weak spot. Raise amplitude or add a swing. Retest detection |
| False scrolls when reading | Shorter hold limit, tighter entry time, or default the scroll lock on |
| Too many missed gestures after tuning | Accept touch as the main scroll, and keep head scroll optional |
| Roll-back at the hold limit feels wrong | Decide D5 the other way |

### HT-12. Battery and link cost

**Answers:** H10. **Build:** Beta. **Time:** 2 hours running, twice.

Steps: run 2 hours with the IMU at the chosen pace and the phone locked, then 2 hours with the plugin closed. Note
glasses and phone battery percentages, phone temperature, and bridge call failures.

**Pass:** at least 4 hours of use from a full charge, by extrapolation. ASSUMPTION: owner to confirm the target.

If it fails, use a slower pace. Stopping the IMU while Hidden would save more, but then a shake cannot restore and only
the menu can. That trade-off is the owner's.

### HT-13. Connection loss

**Answers:** acceptance test 10. **Build:** Beta. **Time:** 1 hour.

Steps, each 5 times, from VISIBLE and from HIDDEN:

1. Turn phone Bluetooth off for 30 s, then on.
2. Walk out of range for 2 minutes, then return.
3. Turn off mobile data for 2 minutes during a long-poll.
4. Close the Even app and reopen it.
5. Restart the phone.

Record: what the lens shows during the drop, what it shows after, whether the IMU comes back without help, time to
working again. The app restarts the IMU after a reconnect and retries while the sensor is lost.

**Pass:** no reveal in any case. Working within 30 s of reconnect.

| Result | Decision |
| --- | --- |
| Pass | Done |
| Lens keeps content during a drop | Record as a limit. The blank cannot be sent without a link |
| IMU does not resume | The automatic re-arm is not enough. Check the console for `imuControl` results, then try closing and reopening the plugin |

## Phase 3 tests: camera and full path

These need camera hardware and the backend. Details in [CAMERA-AND-BACKEND.md](CAMERA-AND-BACKEND.md) section 13.

### HT-14. Hotspot and camera join

**Answers:** C3, C4, C5, C8.

Steps:

1. Set the hotspot per SPEC section 2. Check the 2.4 GHz and WPA modes the phone offers.
2. Join from the camera 10 times, awake and from deep sleep. Note time to HTTP 202.
3. Leave the hotspot on 8 hours, phone locked, camera asleep in long gaps, with and without Battery Saver. Note drain.
4. Log the IMU rate while uploading repeatedly (C8): the hotspot and Bluetooth may share a radio. ASSUMPTION.

**Pass:** joins every time in under 5 s, under 6 s from press to 202 from sleep, IMU rate drops less than 10%.

If it fails: try other security modes. If the hotspot cannot stay up locked, build the BLE companion (Phase 5). If the
IMU rate drops, use smaller images.

### HT-15. Capture quality, power and latency

**Answers:** C6, C7, C9, C11.

Steps:

1. Capture 20 printed pages at 25 to 40 cm, hand-held and clipped. Compare OV5640 autofocus with OV3660 if you have both.
2. Run 50 captures at low charge on 150, 300 and 500 mAh cells. Look for brown-outs.
3. Run the 50-capture plan: 10 each of unlocked, locked on table, locked in pocket, camera at 10 m, hotspot dropped
   for 30 s. Note the time per hop. Include German text and check letters render.

**Pass:** 18 of 20 pages legible to the AI. No brown-out in 50. 10 of 10 per condition, median under 15 s, no duplicates.

If it fails: larger sensor or another device, larger cell, or the levers in CAMERA-AND-BACKEND section 8.

### HT-16. LED visibility

**Answers:** C10. This is a requirement, not a preference.

Steps: ask someone at 2 m, in daylight and indoors, to say when the camera captures. 10 times each. Try covering the
LED with a finger without covering the lens.

**Pass:** seen every time. LED cannot be covered without covering the lens.

If it fails: brighter LED or better placement. **Do not use the camera until it passes.**

### HT-17. Hidden end to end

**Answers:** C14, acceptance test 9. Release blocker.

Steps:

1. Shake to Hidden.
2. Press the camera. Confirm the LED lights and the lens stays dark.
3. Wait for the result. Check the backend shows `receivedAt` but no `displayedAt`.
4. Restart the backend. Restart the phone. Remove and re-wear the glasses. Watch the lens each time.
5. Shake. The answer appears.
6. Repeat 10 times, including with the plugin frozen if HT-4 found that it freezes.

**Pass:** nothing on the lens until the shake, 10 of 10.

If it fails: release blocker. Fix before any further use.

### HT-18. Acceptance run

Run all 12 acceptance tests in SPEC section 13, on a Beta build, in a single sitting. Record pass or fail for each,
with the logs.

**Pass:** all 12, or a written owner decision for any that is accepted as a limit. This is gate G4.
