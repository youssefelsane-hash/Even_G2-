# External camera, connectivity and AI backend

Study date: 2026-11-07. Nothing here has been tested on real hardware.

> **Read this first (updated 2026-11-08).** This was the first study, written before anything was built. Parts of it
> are now replaced:
>
> - **Camera choice and capture:** the camera is no longer ESP32-only or single-photo. See
>   [CAMERA-HARDWARE-EGYPT.md](CAMERA-HARDWARE-EGYPT.md) (boards, prices, shopping lists) and
>   [CAPTURE-STRATEGY.md](CAPTURE-STRATEGY.md) (burst, clip, multi-page, scoring, retakes, fusion prompt).
> - **API:** the built contract is [API.md](API.md).
> - **Spec:** [SPEC-V0.3.md](SPEC-V0.3.md) wins where it differs, for example no ntfy at all in V1 and the label set.
> - **Built:** the backend (`backend/`), the Linux camera client (`camera/linux`), ESP32 firmware (`camera/esp32`,
>   never compiled) and the glasses app. The four Study Lens faults listed here (ntfy bypasses Hidden, images never
>   deleted, idempotency race, results drawn at cold start) are fixed in the new code; Study Lens itself is unchanged.
>
> Still current here: connectivity (sections 4-6), Hidden mode reasoning (section 7), latency budget (section 8,
> ESTIMATE), security and retention (section 9), German recording rules (section 11) and the experiments (section 13).
> Statements below that the newer documents replace are marked "(superseded)".

Claim labels used in this document:

- **VERIFIED**: read in a source listed at the end, shown as [S1], [S2], and so on.
- **EXPERIMENT NEEDED**: only a real-device test can settle it. C-numbers refer to section 13.
- **ASSUMPTION**: my reasoning or general knowledge, not confirmed.
- **ESTIMATE**: an assumption stated as a number. No device has measured it.

"Study Lens" is the earlier proof of concept. Its code has only run against the simulator
and automated tests, and its firmware has never been flashed to a board [S1].

---

## 1. Recommendation

1. **(superseded: see CAMERA-HARDWARE-EGYPT.md)** **Camera: Seeed XIAO ESP32-S3 Sense, reusing the Study Lens firmware with changes.** It is
   the smallest board found that has camera, Wi-Fi, BLE, battery charging and 8 MB PSRAM
   together [S2]. Add a 300-500 mAh LiPo, an outward-facing LED, a shutter button and a real
   power switch.
2. **Size like a watch, but do not look like one.** A complete unit is about
   45 x 32 x 22 mm (ESTIMATE), with a visible lens and LED. German law bans covert recording
   devices disguised as everyday objects, so a camera shaped like a watch is a legal risk
   (section 11).
3. **Connectivity: phone Wi-Fi hotspot first, home Wi-Fi second.** Both already work in the
   firmware design. Hotspot auto-off must be disabled and the band set to 2.4 GHz.
4. **No native Android companion for version 1.** A companion cannot draw on the glasses and
   cannot wake the plugin. It solves only the camera-to-internet hop, so it is built only if
   the hotspot fails its tests (C3, C4). Then the path is BLE from the camera to a foreground
   service.
5. **Result delivery: the plugin long-polls the backend, and that is the only path that writes
   to the lens by default.** Whether it survives a locked phone is unknown, and it is the same
   question as the gesture engine (risk 2). Run C1 first. If C1 fails, no choice in this
   document rescues the product as specified, and section 6 lists the options.
6. **(superseded: V1 has no ntfy at all, SPEC section 10)** **Hidden mode: the ntfy fallback must not reach the lens by default.** Turn ntfy forwarding
   off in the Even app, so the phone only buzzes. A lens fallback exists as a later opt-in, and
   only when the last known state is VISIBLE (section 7). Study Lens's fallback logic as
   written would break Hidden mode in three separate ways.
7. **AI: keep the Study Lens worker with `claude-opus-5-5`, change the answer format** to a
   short answer plus scrollable detail with a label computed by the backend (section 10).
   Images are deleted as soon as a job finishes.

Rough budget: EUR 30-80 for hardware, EUR 4-8 per month for a server, and a few cents per
capture for AI (all ESTIMATE, section 3).

---

## 2. Camera options

| Option | Size and battery | Connectivity | Good | Bad | Verdict |
| --- | --- | --- | --- | --- | --- |
| **XIAO ESP32-S3 Sense** | 21 x 17.8 x 15 mm board [S2]; add own LiPo | 2.4 GHz Wi-Fi, BLE 5 [S2] | Smallest; charger on board; SD slot; U.FL antenna; Study Lens firmware compiles for it [S1] | Bare board, needs an enclosure; 3 mA deep sleep with camera, not the 14 uA of the bare board [S2][S3]; runs hot under load [S2] | **Pick** |
| M5Stack Timer Camera X | 48 x 24 x 15 mm, 15 g, 140 mAh built in [S4] | Wi-Fi, BLE (original ESP32) | Already enclosed, no soldering | Older chip; fixed focus; no shutter button confirmed; one EU reseller has retired it [S4] | Backup if soldering is not an option |
| LILYGO T-SIMCam | Larger; mPCIe socket [S5] | Wi-Fi, BLE, optional 4G | One board with LTE | Not wearable size; modem power | Reject for v1 |
| CamThink NE101 (Cat-1) | Module housing [S6] | Wi-Fi, optional Cat-1 | Open source, low-power design | Built as a fixed sensor; no measured runtime found [S6] | Reject for v1 |
| Waveshare ESP32-S3 A7670E | About 110 x 30 mm with 18650 holder [S5] | Cat-1, GNSS | Cheap LTE | Too big [S5] | Reject |
| Unihertz Jelly Star (tiny phone) | 49.6 x 95.1 x 18.7 mm, 116 g, 2000 mAh [S7] | LTE, Wi-Fi, BLE | Real autofocus camera, real OS, own modem | Second SIM; much larger; not a "tiny camera" | Keep in mind if ESP32 image quality fails C7 |
| Phone camera via `captureImageFromCamera()` | No extra hardware [S8] | Phone | Tests the whole AI path today | Phone must come out of the pocket, so it breaks the hands-free goal | **Use for early AI tests only** |

