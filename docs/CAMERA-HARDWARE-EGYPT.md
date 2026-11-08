# Camera hardware you can buy in Egypt

Research date: **2026-11-08**. Prices and stock were read from store pages on that day. They change often, so
check before you pay. **None of these boards has been tested with this project on real hardware.**

**Fact-check, same day.** Every store page and spec source below was opened a second time. What changed is listed
in section 10. The three corrections that matter: the MT3608 boost converter cannot power these boards from a LiPo
(its own listing says so), the AI never sees more than about 2,208 pixels across, so the Camera Module 3's 12 MP
gives no extra detail to the AI (its gain is autofocus and a brighter lens), and the XIAO Sense's sensor depends on
the stock you get.

Labels used:

- **VERIFIED**: read on a source listed at the end, shown as [E1], [E2] and so on.
- **EXPERIMENT NEEDED**: only a test on the real part can settle it. Tests are numbered CH-1 to CH-8 in section 8.
- **ASSUMPTION**: my reasoning or general knowledge, not confirmed by a source.
- **ESTIMATE**: an assumption written as a number. Nothing has measured it.

---

## 1. Short answer

1. **The NanoPi Duo2 kit will work, but it is not the best fit for reading paper.** It is in stock in Egypt at
   4,250 EGP in one shop [E1], and its Linux system makes the clip mode easy. It has three real weaknesses:
   - It cannot sleep and wake quickly the way a microcontroller can. You switch it on at the start of a study
     session, wait for it to boot, and get about 3-5 hours from a 1,000 mAh cell (ESTIMATE).
   - Its 5 MP camera has no autofocus listed anywhere (ASSUMPTION: fixed focus). A fixed-focus lens of this size
     set for normal distances is sharp only from about 45 cm outwards, so a page at 25-35 cm will be soft unless
     the lens can be turned to refocus (section 4, EXPERIMENT NEEDED CH-1).
   - Camera support exists only in FriendlyElec's own Linux 4.14 kernel. Users report it broken on Armbian with a
     newer kernel [E3][E4]. FriendlyElec's own example captures at 1280 x 720, and that ROM has no hardware JPEG
     encoder [E2]. Whether full 2592 x 1944 stills work is unknown (CH-2).
2. **The change that makes a big difference is autofocus plus a brighter lens:** Raspberry Pi Zero 2 W with
   Camera Module 3. It focuses from about 10 cm [E5], its f/1.8 lens takes in about 2.4 times the light of the
   Duo2's f/2.8 (ASSUMPTION: ratio of the squared f-numbers), it has an HDR mode, and its camera software is the
   most mature on any small board. Its pixels are the same size as the OV5640's (1.4 µm [E5][E18]), and its extra
   megapixels do not reach the AI (section 4). **The problem: the Zero 2 W is out of stock in every Egyptian shop I checked**
   (five shops) and is short worldwide [E6]. The Camera Module 3 itself is in stock at Dev Boards Market for
   3,000 EGP [E7].
3. **The change that makes the biggest difference for battery and instant capture** is the XIAO ESP32-S3 Sense.
   It sleeps, wakes on the button and captures in a couple of seconds (ESTIMATE), and lasts days. The project
   already has its firmware (`camera/esp32`). **It is not sold in any Egyptian shop I could find.** It has to
   be imported from Seeed or AliExpress.
4. **Cheapest way to start this week:** an ESP32-CAM (AI-Thinker, OV2640) at 450-500 EGP, in stock at
   Free Electronic [E8] and Makers Electronics [E9]. Its image quality is the weakest, but it is enough to test
   the whole system (button, burst, upload, AI fusion, retake signal, glasses) before you spend more.

**My recommendation:**

- If you can wait for the Zero 2 W to come back (watch Makers Electronics, which lists it at 2,150 EGP [E10]),
  build **Option B (Pi Zero 2 W + Camera Module 3)**. It is the only option that solves blur from wrong focus.
- If you want to start now with one simple purchase, buy the **NanoPi Duo2 kit (Option A)**, but do test CH-1
  (can the lens be refocused to 30 cm?) on the first day. If the lens is glued and pages are blurry, the AI
  fusion cannot fix that.
- If battery life and "press and it just works" matter more than image quality, import the
  **XIAO ESP32-S3 Sense (Option C)**.

---

## 2. What matters for this project

The camera has to photograph a page held or lying 20-40 cm away, often in poor light, from a hand or a clip that
moves. In order of importance (ASSUMPTION, based on how reading-from-photo fails):

1. **Focus at 20-40 cm.** A fixed lens focused far away gives soft text that no software can sharpen well.
2. **Pixels on the page.** Small print needs roughly 6 or more pixels per millimetre of paper for reliable reading
   (ASSUMPTION). See the table in section 4.
3. **Low light and motion.** A brighter lens, a larger sensor and HDR help. The burst-and-pick-sharpest design
   already fights hand shake.
4. **Wake to capture time.** If the camera takes 30 s to be ready, you miss the moment or stop using it.
5. **Battery and size.** It must last a study session and be small enough to clip on.
6. **Software.** A camera driver that works with the current, maintained Linux tools saves days of debugging.