Sensor warning: the Sense has shipped with OV2640, OV3660 and OV5640. Seeed's page says the
current module is OV5640 with autofocus, that boards may ship with either OV5640 or OV3660, and
that OV2640 is discontinued [S2]. VERIFIED. An add-on OV5640 module is sold separately [S9].
Several retailers still say OV2640 or OV3660 may ship (re-checked 2026-11-08, CAMERA-HARDWARE-EGYPT.md [E31]), so
ask the seller.
The firmware's autofocus path has never been compiled [S1]. VERIFIED. Autofocus may matter a
lot for reading a page at 25-40 cm (EXPERIMENT NEEDED, C7).

### Packaging and battery reality

Current figures below are Seeed's numbers for the Sense with camera [S2]. VERIFIED.
Everything computed from them is an ESTIMATE at 80 % usable capacity.

| Mode | Current | 250 mAh lasts | 400 mAh lasts |
| --- | --- | --- | --- |
| Always on, Wi-Fi in modem sleep (Study Lens firmware today) | 44 mA or more | about 4.5 h | about 7 h |
| Deep sleep, 20 captures a day, stay-awake time ignored | 3 mA, plus about 0.5 mAh per capture | about 2.4 days | about 3.9 days |
| Deep sleep, 20 spread-out captures, each with its own 5-minute stay-awake window at 44 mA | As above, plus about 3.7 mAh per capture | about 1.3 days | about 2.1 days |
| Webcam streaming, for scale | 155 mA average, 366 mA peak | about 1.3 h | about 2 h |

- **Very small cells are risky.** Seeed lists about 366 mA peak on battery while streaming, and
  a camera maximum current of about 0.6 A for the OV3660 and 0.65 A for the OV2640. The OV5640 figure is
  "TBD" [S2]. VERIFIED. At 0.6 A a 100 mAh cell would be running at about 6C and may brown out during
  capture (ASSUMPTION, C6). Start at 300 mAh or more.
- **Charging is slow.** The page lists 50 or 100 mA charge current [S2], so a 400 mAh cell takes
  4-8 h (ESTIMATE).
- **Heat.** Peak backside temperature reached 63.6 C without a heat sink during webcam use [S2].
  VERIFIED. Single shots should run far cooler (ASSUMPTION), but the enclosure needs vents or a
  metal path, and must not press the board against skin.
- **Size estimate.** Board 21 x 18 x 15 mm, cell about 5 x 25 x 35 mm beside or behind it, plus
  walls, gives about 45 x 32 x 22 mm and 30-40 g. ESTIMATE.
- **Mounting is unresolved.** There is no viewfinder. A wrist mount needs an arm raised and
  aimed. A chest clip keeps hands free but points at whatever is in front of the body. Start
  with a clip and let the AI answer say "cut off, move up" (EXPERIMENT NEEDED, C7).

### Firmware power design

Use **deep sleep with a stay-awake window**:

1. Button wakes the board. GPIO2 is an RTC-capable pin on the ESP32-S3 (ASSUMPTION: confirm
   against the datasheet before wiring).
2. LED on. Camera starts. Wi-Fi connects at the same time.
3. Capture, upload, retry.
4. Stay awake for 5 minutes for follow-up photos, then sleep.

Images stay only in PSRAM. PSRAM contents do not survive deep sleep (ASSUMPTION), so the board
must not sleep while a photo is queued. If retries run out it drops the photo and shows the
failure pattern. This keeps photos off flash and SD, which is also the better privacy choice.

---

## 3. Bill of materials

All prices are ESTIMATES. Check before buying. Prices move and vary widely by shop.

| Item | Approx. price | Source or basis |
| --- | --- | --- |
| Seeed XIAO ESP32-S3 Sense | EUR 20-30 | Retailers [S10]. EU retail range is my estimate. Not re-confirmed |
| OV5640 module, only if the board arrives with OV3660 | EUR 12-19 | Open-E-Lab EUR 13.49 on sale, EUR 17.69 regular, incl. VAT, seen 2026-11-07 [S9]. DigiKey about EUR 12-13, not re-confirmed |
| LiPo 3.7 V, 300-500 mAh, with protection circuit | EUR 5-10 | No source checked |
| Shutter button, bright LED, resistor, slide power switch | EUR 3-5 | No source checked |
| Enclosure (3D print) and clip | EUR 0-15 | No source checked |
| Heat sink | Included | Comes with camera-equipped Sense models [S2] |
| **Hardware total** | **EUR 30-80** | Sum of the rows above: EUR 28-79 |
| Small EU server for the backend | EUR 4-8 per month | No source checked |
| AI per capture at `claude-opus-5-5` | EUR 0.03-0.08 | USD 4 in, USD 20 out per million tokens [S11]; about 4,000 image tokens and 1,000-3,000 output tokens are my estimate. Measure in C9 |
| LTE only if ever needed: 1NCE SIM | EUR 12 for 500 MB over 10 years, up to 1 Mbit/s [S12] | About 1,500 photos at 300 KB. Not planned |