---

## 3. Comparison

Prices in EGP, read 2026-11-08. "In stock" means the shop page said so; it does not mean I phoned them.

| | **A. NanoPi Duo2 + 5MP OV5640** | **B. Pi Zero 2 W + Camera Module 3** | **C. XIAO ESP32-S3 Sense** | **D. ESP32-CAM (AI-Thinker)** |
| --- | --- | --- | --- | --- |
| Egypt price | **4,250**, in stock, Makers Electronics [E1] | Board 2,150-3,500, **out of stock** at Makers [E10], RAM [E11], Dev Boards Market [E7], Most Electronics [E12], Flux [E13]. Camera **3,000 in stock** at Dev Boards Market [E7]; RAM 4,950 not available [E14]; Amazon.eg 9,500 [E15] | **Not found** in Makers, Free Electronic, RAM, Dev Boards Market (they stock other XIAO boards at 800 [E7]). Import: about USD 14-20 from Seeed [E16], plus shipping and possibly customs | **450-500**, in stock, Free Electronic [E8]; 495 at Makers [E9]; RAM 300 out of stock [E17] |
| Sensor | OV5640 (the shop lists "OV5640 etc" [E1]; resellers of the Duo2 module say OV5640 [E18]), 1/4 inch, 5 MP, 1.4 µm pixels, 66° view, f/2.8 [E18] | Sony IMX708, 12 MP, 1.4 µm pixels, f/1.8, HDR, 66° (standard) or 102° (wide, f/2.2) [E5] | Depends on stock: Seeed's wiki says the camera is now OV5640 with autofocus and that OV5640 or OV3660 may ship [E30]; retailers still say OV2640 or OV3660 [E31]. An OV5640 add-on is sold separately [E30] | OV2640, 2 MP |
| Focus | **No autofocus listed** (ASSUMPTION: fixed). Lens may or may not turn (CH-1) | **Autofocus, about 10 cm to infinity** (wide: 5 cm) [E5] | Autofocus only if an OV5640 arrives or is added; the firmware path is not compiled yet | Fixed. Lens often can be turned by hand on these modules (ASSUMPTION) |
| Low light | Weak: small sensor, f/2.8 (ASSUMPTION from specs) | Best of these: larger sensor, f/1.8, HDR mode [E5]; same pixel size | Weak (small sensor) | Weakest |
| Wake to capture | Cold boot about 15-40 s (ESTIMATE; no figure published [E2]). So it must stay on | Cold boot about 12-30 s stock, 3.5-5 s with heavy tuning [E19]. So it stays on too | About 1-3 s from deep sleep (ESTIMATE, test C5) | About 1-3 s (ESTIMATE) |
| Idle power | About 0.5-1 W (ESTIMATE from a similar Allwinner board at 550 mW [E20], not re-opened) | About 0.5-0.6 W (100 mA at 5 V idle, measured by a reviewer [E19]) | Deep sleep about 3 mA with camera [S2] | Deep sleep several mA (ASSUMPTION: the regulator and camera stay powered) |
| Battery, 1,000 mAh real capacity | About 3-5 h switched on (ESTIMATE) | About 4.5-5.5 h switched on (ESTIMATE) | Days with deep sleep (see CAMERA-AND-BACKEND.md section 2) | About 1 day with sleep (ESTIMATE) |
| Board size | 55 x 25.4 mm, 7.4 g [E1] | 65 x 30 mm board (ASSUMPTION, standard Zero size) + 25 x 24 x 11.5 mm camera [E5] | 21 x 17.8 x 15 mm | 40 x 27 mm (ASSUMPTION) |
| Finished unit | About 65 x 35 x 22 mm (ESTIMATE) | About 70 x 35 x 25 mm (ESTIMATE) | About 45 x 32 x 22 mm (ESTIMATE) | About 50 x 35 x 22 mm (ESTIMATE) |
| Camera software | FriendlyElec Linux 4.14 only, `/dev/video0`, V4L2; example 1280 x 720 YUYV; no hardware encoding [E2]. Broken on Armbian [E3]; mainline 5.4 reports only 640 x 480 working [E4] | libcamera and Picamera2, maintained by Raspberry Pi; autofocus control built in (ASSUMPTION: from general knowledge of Raspberry Pi OS) | Arduino `esp_camera`; project firmware exists in `camera/esp32` | Arduino `esp_camera`; needs a board-config change from the XIAO firmware |
| Clip mode (long press) | Yes, frames from a V4L2 stream into RAM | Yes, best: video modes up to 2304 x 1296 at 56 fps [E5] | No, long burst of 8 frames instead | No, long burst |
| Assembly | Easy-medium: solder headers or wires for button and LED, add boost converter, antenna | Medium: same plus a 22-pin Zero camera cable | Medium: small pads, solder battery and button | Easy-medium: needs a 5 V boost from the LiPo |
| Extra parts | microSD, LiPo, a charger-plus-5 V-boost module that can deliver 1-2 A from a LiPo (not the MT3608, section 6), antenna (ask shop), button, LED | microSD, Zero camera cable, the same power module or a UPS HAT, LiPo, button, LED | LiPo (charger is on the board), button, LED | LiPo, the same power module, button, LED |