---

## 4. Connectivity decision

| Option | Needs phone app? | Works phone locked? | Added size and power | Main failure | Verdict |
| --- | --- | --- | --- | --- | --- |
| **Phone hotspot (Wi-Fi)** | No | Probably; one weak source says locking alone does not stop it [S13]. EXPERIMENT NEEDED (C3) | None | Hotspot turns itself off; user forgets to turn it on | **Primary** |
| **Home Wi-Fi** | No | Yes, independent of the phone | None | Only at home | **Secondary**, already in `WiFiMulti` [S1] |
| BLE to native companion | Yes, new Android app | Foreground service is the documented route [S14]; test needed | None; lower idle draw (ASSUMPTION) | App killed by phone maker's battery rules; slower transfer | **Contingency** if C3 or C4 fail |
| Local-only hotspot from companion | Yes | Depends on the app | None | Network "will not have Internet access", credentials must be passed to the camera, and it may not start while normal tethering is active [S15] | Reject: more moving parts than BLE |
| LTE or eSIM on the camera | No | Yes, independent of the phone | Modem, antenna, larger battery; boards found are far from wearable [S5] | Size, SIM, coverage inside buildings | Reject for v1; removes the phone hop but adds the most hardware |

**Hotspot rules (Android):**

- **Auto-off.** On Pixel, "Turn off hotspot automatically" shuts the hotspot when nothing is
  connected, and can be turned off in settings [S16]. Samsung has an equivalent timeout, with a
  "never" style option on some models [S13]. VERIFIED. This collides directly with a deep-sleeping
  camera: a sleeping camera is "no device connected". The setting must be off.
- **Data Saver** must be off for Wi-Fi tethering on Pixel [S16]. VERIFIED. Battery Saver is
  reported to stop tethering on Pixel [S13] (secondary source, test in C3).
- **Band.** The ESP32-S3 is 2.4 GHz only [S2]. VERIFIED. The hotspot must offer 2.4 GHz, under a
  name not shared with any 5 GHz network [S17]. Exact menu names vary (C4). WPA3-only mode may
  also be a problem (ASSUMPTION, C4).
- **Who turns it on.** The user turns it on in the morning. Android 16's public reference now
  lists `TetheringManager.startTethering()` [S18], which is newer than the common belief that
  apps cannot do this. The page does not state who may call it. Only relevant if a companion is
  built (EXPERIMENT NEEDED, C12).
- **Radio sharing.** The hotspot and the BLE link to the glasses may share the phone's 2.4 GHz
  radio, so an upload might disturb IMU sample flow (ASSUMPTION, C8). This could affect the
  gesture engine, so it must be measured.

**BLE transfer speed if the contingency is used.** Forum measurements on ESP32-S3 range from
46 KB/s to about 102 KB/s [S19]. These are single forum reports, and they could not be re-read on 2026-11-07
(ASSUMPTION). So 300 KB takes 3-7 s (ESTIMATE).
Downscaling to about 150 KB would halve that, at some cost to legibility.

---

## 5. Is a native Android companion needed?

**Not for version 1.** A companion is often assumed to fix the locked-phone problem. It does not.

| What is needed | Can a companion do it? | Status |
| --- | --- | --- |
| Draw on the G2 | **No.** Plugins have no direct Bluetooth, and the Even app owns the link. No official interface for other apps to write to the lens was found | VERIFIED for the plugin side [S8]; the wider claim is ASSUMPTION |
| Wake or keep alive the plugin's WebView | **No documented way.** The SDK has no wake, intent or deep-link entry and no background API [S8] | VERIFIED for SDK 0.0.16 |
| Read IMU or wear state | **No.** Those arrive only inside the plugin [S8] | VERIFIED |
| Change Even's notification forwarding | **No.** The SDK has no notification API at all [S8] | VERIFIED |
| Receive photos by BLE and upload over mobile data | **Yes.** `connectedDevice` foreground service; Google also points to the companion device presence API [S14] | VERIFIED as an Android capability; reliability per phone is C13 |
| Post a phone notification | Yes, but ntfy already does this | VERIFIED [S20] |

Build it only if the hotspot fails C3 or C4. Expected scope then: pair with the camera by BLE,
receive JPEG chunks, POST them to the same `/v1/captures` endpoint with the same idempotency key.
Nothing else changes. Google Play is not needed for a personal app, so policy declarations do
not apply if it is sideloaded (ASSUMPTION).

**Rejected: unofficial direct BLE stacks.** Faceclaw replaces firmware on the glasses and warns
that even it is unreliable on a locked phone [S21]. Community protocol projects exist, and MentraOS
reportedly implements G2 text and image display [S22]. These do not use the supported path, may
conflict with the Even app's connection (ASSUMPTION), and IMU support was not confirmed.
Firmware modification is not recommended. Keep only as a last-resort option in section 6.

---

## 6. How a result reaches the glasses while the phone is locked

```
camera -- Wi-Fi --> phone hotspot -- LTE --> backend -- AI --> result stored
                                                 |
                 Path A: plugin long-poll <------+   only path that draws on the lens
                 Path B: phone buzz via ntfy <---+   only if plugin is silent; lens untouched
                 Path C: stored until the plugin next runs (always happens)
```

What the docs say: on Android the WebView "may be suspended under memory pressure", below that
threshold the app keeps running, and above it the process is reclaimed [S23]. VERIFIED. This is
less bleak than "always suspended when locked". The page says nothing about timers or network in
the background [S23]. VERIFIED. The SDK changelog mentions stronger WebView keep-alive in 0.0.10
without detail [S24]. VERIFIED. `setBackgroundState` and `onBackgroundRestore` are still not
exported by 0.0.16 [S8]. VERIFIED.

The Even app has to hold its Bluetooth link while locked for notifications to work, so it probably
stays alive, and a phone with free memory and "Unrestricted" battery may keep the WebView running
(ASSUMPTION). **C1 decides this and should be the first hardware test of the whole project.**

**If C1 passes:** Path A works. Gestures and results work locked.

**If C1 fails,** gestures, wear hiding and Hidden state all stop too, so this is a project-level
decision for the owner, not a backend fix. Options, in order of preference:

1. Keep the Even app in the foreground with the phone unlocked in the pocket. Contradicts the spec
   (locked phone), and risks accidental touches.
2. Accept a reduced product on Android: answers through the opt-in lens fallback (section 7) with
   no head gestures while locked.
3. Use an iPhone as the bridge. Official docs say the iOS WebView keeps running [S23]. Still needs
   testing, and the owner has an Android phone.
4. Build on an unofficial BLE stack. Highest effort and risk.

---

## 7. Hidden mode and the notification fallback (risk 3)

**The conflict.** G2 notification forwarding is outside the plugin. Once a notification reaches the
phone and the app is enabled in the Even app, it can appear on the lens regardless of plugin state.
The plugin cannot block it [S8][S25]. So anything the backend sends through ntfy can bypass Hidden.

**Three concrete faults in Study Lens code, if reused as is:**

1. `worker.ts` sends **immediately** when no plugin is polling. A suspended plugin in Hidden is
   exactly that case, so the answer lands on the lens.
2. `ack` means "drawn on the glasses". In Hidden the plugin stores and does not draw, so no ack
   arrives, and the fallback fires after `NOTIFY_DELAY_MS` even with a healthy plugin.
3. `worker.start()` re-arms pending notifications with zero delay after a backend restart. That
   breaks "never reveal after reconnect or restart".

Also, `NOTIFY_MODE=always` bypasses Hidden by design and must be removed.

**The rule.** The plugin is the only component allowed to reveal content. The backend treats
anything it does not positively know as Hidden.

**Default configuration: lens path closed at the source.**

- In the Even app, leave ntfy **off** under Settings > Notifications > Apps. Per-app selection is an
  Even feature [S25]. VERIFIED from the support page summary in search results; the page itself
  blocked direct fetching.
- The notification still reaches the phone, which vibrates in the pocket. Text is fixed and contains
  no answer: "Assistant paused. Open the app." It is sent only when the plugin has been silent.
- The user learns something is wrong without anything touching the lens.
- The camera also helps. The upload response carries `glassesListening: false`, and the camera shows
  a distinct LED pattern ("uploaded, glasses app not listening").

**Backend changes:**

- New endpoint `POST /v1/display-state` from the plugin on every state change:
  `{state, changedAt, stateSeq}`. Stored on disk. Default on first boot is `UNKNOWN`.
- Split the ack into two: `receivedAt` (plugin has stored it) and `displayedAt` (user could see it).
  `receivedAt` cancels any fallback.
- Check the gate **at send time**, not at schedule time, including after restart.

| Plugin | Last known state | Action |
| --- | --- | --- |
| Polling | VISIBLE | Plugin draws. No notification |
| Polling | HIDDEN or REMOVED | Plugin stores. No notification of any kind |
| Polling | PROCESSING, RESULT_READY, ERROR | Plugin decides. No notification |
| Silent | Any, default mode | Phone-only buzz, once per silent period, no content |
| Silent | VISIBLE, opt-in `FALLBACK_LENS=visible-only` with ntfy forwarding on | Short answer sent. See limits below |
| Silent | HIDDEN, REMOVED, UNKNOWN, opt-in mode | Nothing sent, even in opt-in mode |

**Limits of the opt-in mode, stated plainly.** With the plugin suspended, a shake cannot be seen, and
wear changes cannot be reported. The last known VISIBLE may be stale, so a user who shook while the
plugin was frozen could still receive an answer on the lens. Forwarded notifications also stay in the
Even Notification Center even with pop-ups off [S25]. VERIFIED. That is why opt-in mode is not the
default. It is a decision for the owner after C1 and C2.

**Spec wording to change.** Hidden can only cover this app's content. Other apps' forwarded
notifications will still appear, and the SDK offers no way to stop them [S8]. The spec should say
this, or the user should use Even's own master switch. Whether a forwarded notification draws over a
plugin page, and what happens when glasses are re-worn, are unknown (EXPERIMENT NEEDED, C2).

---

## 8. Latency budget

All figures are ESTIMATES except the note below the table. Press to first text on the lens.

| Hop | Connected | Woken from deep sleep | Basis |
| --- | --- | --- | --- |
| Press, LED, focus, discard 2 frames, capture | 0.3-0.8 s | 1.3-2.8 s (boot and camera start) | Firmware steps [S1]; timings assumed |
| Wi-Fi join | 0 | 0-3 s beyond capture, runs in parallel | Assumed; C5 |
| TLS handshake on ESP32 | 0.3-1.0 s | Same | Assumed |
| Upload 200-500 KB through hotspot and LTE | 0.4-2.0 s | Same | Assumed uplink 5 Mbit/s or better |
| Backend receive and queue | under 0.1 s | Same | Local disk write |
| AI vision with structured output | 4-15 s | Same | Assumed; biggest cost; C9 |
| SymPy check, when used | 0-1 s | Same | Spawns Python [S1]; timeout 10 s |
| Long-poll to plugin | 0.1-0.5 s | Same | One LTE round trip, if plugin is awake |
| Plugin to lens over BLE | 0.1-0.5 s | Same | Assumed; C9 |
| **Total** | **5-21 s** | **6-26 s** | |