### Others looked at and rejected

| Board | Why not |
| --- | --- |
| Luckfox Pico Mini B (RV1103), 1,250 EGP in stock at Makers [E21] | No Wi-Fi on the board, and no camera in the box [E21]. Would need an add-on Wi-Fi module |
| Orange Pi Zero 2W, Radxa Zero 3W | No Egyptian listing found. Import only. The Raspberry Pi camera ecosystem is the reason to pick a Zero-sized board, and these do not share it (ASSUMPTION) |
| Raspberry Pi 4, 10,500 EGP in stock at Makers [E9] | Too big and too power-hungry to wear |
| Google AIY Vision Kit with Pi Zero, 7,500 EGP at Makers [E9] | Cardboard box kit with a fixed-focus camera; not wearable |
| FireBeetle 2 ESP32-S3 with camera, 1,950 EGP at Dev Boards Market [E7] | Out of stock; OV2640 fixed focus |
| ESP32-S3-CAM boards, 1,450 EGP at RAM [E17] | Out of stock. If a reliable ESP32-S3 camera board with OV5640 appears locally, it is a good substitute for Option C |
| M5Stack Timer Camera X, AtomS3R-CAM | No Egyptian listing found [E22]; import only |
| Raspberry Pi Zero Camera 5MP (OV5647), 700 EGP in stock at Free Electronic [E8] | Fixed focus, small old sensor. Only a stopgap for Option B while you wait for Camera Module 3 money |

Not checked: uge-one.com blocked automated reading on 2026-11-08, and future-electronics.com.eg did not resolve.
Check those two by hand; they may have stock the others lack.

---

## 4. Focus and pixels: why the NanoPi camera is the main risk

### Fixed focus at reading distance (ESTIMATE)

For the Duo2 camera, resellers list a 2.7 mm lens at f/2.8 and 1.4 µm pixels [E18]. Using a blur limit of about
2.8 µm (two pixels):

- The hyperfocal distance is about 2.7² / (2.8 x 0.0028) ≈ **930 mm**.
- If the factory set the lens at the hyperfocal distance (the usual fixed-focus choice), sharp focus starts at about
  half that, **about 47 cm**. If it set it at infinity, sharp focus starts at about 93 cm. Either way a page at
  25-35 cm will be soft.
- If you turn the lens to focus at 30 cm, the sharp range becomes about **23-44 cm**, which covers reading.

So CH-1 (can the lens be turned?) decides whether Option A is good for reading. Many small modules have the lens
glued. If it turns, a drop of nail varnish fixes it after setting.

The Camera Module 3 does not have this problem: it focuses automatically from about 10 cm [E5].

### Pixels per millimetre on an A4 page at 30 cm (ESTIMATE)

A 66° horizontal view at 30 cm covers about 39 cm of width, so an A4 page (21 cm wide) fits with margin.

**The AI sees at most about 2,208 pixels across.** Claude shrinks any image larger than 2,576 px on the long edge or
4,784 visual tokens (VERIFIED, Claude vision docs [E32]), so the camera client resizes a 4:3 frame to 2208 x 1656
before upload. The last column is what reaches the AI.