Only measured figure: about 1.8 s upload to display with the mock AI in the simulator [S1]. VERIFIED.
That excludes every real radio and the real AI, so it says little about real latency.

Target: median under 15 s, same as Study Lens's pass rule [S1]. Show `PROCESSING` within 2 s of upload
when VISIBLE, so the user knows it worked. This needs the backend to publish a "received" event on
the long-poll, which Study Lens does not do today (it only returns finished jobs).

Levers if too slow, in order: lower effort, return `short` before running SymPy, stream the short
answer, Fast mode, or a smaller model. Model choice is the owner's decision after C11. Fast mode is
priced at twice the standard rate [S11].

---

## 9. Security, privacy and capture indication

### Visible capture indication (required)

The Study Lens firmware blinks the on-board LED for 80 ms **after** capture [S1]. That LED sits on the
board and would be inside an enclosure. This is not enough. Change to:

- External bright LED on the front next to the lens, with a light pipe if needed.
- On **before** the sensor captures, at least 500 ms, staying on through capture and upload.
- No setting, build flag or remote command can disable it. If the LED circuit fails, do not capture
  when that can be detected (ASSUMPTION: needs a small sense circuit, optional for a first build).
- Optional short sound from a piezo.
- Enclosure must not allow the LED to be covered without covering the lens. Place them side by side.
- Must be visible from 2 m in daylight (C10).

**Features that must not exist:** sending or keeping video, timed or interval capture, remote trigger from phone
or glasses, audio recording. The Sense has a microphone [S2], and firmware must never initialise it.
Photos are taken only by a physical press on the camera. (Updated: a long press on a Linux camera scans about 2 s
of frames locally and keeps up to 3 photos; nothing else leaves the device. CAPTURE-STRATEGY.md.) Capture during Hidden mode still lights the
LED. Hidden hides the user's display. It does not hide the camera from other people.

Not designed for exams or tests. There is no exam mode, and this should not be used where recording
or aids are not allowed.

### Image retention

Study Lens never deletes anything: images and job files stay on disk forever (no delete call anywhere in
`backend/src`). VERIFIED by reading the code. New policy:

| Data | Kept where | Kept how long |
| --- | --- | --- |
| JPEG on camera | PSRAM (ESP32) or the RAM disk under `/run` (Linux) | Until uploaded or dropped. Never flash or SD |
| JPEG on backend | Encrypted disk (ASSUMPTION: server setup) | Deleted when the job reaches `done` or `failed`. Hard limit 1 hour |
| Debug copy | Off by default | Opt-in per session, 24 h limit |
| Result text | Backend | 30 days, then deleted. Includes transcribed page text, so treat as private |
| Job stub (ID, key, timings) | Backend | 7 days, needed for idempotency and tests |
| Result text on phone | Plugin storage | Last 20 results (built, `app/src/core/inbox.ts`) |
| AI provider | Anthropic | Up to 30 days under the standard commercial API terms, longer if flagged for a policy violation; zero data retention needs an agreement [S26]. Anthropic's two pages are not worded the same, so re-check before relying on this |

Logs contain IDs and timings only, never answer text. (Superseded: V1 deploys no ntfy.) ntfy carries only the fixed
"Assistant paused" text by default. Public `ntfy.sh` topics are readable by anyone with the name [S1], so self-host ntfy on
the same server if the lens fallback is ever enabled.

### Authentication

- Keep the two roles: device token (upload only) and client token (read only), stored as SHA-256 hashes
  with constant-time comparison [S1].
- **Bind the token to the device.** `X-Device-Id` is not tied to the token today, so one token can claim
  any ID. Store `deviceId -> hash`.
- Allow revoking and adding tokens without a server restart, because a lost camera holds a token.
- Add rate limits: about 10 captures per minute per device, and a slowdown on repeated 401s. Neither
  exists today.
- TLS terminates at a reverse proxy; the Node server itself speaks plain HTTP and binds `0.0.0.0` by
  default [S1]. Bind it to localhost.
- Camera checks the server against a pinned root certificate [S1]. Include a backup root, because a CA
  change would otherwise brick uploads until reflashing (ASSUMPTION).
- Device token sits unencrypted in flash, readable by anyone with the board. Use ESP32 flash encryption
  later, and revocation now (ASSUMPTION).
- Set `CORS_ORIGIN` to the plugin's real origin rather than `*`. Even's whitelist needs one full origin per
  entry and does not bypass CORS [S27]. Study Lens's `app.json` has no `whitelist` at all, which the
  official docs say is required [S28].
- This repository is public. `config.h`, `.env` and `*.local` must be in `.gitignore` from the first commit,
  with only `*.example` files tracked. The Study Lens `.gitignore` is a correct starting point [S1].

### Idempotency

- Camera generates one key per capture and reuses it on every retry. Server returns the original job [S1].
  Keep this.
- **Race to fix:** `store.create()` records the key only after the image write finishes, so two
  overlapping attempts can create two jobs. Reserve the key before writing.
- Keep the key for longer than the camera's retry window (about 10 minutes [S1]). The 7-day stub covers this.
- Plugin deduplicates by job ID and resumes from a cursor [S1]. Keep this.

### Prompt injection and bystanders

Text in the photo is untrusted. The Study Lens prompt says so and the SymPy input is restricted to a small
grammar, run in an isolated process with a timeout [S1]. Keep both. Add to the prompt: do not identify
people, do not describe bystanders, and if a person is the main subject, say that this tool is for pages and
objects.