| Camera and mode | Width captured | Pixels per mm captured | Pixels per mm at the AI | Small print (9-10 pt) |
| --- | --- | --- | --- | --- |
| Duo2 OV5640 at 1280 x 720 (FriendlyElec's example) [E2] | 1280 | about 3.3 | about 3.3 | Poor |
| Duo2 OV5640 at full 2592 x 1944 (if it works, CH-2) | 2592 | about 6.6 | about 5.7 | Usable if in focus |
| ESP32-CAM OV2640 at 1600 x 1200 | 1600 | about 4.1 | about 4.1 | Marginal |
| XIAO Sense, OV3660 at 2048 x 1536 | 2048 | about 5.3 | about 5.3 | Usable if in focus |
| XIAO Sense, OV5640 at 2592 x 1944 (firmware uses 2048 x 1536 today) | 2592 | about 6.6 | about 5.7 | Usable if in focus |
| Camera Module 3, 12 MP still | 4608 | about 11.8 | about 5.7 | Usable, and in focus |
| Camera Module 3, 2304 x 1296 video frame | 2304 | about 5.9 | about 5.7 | Usable |

So at 30 cm every good option gives the AI about the same detail. What separates them is whether that detail is in
focus and not blurred, which is why autofocus matters more than megapixels. Extra megapixels would only help if the
camera cropped to the page before upload, which the client does not do (ASSUMPTION that it would help; not built).

This is why the clip mode on the Duo2 is weaker than it sounds: its video frames are 720p. On the Duo2, clip mode
helps with shaky hands but gives less detail than a burst of full-size stills. Default to burst, use clip when
moving.

---

## 5. Option details and weaknesses

### Option A: NanoPi Duo2 + 5MP camera

VERIFIED from the shop and wiki: Allwinner H3 quad-core 1.2 GHz, 512 MB RAM, 2.4 GHz 802.11b/g/n Wi-Fi,
Bluetooth 4.0, microSD boot, power 5 V / 2 A, 55 x 25.4 mm [E1][E2]. The IPX antenna connector is in the shop
listing [E1], not on the wiki. The wiki contradicts itself on the power socket (USB-C in its introduction, microUSB
in another section) [E2]: look at the board before buying a cable.
FriendlyCore and FriendlyWrt images on Linux 4.14 [E1][E2]. Cash on delivery across Egypt [E1].

Weaknesses:

1. **Must stay switched on.** No fast sleep and wake. Boot time is not published (ESTIMATE 15-40 s). The wiki even
   lists a fix for "long boot time" [E2]. Plan: a slide switch, turn it on at the start of a session.
2. **Battery.** At an ESTIMATED 0.5-1 W, a 1,000 mAh real-capacity cell (about 3.7 Wh, about 3.1 Wh after the boost
   converter) gives about 3-5 hours. Larger cells mean a larger box.
3. **Focus.** See section 4. CH-1 decides it.
4. **Driver.** Camera only on FriendlyElec's 4.14 kernel [E2]; Armbian users report it not working [E3]; mainline
   reports only 640 x 480 [E4]. You are tied to the vendor image. Full-resolution stills are not proven (CH-2).
5. **No hardware encoding** on the 4.14 image: the wiki says mjpg-streamer uses libjpeg in software and that the
   4.14 ROM "doesn't support hardware-encoding" [E2]. Encoding 3 frames of 5 MP in software on the H3 may take a second
   or more (ESTIMATE, CH-3). That is acceptable for a burst.
6. **Heat.** H3 boards are known to run warm (ASSUMPTION). Add a small heat sink and vents.
7. **Antenna.** The board has an IPX connector [E1]; the shop page does not say an antenna is included. Ask before
   ordering.
8. **The 5 MP module for this board may be old.** One European shop listed an earlier FriendlyElec 5 MP camera as
   withdrawn [E23]; that page refused the second reading (HTTP 403), so this is unconfirmed, and it may be a
   different module from the Duo2's 24-pin one. Buy a spare cable if you can.

Strengths: one shop, in stock, cash on delivery; full Linux, so the Python camera client, SSH debugging and clip
mode all work; small flat board.

### Option B: Raspberry Pi Zero 2 W + Camera Module 3

VERIFIED: Camera Module 3 uses the Sony IMX708, 12 MP, motorised autofocus with phase and contrast detection,
focus about 10 cm to infinity (wide version about 5 cm), f/1.8, HDR at 2304 x 1296, 25 x 24 x 11.5 mm, 4 g [E5].
The Zero series uses the smaller 22-pin camera connector [E5], so you need a Zero camera cable (the camera's
included cable is the 15-pin type [E14]).

Weaknesses:

1. **Availability.** Out of stock in all five Egyptian shops checked [E7][E10][E11][E12][E13]. A 2026-11-01 article
   says the board has been sold out "for months" worldwide because of chip substrate shortages, with improvement
   expected in the second half of 2026 [E6].
2. **Must stay switched on**, like Option A (cold boot 12-30 s stock [E19]).
3. **Cost.** About 7,000-8,000 EGP in total.

Strengths: autofocus solves the main cause of unreadable photos; better in poor light through the f/1.8 lens and HDR
(same 1.4 µm pixel size as the OV5640); best video modes for clip mode; libcamera is the best-supported camera stack on any small Linux board (ASSUMPTION). The same Python
client in `camera/linux` works with both A and B behind the source interface.

### Option C: XIAO ESP32-S3 Sense

Covered in detail in CAMERA-AND-BACKEND.md section 2. The reason to choose it here: it is the only option that can
sleep and still capture within a few seconds of a press, so you never have to remember to switch it on, and it lasts
days. Its weaknesses are a small sensor, that it must be imported to Egypt, and that the sensor you receive depends
on the seller's stock (OV5640 with autofocus per Seeed's wiki, OV2640 or OV3660 per several retailers [E30][E31]).
Ask the seller, and budget for the OV5640 add-on (sold separately [E30]) if an older sensor arrives. Seeed's store lists Egypt among its
shipping regions [E16]; shipping cost and customs were not checked.

### Option D: ESP32-CAM (AI-Thinker)

A cheap test rig, not the final camera. OV2640 2 MP, fixed focus, original ESP32 with 4 MB PSRAM (ASSUMPTION). No
battery charger. The 5 V pin goes through a linear regulator, so a LiPo needs a 5 V boost (ASSUMPTION). The bright
white flash LED on the board must not be used as the capture-indicator LED: it causes glare on paper (ASSUMPTION).

---

## 6. Shopping lists (EGP, read 2026-11-08)

Parts marked "ASSUMPTION" had no price checked; the number is a guess for a typical Cairo shop.

Battery note: Makers Electronics lists its cells with an honest "actual capacity" figure. The 803040 cell sold as
1,200 mAh is listed as 1,000 mAh actual, with a built-in protection board [E24]. Use the actual figure for
battery-life planning.

**Power correction (fact-check).** The first version of these lists used a TP4056 charger plus an MT3608 boost
converter. Makers' own MT3608 listing gives its output current as "<100mA (input <4.0V), <50mA (input <3.5V)"
[E26]. A LiPo spends most of its charge below 4.0 V, so the MT3608 cannot run a Duo2 (rated 5 V / 2 A [E2]), a
Pi Zero 2 W or an ESP32-CAM. The lists below use Makers' "Power Bank Module With Dual USB 5V 2A" (75 EGP, in
stock [E33]) instead, which also charges the cell. Its listing gives no input or charging specs, so it is an
ASSUMPTION that it works from one 3.7 V LiPo and delivers 1-2 A. Check it with a USB meter before building it in
(CH-5). A boost module that states its current at 3.0-4.2 V input is the safer buy.

### Option A: NanoPi Duo2 (all local, available today)

| Part | Shop | EGP |
| --- | --- | --- |
| NanoPi Duo2 with 5MP camera | Makers Electronics [E1] | 4,250 |
| LiPo 803040, 1,000 mAh actual, with protection | Makers [E24] | 95 |
| Power bank module, 5 V 2 A, charges the cell (replaces TP4056 + MT3608, see above) | Makers [E33] | 75 |
| microSD card 16-32 GB, A1 class | Any phone shop (ASSUMPTION) | 200 |
| 2.4 GHz IPX antenna, if not in the kit | Ask Makers (ASSUMPTION) | 50 |
| Tactile buttons, 6 x 6 mm kit | Makers [E27] | 175 |
| Coin vibration motor RCD1027 (optional) | Makers [E28] | 15 |
| Transistor, diode, resistors for motor and LED | Any shop (ASSUMPTION) | 15 |
| Bright red or white 5 mm LED for the outward capture light | Any shop (ASSUMPTION) | 5 |
| Slide power switch | Any shop (ASSUMPTION) | 10 |
| Small heat sink | Any shop (ASSUMPTION) | 30 |
| Wires, headers, tape | Any shop (ASSUMPTION) | 30 |
| 3D-printed case and clip | Local print service (ASSUMPTION) | 250 |
| **Total** | | **about 5,200** |

### Option B: Pi Zero 2 W + Camera Module 3 (when the board is back in stock)

| Part | Shop | EGP |
| --- | --- | --- |
| Raspberry Pi Zero 2 W | Makers 2,150 [E10] to Dev Boards Market / RAM 3,500 [E7][E11], all out of stock | 2,150-3,500 |
| Camera Module 3 (standard) | Dev Boards Market, in stock [E7] | 3,000 |
| Raspberry Pi Zero case with mini camera cable | Dev Boards Market, in stock [E7] | 700 |
| LiPo 1,000 mAh actual + power bank module | Makers [E24][E33] | 170 |
| microSD 16-32 GB | Any phone shop (ASSUMPTION) | 200 |
| Buttons, LED, switch, motor, small parts | as Option A | 250 |
| 3D-printed case and clip (the official case can be used for first tests) | Local print service (ASSUMPTION) | 250 |
| **Total** | | **about 6,700-8,100** |

Alternative power: the Waveshare UPS HAT (C) for Pi Zero (1,000 mAh cell, pogo pins, same footprint) is about
USD 24 at Waveshare [E29]. No Egyptian listing found.

### Option C: XIAO ESP32-S3 Sense (import plus local parts)

| Part | Shop | EGP |
| --- | --- | --- |
| XIAO ESP32-S3 Sense (pre-soldered) | Seeed Studio, about USD 14-20 [E16], plus shipping | about 1,000-1,500 (ASSUMPTION: depends on rate, shipping, customs) |
| OV5640 add-on camera, only if an older sensor arrives | Seeed Studio [E30] | price not checked |
| LiPo 803040, 1,000 mAh actual (or 603035 at 600 mAh actual, 75 EGP) | Makers [E24] | 95 |
| Buttons, LED, switch, motor, small parts | as Option A | 250 |
| 3D-printed case and clip | Local print service (ASSUMPTION) | 250 |
| **Total** | | **about 1,600-2,100** |

The charger is on the XIAO board, so no TP4056 or boost converter is needed.

### Option D: ESP32-CAM test rig (local, today)