### Consent

Point the camera at pages, screens and objects, not at people. Ask before photographing anything with a
recognisable person in it. Do not use it in changing rooms, toilets, medical settings, or anywhere the
rules forbid it.

---

## 10. AI answer format

Display limits: `textContainerUpgrade` max 2000 characters, `rebuildPageContainer` max 1000, and the
guidance is to split text at about 400-500 characters [S29]. VERIFIED. The official guidance for long text is to
split it and rebuild the page on scroll events [S29], so this document assumes head scrolling is app-managed
(ASSUMPTION until risk 6 is closed). Detail therefore arrives pre-split into pages, and "exact scroll position"
is a page index stored by the plugin.

(Superseded: the built schema adds `unreadableParts`, `frameConflicts` and a fixed list of retake reasons, and folds
`CHECK FAILED` into `UNSURE`. See API.md and CAPTURE-STRATEGY.md section 8. The page index below became a line
offset in SPEC-V0.3.) Replace the Study Lens `Solution` type with:

```json
{
  "readable": true,
  "retakeHint": null,
  "topic": "Quadratic equations",
  "question": "Solve x^2 - 5x + 6 = 0",
  "short": "x = 2 or x = 3. It factors as (x-2)(x-3).",
  "reading": "clear",
  "reasoning": "sure",
  "detail": [
    { "text": "Look for two numbers that multiply to 6 and add to -5.",
      "check": null },
    { "text": "Those are -2 and -3, so (x-2)(x-3) = 0.",
      "check": { "lhs": "expand((x-2)*(x-3))", "rhs": "x**2 - 5*x + 6" } }
  ],
  "caveats": []
}
```

Rules for the model:

- `short`: at most 140 characters, states the result and the key idea. First field the user sees.
- `detail`: at most 8 items under 400 characters. Explains why, because the goal is understanding.
- `reading`: `clear`, `partial` or `unclear`, about the photo. `reasoning`: `sure`, `likely` or `unsure`, about
  the content. Separate, because a clean photo can still get a wrong answer.
- If the photo fails, `readable` is false and `retakeHint` says what to do ("Cut off at top, move up").
- Never guess a word it cannot read. Say so in `caveats`.
- Answer language is a user setting (English or German). Check that German letters render (C9).

**The label on the glasses is computed by the backend, never written by the model:**

| Label | Rule | Shown |
| --- | --- | --- |
| `RETAKE` | `readable` is false | `RETAKE: <hint>` |
| `CHECK FAILED` | Any SymPy result is `mismatch` | Above the answer, always wins |
| `UNSURE` | `reading` is `unclear`, or `reasoning` is `unsure` | Prefix on `short` |
| `LIKELY` | Default when nothing below applies | Prefix on `short` |
| `CHECKED` | Reading `clear`, reasoning `sure`, and every check verified, with at least one check | Prefix on `short` |

`CHECKED` means a computer confirmed the listed steps. It does not mean the page was read correctly,
and the phone-side help must say so. Study Lens's accuracy test counts wrong answers carrying a check
mark [S1]. Keep that test.

**Screen layout.** Page 1: label, `short`, and "scroll for detail" if detail exists. Later pages: one or more
`detail` items, with a page counter. Last page: `caveats`, then the question as read, so the user can spot a
misread.

**Model.** Keep `claude-opus-5-5`, adaptive thinking, effort set explicitly (now `low`, CAPTURE-STRATEGY.md), and
server-side fallback for refusals [S1][S11]. Provider stays behind an interface (built as `FusionProvider`), so it
can be changed by config.

---

## 11. Camera and recording rules in Germany

**This is not legal advice.** It is an engineer's reading of primary texts and recent news, assuming use in
Germany. Check with a lawyer before relying on it, and before building or showing a finished device. The
area is changing quickly.

- **Covert devices, § 8 TDDDG.** Bans owning, making, selling or importing devices that disguise themselves
  as other objects or are hidden in everyday items, and are especially suited and intended to record people's
  images or words unnoticed. Non-recognisable recording in normal use counts toward that intent [S30].
  Possession and making are both covered. § 27 makes breaches an offence, per legal press [S31].
- **How the regulator reads it.** In August 2026 the Bundesnetzagentur reportedly treats smart glasses as allowed
  when the recording function is clearly recognisable, for example by an optical signal, with the test being
  whether an uninvolved person can tell [S32]. That is about commercial glasses. Applying it to a self-built
  camera is my ASSUMPTION. Hamburg's data protection authority has taken a harder line [S33], and the position
  may change.
- **Design consequence.** The unit must look like a camera. No watch shape, no fake watch face, no hiding in a
  pen, button or strap. A manipulated device that records covertly can itself fall under the ban [S31]. The
  visible LED rule in section 9 is the main safeguard, and it should be treated as part of the device, not a
  feature.
- **Photos of people, § 201a StGB.** Criminal offence to take or transmit an unauthorised image of someone in a
  home or specially protected room, violating their most personal sphere, or showing helplessness. Up to two
  years or a fine [S34].
- **Publishing, § 22 KunstUrhG.** Portraits may be distributed or shown publicly only with consent [S35].
- **Audio.** Recording the spoken word has its own, stricter criminal rules (§ 201 StGB, not re-read for this
  study, ASSUMPTION). The firmware avoids this by never using the microphone.