| Part | Shop | EGP |
| --- | --- | --- |
| ESP32-CAM OV2640 with CH340 USB base | Free Electronic [E8] | 500 |
| LiPo + power bank module (the MT3608 cannot supply the ESP32-CAM's Wi-Fi peaks from a LiPo) | Makers [E24][E33] | 170 |
| Button, LED, wires | as Option A | 50 |
| **Total** | | **about 720** |

---

## 7. Ideas that make the camera work better in hard conditions

These cost little and help with any option (all ASSUMPTION until tested):

1. **Refocus a fixed lens to 30 cm** (Options A and D). Biggest single improvement for those boards.
2. **On Linux, do clip mode in RAM.** Capture about 2 s of frames from the V4L2 or libcamera stream into memory,
   score them, keep the best 3 and discard the rest. Nothing is encoded to a file and nothing is written to the SD
   card. This matches the design's rule that video never leaves the device, avoids the Duo2's missing hardware
   encoder, and does not wear the SD card.
3. **Lock autofocus before the burst** (Option B, and C if the OV5640 ships): focus once, then capture all frames.
   Refocusing between frames wastes time and can produce one soft frame.
4. **Short exposure beats bright exposure** for shaky hands. Prefer a higher gain and let the AI read a slightly
   noisy image rather than a blurred one.
5. **A small diffuse white fill light** (optional, separate from the capture LED) helps in dim rooms. Point it at an
   angle to avoid glare on glossy paper. Test before adding (CH-6).
6. **Clip position.** A chest clip angled down 30-40° puts a page on the desk at about 30-40 cm. Test the mount with
   the AI's "page cut off" retake reason (CH-7).

---

## 8. Experiments before buying more

| ID | Test | Pass rule | If it fails |
| --- | --- | --- | --- |
| CH-1 | Duo2 camera: does the lens turn? Refocus to 30 cm, shoot a printed page at 25, 30, 40 cm | Small print readable by eye at all three | Option A is weak for reading; move to B or C |
| CH-2 | Duo2: capture full 2592 x 1944 stills with V4L2 on the FriendlyCore 4.14 image | Clean 5 MP frames | Use 1280 x 720 and accept poor small print, or move to B |
| CH-3 | Duo2: time for a 4-frame burst, scoring and software JPEG of 3 frames | Under 3 s | Lower resolution or fewer frames |
| CH-4 | Cold boot time to "camera ready" on A and B | Measured and written down | Decides whether boot-on-press is possible (likely not) |
| CH-5 | Current draw from the LiPo while idle with Wi-Fi joined, on A and B; output voltage of the power module under a burst plus upload, with the cell at 3.6 V | Measured; output stays above 4.8 V | Size the battery; change the power module |
| CH-6 | 20 pages in dim light (one desk lamp), with and without fill light | 18 of 20 read | Add fill light or accept retakes |
| CH-7 | Chest-clip mount, 20 pages on a desk | 18 of 20 fully in frame | Change angle or mount |
| CH-8 | Same 20 pages with each camera you own | Compare read rate | Pick the camera by measured result |

CH-1 is the first test if you buy the Duo2. The same page set also covers C7 in CAMERA-AND-BACKEND.md.

---

## 9. Sources

All read 2026-11-08. Store pages are listings, not tests, and stock can change within hours.

- [E1] Makers Electronics, NanoPi Duo2 with 5MP Camera, 4,250 EGP, in stock: https://makerselectronics.com/product/nanopi-duo2-with-5mp-camera/
- [E2] FriendlyElec wiki, NanoPi Duo2 (OV5640 on Linux 4.14, `/dev/video0`, 1280 x 720 YUYV example, no hardware encoding on the 4.14 ROM, 5 V / 2 A): https://wiki.friendlyelec.com/wiki/index.php/NanoPi_Duo2
- [E3] Armbian forum, "NanoPi Duo2 Armbian focal OV5640 camera does not work" (seen in search results only; the page returned 403 and on the fact-check did not resolve, so the report is unconfirmed): https://forum.armbian.com/topic/18147-invalid-nanopi-duo2-armbian-focal-ov5640-camera-does-not-work
- [E4] Armbian forum and linux-sunxi on OV5640 with mainline H3 CSI (2019-2020; 640 x 480 reported working; not re-opened, the forum did not resolve on the fact-check): https://forum.armbian.com/topic/7502-ov5640-on-mainline-kernel/ and https://forum.armbian.com/topic/13238-ov5640-device-tree-overlay-for-orangepi-one-h3/ and https://linux-sunxi.org/CSI
- [E5] Raspberry Pi documentation, camera hardware (Camera Module 3 specs, 22-pin Zero connector): https://www.raspberrypi.com/documentation/accessories/camera.html
- [E6] raspberry.tips, "Raspberry Pi Zero 2 W Sold Out: Alternatives 2026" (as of 2026-11-01): https://raspberry.tips/en/raspberrypi-infos/raspberry-pi-zero-2-w-alternative-sold-out
- [E7] Dev Boards Market (Egypt), product data read from the store's product feed: Camera Module v3 3,000 EGP available; Zero 2 W 3,500 not available; Zero W 2,500 not available; Zero case + mini camera cable 700 available; XIAO ESP32-S3 Plus 800 available; FireBeetle 2 ESP32-S3 camera 1,950 not available: https://devboardsmarket.com/products/raspberry-pi-camera-module-v3 and https://devboardsmarket.com/products/raspberry-pi-zero-2-w and https://devboardsmarket.com/products/raspberry-pi-zero-case-mini-camera-cab
- [E8] Free Electronic, camera search (ESP32-CAM OV2640 with CH340 500 EGP and V2.0 450 EGP in stock; Raspberry Pi Zero Camera 5MP 700 EGP in stock): https://free-electronic.com/?s=camera&post_type=product
- [E9] Makers Electronics search results (ESP32-CAM 495 EGP in stock; Raspberry Pi 4 8 GB 10,500; AIY Vision Kit 7,500): https://makerselectronics.com/?s=camera+module+3&post_type=product and https://makerselectronics.com/?s=raspberry+pi+camera&post_type=product
- [E10] Makers Electronics, Raspberry Pi Zero 2 W, 2,150 EGP, sold out: https://makerselectronics.com/product/raspberry-pi-zero-2-w/
- [E11] RAM Electronics, Raspberry Pi Zero 2 W, 3,500 EGP, not available: https://www.ram-e-shop.com/shop/raspberry-pi-zero-2w-raspberry-pi-zero-2-w-9256
- [E12] Most Electronics, Raspberry Pi Zero 2 W, 3,000 EGP, out of stock: https://mostelectronic.com/shop/arduino-development-boards/raspberry-pi/raspberry-pi-zero-2-w/
- [E13] Flux Electronix, Raspberry Pi Zero 2 W, 3,000 EGP, listing says out of stock although its description says in stock; ask them: https://fluxelectronix.com/shop/raspberry-pi-zero-2-w/
- [E14] RAM Electronics, Camera Module V3, 4,950 EGP, not available, 200 mm 15-pin cable included: https://www.ram-e-shop.com/shop/rpi-v3-camera-raspberry-pi-camera-module-v3-official-12-mp-and-autofocus-imx708-official-8737
- [E15] Amazon.eg, Camera Module V3 listing at 9,500 EGP, one left (search result only; the site did not resolve on the fact-check): https://www.amazon.eg/-/en/Raspberry-Camera-Module-Official-Autofocus/dp/B0F8P6F753
- [E16] Seeed Studio, XIAO ESP32-S3 Sense listings (both returned HTTP 403 on the fact-check; a Japanese reseller gives the maker's retail price as USD 13.90 before tax, so the USD 14-20 range stands as an ESTIMATE): https://www.seeedstudio.com/XIAO-ESP32S3-Sense-p-5639.html and https://www.seeedstudio.com/Seeed-Studio-XIAO-ESP32S3-Sense-Pre-Soldered-p-6335.html
- [E17] RAM Electronics, ESP32 camera search (ESP32-CAM 300 EGP out of stock; ESP32-S3-CAM 1,450 EGP out of stock): https://www.ram-e-shop.com/shop?search=esp32+cam
- [E18] Fabtolab, FriendlyArm OV5640 5MP camera module for NanoPi Duo2 (2.7 mm, 66°, f/2.8; no focus type stated): https://www.fabtolab.com/friendlyarm-ov5640-5mp-camera-module-nanopi-duo2-omni-vision-1-4-qsxga-cmos-chipset
- [E19] Pi Zero 2 W power and boot: https://www.jeffgeerling.com/blog/2021/disabling-cores-reduce-pi-zero-2-ws-power-consumption-half/ and https://www.cnx-software.com/2021/12/09/raspberry-pi-zero-2-w-power-consumption/ and https://www.hackster.io/news/manawyrm-digs-deep-into-raspberry-pi-power-optimization-to-slash-the-boot-time-to-just-3-5-seconds-40bcbb427189 (search summaries; figures vary by image and method)
- [E20] Armbian forum, Orange Pi power consumption (H2+/H3 class board idle about 550 mW, search summary; not re-opened): https://forum.armbian.com/topic/2952-orange-pi-power-consumption/
- [E21] Makers Electronics, Luckfox Pico Mini B, 1,250 EGP, in stock, no camera included, no Wi-Fi listed: https://makerselectronics.com/product/luckfox-pico-mini-b-rv1103-linux-micro-development-board
- [E22] M5Stack camera listings abroad only (The Pi Hut): https://thepihut.com/collections/m5stack/products/atoms3r-camera-kit-8mb-psram
- [E23] Botland, FriendlyElec CAM500B 5 MP camera for NanoPi, withdrawn: https://botland.store/withdrawn-products/7990-nanopi-camera-hd-5mpx-1080p-fa-cam500b-camera-for-nanopi.html
- [E24] Makers Electronics LiPo cells (803040 95 EGP, 1,000 mAh actual; 603035 75 EGP, 600 mAh actual): https://makerselectronics.com/product/rechargeable-803040pt-lipo-battery-c/ and https://makerselectronics.com/product/lipo-battery-cell-603035pt-rechargea/
- [E25] Makers Electronics, TP4056 USB-C charger with protection, 18 EGP: https://makerselectronics.com/product/tp4056-type-c-lithium-charging-module/
- [E26] Makers Electronics, MT3608 boost converter, 25 EGP, "2A (max), 1A (recommended), <100mA (input <4.0V), <50mA (input <3.5V)": https://makerselectronics.com/product/mt3608-dc-dc-step-up-2a/
- [E27] Makers Electronics, tactile push button kit 6 x 6 mm, 175 EGP: https://makerselectronics.com/product/tactile-push-button-kit-10-values/
- [E28] Makers Electronics, coin vibration motor RCD1027, 15 EGP: https://makerselectronics.com/product/mini-coin-vibration-motor-rcd1027-1-53-7v/
- [E29] Waveshare UPS HAT (C) for Pi Zero: https://www.waveshare.com/ups-hat-c.htm and https://thepihut.com/collections/zero/products/uninterruptible-power-supply-ups-hat-for-raspberry-pi-zero
- [S2] refers to the Seeed XIAO ESP32-S3 wiki, listed in CAMERA-AND-BACKEND.md section 14.
- [E30] Seeed wiki source, XIAO ESP32-S3 getting started (OV2640 discontinued, then OV3660, now OV5640 with autofocus; OV5640 or OV3660 may ship during the transition), and the OV5640 add-on: https://github.com/Seeed-Studio/wiki-documents/blob/docusaurus-version/sites/en/docs/Sensor/SeeedStudio_XIAO/SeeedStudio_XIAO_ESP32S3/XIAO_ESP32S3_Getting_Started.md and https://www.seeedstudio.com/OV5640-Camera-for-XIAO-ESP32S3-Sense-With-Heat-Sink-p-5739.html (read through search results; wiki.seeedstudio.com did not resolve on 2026-11-08)
- [E31] Retailer listings saying OV2640 or OV3660 may ship: https://thepihut.com/products/seeed-studio-xiao-esp32s3-sense and https://thinkrobotics.com/products/esp32s3-sense (search results)
- [E32] Claude docs, Vision (28 x 28 px visual tokens, 2,576 px and 4,784 tokens on Claude 4.7 and later): https://platform.claude.com/docs/en/build-with-claude/vision
- [E33] Makers Electronics, Power Bank Module With Dual USB 5V 2A, 75 EGP, in stock, no input specs listed: https://makerselectronics.com/product/power-bank-module-with-dual-usb-5v-2a/

---

## 10. Fact-check log (2026-11-08)

Each source was opened again. "Confirmed" means the second reading matched.

| Claim | Result |
| --- | --- |
| Duo2 kit 4,250 EGP, in stock [E1] | Confirmed. Listing says "Camera (OV5640 etc)" and has an IPX connector; antenna in the box not stated |
| Duo2 wiki: OV5640 on 4.14, `/dev/video0`, sun6i-csi, 1280 x 720 YUV example, no hardware encoding on 4.14 [E2] | Confirmed |
| Duo2 power "through microUSB" | **Corrected.** The wiki says USB-C in one place and microUSB in another |
| Zero 2 W: Makers 2,150 sold out, RAM 3,500 not available, Dev Boards 3,500 not available, Most 3,000 out of stock, Flux 3,000 out of stock | Confirmed (Flux's description contradicts its stock flag) |
| Camera Module 3: Dev Boards Market 3,000 in stock; case with mini cable 700 in stock [E7] | Confirmed from the store's product data |
| Camera Module 3 at RAM 4,950 not available, 200 mm 15-pin cable [E14] | Confirmed |
| Camera Module 3 specs [E5] | Confirmed; **added** that its pixels are 1.4 µm, the same as the OV5640, and removed "bigger pixels" |
| 12 MP gives about 11.8 px/mm | True at capture, **corrected** for what the AI sees: about 5.7 px/mm after the required resize |
| Duo2 camera 2.7 mm, f/2.8, 66°, 24-pin, focus type not stated [E18] | Confirmed; pixel size 1.4 µm added |
| XIAO Sense ships OV5640 or OV3660 | **Downgraded.** Seeed's wiki says so, retailers say OV2640 or OV3660 |
| XIAO Sense USD 14-20 [E16] | Seeed pages refused (403). Maker's retail price USD 13.90 seen at a reseller. Kept as ESTIMATE |
| ESP32-CAM 500 / 450 at Free Electronic, 495 at Makers | Confirmed |
| Raspberry Pi Zero Camera 5MP 700 at Free Electronic | Confirmed |
| Raspberry Pi 4 10,500, AIY Vision Kit 7,500 at Makers | Confirmed |
| Luckfox Pico Mini B 1,250, in stock, no Wi-Fi listed, no camera | Confirmed |
| LiPo 95 EGP, 1,000 mAh actual; TP4056 18; button kit 175; motor 15 (rated 3 V) | Confirmed |
| MT3608 25 EGP, 2 A | Price confirmed. **Corrected:** under 100 mA below 4.0 V input, so removed from the lists |
| Zero 2 W shortage article [E6] | Confirmed: dated 2026-11-01, substrate shortage, improvement expected in the second half of 2026 |
| Pi Zero 2 W idle 100-120 mA [E19] | Jeff Geerling gives 100 mA idle; boot 12 s stock to about 3.5 s tuned in one write-up |
| Waveshare UPS HAT (C) | Confirmed: 1,000 mAh 803040 cell, pogo pins, USD 23.99 |
| Camera Module 3 only at import resellers (CAPTURE-STRATEGY.md [C11]) | **Wrong there**, fixed in that document: Dev Boards Market has it. The Ubuy import listing is out of stock |
| Botland withdrawn module [E23], Armbian reports [E3][E4], Orange Pi power [E20], Amazon.eg [E15] | Could not be re-opened (403 or DNS failure). Marked unconfirmed |