- **GDPR.** The EDPB's statement of 13 October 2026 says a user is outside the GDPR only for purely personal or
  household activity. It names medical settings, schools, places with minors, changing rooms, pools and
  beaches, toilets and workplaces as sensitive, and says informing people is relevant [S36]. How far the
  exemption reaches in public is disputed [S37]. Whether sending a photo with bystanders to a cloud AI stays
  "household" is unclear to me, so assume it might not. Another reason to photograph pages, not people.
- **Local rules** at universities, libraries, workplaces and venues may forbid cameras regardless of the law.

---

## 12. Reuse from Study Lens

(Done in software, 2026-11-08: the backend parts were ported and changed as listed; the firmware was rewritten as
`camera/esp32` and the Linux client is new. `/v1/display-state` was not built, because V1 has no notification
fallback. This table is the record of the plan.)

**Reuse as is:**

| Part | Why |
| --- | --- |
| `backend/src/auth.ts` | Hashed tokens, constant-time compare |
| `backend/src/verify.ts`, `scripts/verify_math.py` | Safe SymPy check with timeout |
| `backend/src/presence.ts` | "Is a plugin polling" tracker |
| `SolveProvider` interface and `classify()` error mapping | Clean provider boundary, sensible retries |
| Long-poll in `server.ts`, resumable cursor in `store.ts` | Survives reconnects and cold starts |
| `glasses-app/src/client.ts` polling, backoff, persisted acks | Designed around Android suspension; split the ack only |
| Firmware pin map, camera init, retry and backoff, button debounce | Compiled, not flashed |
| `tools/fake-camera.mjs`, `tools/e2e-sim.mjs` | Test without hardware |

**Change:**

| Part | Change |
| --- | --- |
| `worker.ts`, `notify.ts` | Gate at send time; re-check after restart; remove `always`; fixed-text phone alert (section 7) |
| `server.ts` | Add `/v1/display-state`, `receivedAt` and `displayedAt`, `received` event, rate limits, `glassesListening` in upload response |
| `store.ts` | Delete images on finish, retention sweep, reserve idempotency key before writing |
| `auth.ts` config | Bind token to device; reload without restart |
| `providers/anthropic.ts`, `types.ts` | New schema and prompt, from "solve" to "explain" (section 10) |
| `glasses-app/src/main.ts` | **Must not draw results at cold start.** It calls `viewer.page(client.jobs, ...)` straight into the first page. Start in HIDDEN as the spec requires, and treat new results as "store" until the state machine allows display |
| `app.json` | New ID; add the required network `whitelist` |
| `study_cam.ino` | External LED before capture, deep sleep with stay-awake window, new LED patterns, no microphone |
| `docs/ANDROID.md` | Remove the Auto Display and ntfy forwarding steps from the default setup |

**Do not carry over:** `NOTIFY_MODE=always`, the study-only "solve" wording, and any local `.env` or token files.

---

## 13. Open experiments

Run in this order. C1 and C2 decide the project; the rest refine it.

| ID | Test | Pass rule | If it fails |
| --- | --- | --- | --- |
| **C1** | Plugin sends a heartbeat every 30 s and logs IMU sample counts. Phone locked in pocket 60 minutes, 3 runs, battery set to Unrestricted, on the owner's actual phone | No gap over 60 s; long-poll still answers | Section 6 options. Stop and decide before more building |
| **C2** | Send a test ntfy with forwarding on and off: plugin showing text, plugin blank, plugin suspended, glasses off then re-worn, Notification Center afterwards | Forwarding off means nothing on the lens in every case | Reconsider any use of ntfy |
| C3 | Hotspot on 8 h, phone locked, camera asleep for long gaps, with and without Battery Saver; record phone battery drain | Camera joins every time; acceptable drain | Build BLE companion |
| C4 | Camera joins hotspot on the owner's phone: 2.4 GHz, WPA2/WPA3 modes | Joins in under 5 s | Change hotspot security, or build BLE companion |
| C5 | Time from press to HTTP 202, connected and from deep sleep; measure real sleep current on the finished build | Under 6 s from sleep | Keep Wi-Fi awake for longer and accept battery loss |
| C6 | Capture and upload on 150, 300 and 500 mAh cells at low charge | No brown-out in 50 captures | Use a larger cell |
| C7 | 20 printed pages at 25-40 cm, small print: OV5640 autofocus against OV3660, hand-held and clipped (now part of HT-19 and HT-23 for every board) | 18/20 legible to the AI | Board with autofocus (CAMERA-HARDWARE-EGYPT.md) |
| C8 | Log IMU sample rate and glasses link during repeated uploads over the hotspot | Rate drops under 10 %, no missed gestures | Smaller images, or upload over BLE |
| C9 | Study Lens's 50-capture run, extended with German text and real AI, recording each hop | 10/10 per condition, median under 15 s, no duplicates | Use levers in section 8 |
| C10 | Stranger at 2 m in daylight and indoors reports whether the LED is obvious | Seen every time | Brighter LED, better placement |
| C11 | Same 20 pages over effort levels and, if the owner agrees, other models | Owner picks using measured accuracy, speed, cost | Keep default |
| C12 | Only if a companion is built: can an ordinary app call `startTethering()` | Works without privileged permission | User keeps turning on the hotspot by hand |
| C13 | Only if a companion is built: foreground service BLE receive, phone locked 8 h | 20/20 transfers | Check maker battery settings |
| C14 | Hidden test: shake to Hidden, press camera, stop and restart backend and phone | Nothing appears on the lens until shake | Treat as a release blocker |

---

## 14. Sources

Local:

- [S1] Study Lens repository (earlier project): `README.md`, `docs/ANDROID.md`, `docs/FINDINGS.md`, `docs/TEST-PLAN.md`, `firmware/README.md`, `firmware/study_cam/study_cam.ino`, `backend/src/*`, `glasses-app/src/*`, `glasses-app/app.json`.
- [S8] `@evenrealities/even_hub_sdk` 0.0.16 `dist/index.d.ts` (no `notification`, `setBackgroundState` or `onBackgroundRestore`; `captureImageFromCamera` present), and the `device-features` skill of the official `everything-evenhub` plugin.
- [S28] Official plugin `build-and-deploy` skill.
- [S29] Official plugin `glasses-ui` skill.

Web (read 2026-11-07). A second check the same day could not re-open the RobotShop half of [S4], the DigiKey half of
[S9], the groovypost half of [S13], [S25] directly, or the forum figures in [S19]. Treat those as unconfirmed.

- [S2] Seeed wiki, XIAO ESP32-S3 getting started: https://wiki.seeedstudio.com/xiao_esp32s3_getting_started/
- [S3] Seeed datasheet listing via RS, for the sleep currents: https://docs.rs-online.com/5ba0/A700000015884832.pdf
- [S4] M5Stack Timer Camera X listings: https://shop.pimoroni.com/products/esp32-psram-timer-camera-x-ov3660 and https://www.robotshop.com/products/m5stack-esp32-psram-timer-camera-x-ov3660
- [S5] CNX Software on LILYGO T-SIMCam and Waveshare 4G boards: https://www.cnx-software.com/2022/09/27/lilygo-t-simcam-esp32-s3-cam-development-board-4g-lte/ and https://cnx-software.com/?p=125744
- [S6] CNX Software on CamThink NE101: https://www.cnx-software.com/2025/07/17/camthink-neoeyes-ne101-a-low-power-esp32-s3-vision-ai-camera-with-optional-4g-lte-and-wifi-halow-connectivity/
- [S7] Unihertz Jelly Star: https://www.notebookcheck.net/Unihertz-Jelly-Star.746485.0.html and https://pricespy.co.uk/product.php?p=13660379
- [S9] OV5640 module: https://openelab.io/products/seeed-studio-ov5640-camera-for and https://www.digikey.be/en/products/detail/seeed-technology-co-ltd/114993115/21277047
- [S10] XIAO retail: https://elektor.com/products/seeed-studio-xiao-esp32s3-sense and https://thepihut.com/collections/seeed/products/seeed-studio-xiao-esp32s3-sense
- [S11] Claude model table and pricing, cached 2026-10-06, from the Claude API reference bundled with Claude Code. Confirm current prices at https://platform.claude.com/docs
- [S12] 1NCE: https://1nce.com/en-eu/1nce-connect/features/500-mb-data-volume
- [S13] Hotspot behaviour, secondary sources: https://helpdeskgeek.com/why-does-my-android-hotspot-keep-turning-off-7-fixes/ and https://www.groovypost.com/howto/android-hotspot-keeps-turning-off-how-to-fix/
- [S14] Android foreground service types: https://developer.android.com/develop/background-work/services/fgs/service-types
- [S15] Android `WifiManager.startLocalOnlyHotspot`: https://developer.android.com/reference/android/net/wifi/WifiManager
- [S16] Pixel hotspot help: https://support.google.com/pixelphone/answer/2812516
- [S17] ESP32 and 5 GHz networks with the same name: https://esp32.com/viewtopic.php?p=22330
- [S18] Android `TetheringManager`: https://developer.android.com/reference/android/net/TetheringManager
- [S19] ESP32 BLE throughput reports: https://esp32.com/viewtopic.php?p=134183 and https://esp32.com/viewtopic.php?p=84637
- [S20] ntfy Android docs: https://docs.ntfy.sh/subscribe/phone/
- [S21] Faceclaw: https://github.com/jimrandomh/faceclaw
- [S22] Community G2 protocol work: https://github.com/i-soxi/even-g2-protocol, https://github.com/Commute773/g2-kit, https://zenn.dev/gpsnmeajp/articles/dbf9846091f493
- [S23] Even Hub, Background & Lifecycle: https://hub.evenrealities.com/docs/build/background-lifecycle
- [S24] Even Hub changelog: https://hub.evenrealities.com/docs/reference/changelog
- [S25] Even support, Notifications (search summary; direct fetch returned 403): https://support.evenrealities.com/hc/en-us/articles/14274501482639-Notifications
- [S26] Anthropic retention: https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data and https://platform.claude.com/docs/en/manage-claude/api-and-data-retention
- [S27] Even Hub, Networking: https://hub.evenrealities.com/docs/build/networking
- [S30] § 8 TDDDG: https://www.gesetze-im-internet.de/ttdsg/__8.html
- [S31] beck-aktuell, 21 August 2026: https://www.beck-aktuell.de/heute-im-recht/rechtsgeschehen/smart-glasses-datenschutz-spionage-filmen-2026-08-21
- [S32] netzpolitik.org, 19 August 2026: https://netzpolitik.org/2026/heimliches-filmen-kann-man-ueberwachungsbrillen-verbieten/
- [S33] Noerr, 10 August 2026: https://www.noerr.com/en/insights/private-video-recordings-made-using-wearables-in-public-spaces
- [S34] § 201a StGB: https://www.gesetze-im-internet.de/stgb/__201a.html
- [S35] § 22 KunstUrhG: https://www.gesetze-im-internet.de/kunsturhg/__22.html
- [S36] EDPB, Statement on Smart glasses, adopted 13 October 2026: https://www.edpb.europa.eu/system/files/2026-10/20261310_edpb_statement_smart-glasses_en.pdf
- [S37] Same Noerr article as [S33], on the household exemption and the Rynes ruling.
