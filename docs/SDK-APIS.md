# SDK and platform APIs used by this project

Checked on 2026-11-07 against `@evenrealities/even_hub_sdk` 0.0.16 (minimum Even App 2.2.10).
Nothing here has been run on real glasses.

## How to read this document

Every claim has one of three labels:

- **VERIFIED**: read directly in the cited source. It proves what the source says, not that the
  hardware behaves that way.
- **EXPERIMENT NEEDED**: only a real G2 and Android phone can answer it.
- **ASSUMPTION**: an inference, or a report from another developer. Treat it as a lead, not a fact.

### Source keys

| Key | Source |
| --- | --- |
| DTS | SDK package `dist/index.d.ts`, cited as DTS:line. This is the authority for names and types. |
| RM | SDK package `README.md`, cited as RM:line |
| DIST | SDK package `dist/index.js`. It is obfuscated, so only its decoded string table was checked, without running it. |
| SK/name | Official plugin `everything-evenhub`, commit cb8321f (2026-10-21), `skills/name/SKILL.md` |
| D/path | Official docs, `https://hub.evenrealities.com/docs/path` |
| SUP/name | Official support pages on `support.evenrealities.com`. Direct fetch returned HTTP 403 (re-checked 2026-11-07), so these were read through search-engine extracts only. Open them by hand to confirm the wording. The extracts do not always say whether a page covers G1 or G2. |
| GH#n | Issue n in `github.com/even-realities/everything-evenhub`. The repo is official, but most issues are written by third-party developers, so their measurements are ASSUMPTION for us. |
| CN/name | Community sources: `even-g2-notes` (nickustinov), Zenn (bigdra), note.com (macccoto_lab), `Boycham/g2Rest` PR 30. All ASSUMPTION. |
| SL | The user's earlier Study Lens project. Never tested on hardware. |

Support page URLs:

- SUP/dashboard: `/hc/en-us/articles/14269247458319-Dashboard`
- SUP/wear: `/hc/en-us/articles/17451244132879-Wear-Detection`
- SUP/silent: `/hc/en-us/articles/17451199636495-Silent-Mode`
- SUP/notifications: `/hc/en-us/articles/14274501482639-Notifications`
- SUP/hud: `/hc/en-us/articles/17143921759759--Head-Up-Display-of-G2-Glasses-Does-Not-Work-When-Looking-Up-But-Works-When-Looking-Down`
- SUP/known: `/hc/en-us/articles/14309475255183-Known-Issues` (labelled for G1)

## 1. Startup and bridge

| API | Signature | Label and source |
| --- | --- | --- |
| Get bridge | `waitForEvenAppBridge(): Promise<EvenAppBridge>` | VERIFIED DTS:1533 |
| Raw call | `callEvenApp(method: EvenAppMethod \| string, params?: any): Promise<any>` | VERIFIED DTS:1318 |
| Launch source | `onLaunchSource(cb: (s: 'appMenu' \| 'glassesMenu') => void): () => void` | VERIFIED DTS:77, DTS:1461 |

- `onLaunchSource` fires once per page load and does not fire again after a reload. VERIFIED DTS:65 comment, RM:59, RM:485.
- Register `onLaunchSource` early. VERIFIED RM:485.
- An Android developer reports that only the WebView instance the host keeps receives
  `launchSource`, and that duplicate instances exist. ASSUMPTION GH#16 (comment by m0a, SDK 0.0.12).

## 2. IMU

| Item | Exact form | Label and source |
| --- | --- | --- |
| Control | `imuControl(isOpen: boolean, reportFrq?: ImuReportPace): Promise<boolean>` | VERIFIED DTS:1436 |
| Default pace | `ImuReportPace.P100` | VERIFIED DTS:1433 comment |
| Pace enum | `P100 = 100`, then steps of 100, up to `P1000 = 1000` | VERIFIED DTS:322 |
| Pace meaning | "protocol pacing codes, not literal Hz values" | VERIFIED D/build/device-apis, SK/device-features |
| Sample path | `onEvenHubEvent` then `event.sysEvent.imuData` with `eventType === OsEventTypeList.IMU_DATA_REPORT` (8) | VERIFIED DTS:879, DTS:995, RM:219 |
| Sample type | `IMU_Report_Data { x?: number; y?: number; z?: number }` (double on the wire) | VERIFIED DTS:968 to 971 |
| Prerequisite | `createStartUpPageContainer` must succeed first | VERIFIED SK/device-features, SK/sdk-reference line 62 |
| Duration | Samples continue until `imuControl(false)` | VERIFIED D/build/device-apis |
| Cleanup | Stop on exit, or the IMU may keep running | VERIFIED SK/device-features |
| Manifest permission | None listed for the IMU | VERIFIED D/ship/packaging (permission list: network, location, g2-microphone, phone-microphone, album, camera) |

Unknown, and not answerable from any source:

- Units, axis frame, and whether x/y/z are angles, acceleration or rate. The FAQ says "A units
  table is still TBD" (D/reference/faq). D/build/device-apis lists the source as "IMU (accelerometer /
  gyroscope)" with "Head orientation, motion data". SK/sdk-reference line 408 calls the values "Raw
  accelerometer/gyro values". None says which one x/y/z carry. One article calls it accelerometer data.
  ASSUMPTION CN/zenn. EXPERIMENT NEEDED.
- Real samples per second for each pace, and whether a larger code is faster or slower.
  EXPERIMENT NEEDED. One article reports selectable intervals of 100, 500 and 1000 ms and treats P100
  as 100 ms, which would be 10 samples per second. ASSUMPTION CN/zenn. Another used 100 ms sampling.
  ASSUMPTION CN/note.
- Whether samples keep flowing on a blank page, across `rebuildPageContainer`, while the contextual
  menu is open, or with the phone locked. EXPERIMENT NEEDED.

Protobuf note: the SDK omits zero and false values, so they arrive as `undefined`. VERIFIED SK/handle-input.
A sample that is exactly 0 on one axis may therefore be missing. Read it with `?? 0`. ASSUMPTION
(the skill does not name IMU fields specifically).

## 3. Wear state and device status

| Item | Exact form | Label and source |
| --- | --- | --- |
| Snapshot | `getDeviceInfo(): Promise<DeviceInfo \| null>` with `.status: DeviceStatus` | VERIFIED DTS:1344, DTS:226 |
| Push | `onDeviceStatusChanged(cb: (status: DeviceStatus) => void): () => void`; the callback gets the full status | VERIFIED DTS:1465, DTS:1483 |
| Fields | `sn`, `connectType`, `isWearing?: boolean`, `batteryLevel?`, `isCharging?`, `isInCase?` | VERIFIED DTS:143 to 155 |
| Helpers | `isNone()`, `isConnected()`, `isConnecting()`, `isDisconnected()`, `isConnectionFailed()` | VERIFIED DTS:167 to 175 |
| Connection enum | None, Connecting, Connected, Disconnected, ConnectionFailed | VERIFIED DTS:116, SK/device-features |
| Promise | "Wearing-detection events fire on put-on / take-off" | VERIFIED D/reference/faq |
| Simulator | Status events are not emitted | VERIFIED SK/test-with-simulator, D/test/simulator |

Traps:

- `isWearing` is typed optional (DTS:149), but the SDK never hands the app `undefined`. In 0.0.16 a
  missing value becomes `false`, in the constructor and in `DeviceStatus.fromJson`, which is what
  the host path uses. So "not reported" looks exactly like "removed". VERIFIED by running the SDK. The
  app still handles three values, because a lost connection sets wear to unknown.
- `isInCase` and `isCharging` also default to `false`, and `batteryLevel` to 0. VERIFIED by running the SDK.
- Whether the host ever sends a status without `isWearing`, for example a battery-only update, is
  unknown. The sample host payload in SK/sdk-reference line 592 has the field. EXPERIMENT NEEDED.
- The app has no documented way to read the user's Wear Detection setting. Whether `isWearing`
  updates when that setting is off is unknown. EXPERIMENT NEEDED.

Firmware behaviour with Wear Detection on (VERIFIED SUP/wear, through search extract):

- The display turns off when the glasses come off.
- Active features keep running, and their content reappears when the glasses go back on. The
  example given is Translate. Whether an Even Hub plugin page behaves the same way is not stated.
  EXPERIMENT NEEDED.
- While off the head, touchpad taps, press-and-hold and voice wake do nothing.
- The setting is under My Devices in the Even app.

## 4. Glasses UI

| API | Signature | Label and source |
| --- | --- | --- |
| Create | `createStartUpPageContainer(c: CreateStartUpPageContainer): Promise<StartUpPageCreateResult>`; 0 success, 1 invalid, 2 oversize, 3 out of memory | VERIFIED DTS:1402, DTS:711 |
| Rebuild | `rebuildPageContainer(c: RebuildPageContainer): Promise<boolean>` | VERIFIED DTS:1408 |
| Text update | `textContainerUpgrade(c: TextContainerUpgrade): Promise<boolean>` | VERIFIED DTS:1412 |
| Exit | `shutDownPageContainer(exitMode?: number): Promise<boolean>`; 0 immediate, 1 foreground dialog | VERIFIED DTS:1440 to 1442 |

`TextContainerProperty` fields: `xPosition`, `yPosition`, `width`, `height`, `borderWidth`,
`borderColor`, `borderRadius`, `paddingLength`, `containerID`, `containerName`, `isEventCapture`,
`zOrderIndex`, `content`, `textColor`. VERIFIED DTS:410.

`TextContainerUpgrade` fields: `containerID`, `containerName`, `contentOffset`, `contentLength`,
`content`, `textColor`. VERIFIED DTS:1128. Neither field is a scroll control; both describe a text
replacement range. VERIFIED SK/glasses-ui ("Use `contentOffset: 0, contentLength: 0` for full content
replacement"), D/build/display ("for partial-string updates").

Limits:

| Limit | Value | Label and source |
| --- | --- | --- |
| Canvas | 576 x 288, origin top-left, 4-bit greyscale green, black is off | VERIFIED D/build/display |
| Containers | Max 12 in total: 8 text or list, 4 image | VERIFIED RM:420, D/build/display |
| Event capture | Exactly one container with `isEventCapture: 1` | VERIFIED D/build/display |
| Text per create or rebuild | 1000 characters | VERIFIED D/build/display |
| Text per `textContainerUpgrade` | 2000 characters | VERIFIED D/build/display |
| Full screen capacity | About 400 to 500 characters | VERIFIED D/build/display |
| Line height | 27 px, so at most 10 full lines on the canvas | VERIFIED SK/font-measurement (10 is arithmetic from 288/27) |
| Text measurement | `@evenrealities/pretext`: `getTextWidth`, `measureTextWrap` | VERIFIED SK/font-measurement |
| Text brightness | `textColor` 0 to 4. Level 0 is the dimmest level, not "unset", and "may render effectively invisible" | VERIFIED RM:316 for the range, D/build/display for the wording |
| Global brightness | Controlled by the OS, not reachable by apps | VERIFIED D/build/display |
| Missing glyphs | Dropped silently | VERIFIED D/build/display |
| `createStartUpPageContainer` | Once per session | VERIFIED D/build/page-lifecycle |
| `rebuildPageContainer` | "all state is lost, brief flicker on hardware"; omitting `menuObject` clears the menu | VERIFIED D/build/page-lifecycle |
| Empty text | A blank event layer uses `content: ' '`: "single space — required, cannot be empty" | VERIFIED SK/glasses-ui |
| Serial calls | Await each bridge call; concurrent render and storage calls "can crash the connection". Use a timeout of a few seconds per call | VERIFIED SK/glasses-ui |

Measured on one G2 (firmware 2.2.7.14, Even App 2.2.7, SDK 0.0.13): `textContainerUpgrade` about
83 ms, `rebuildPageContainer` about 165 ms, `createStartUpPageContainer` about 100 to 135 ms.
ASSUMPTION CN/even-g2-notes performance.md. Its author calls this one data point.

### Scrolling

- There is no programmatic scroll position. VERIFIED D/build/device-apis ("Limits"), SK/device-features.
- If text overflows the event-capture container, the firmware scrolls it. VERIFIED D/build/display.
- No API reads or sets that firmware offset. VERIFIED by absence in DTS:1219 to 1533. An open request
  on SDK 0.0.16 confirms the same gap. GH#45.
- D/build/device-apis describes `SCROLL_TOP_EVENT` as "Swipe up / scroll reaches top boundary", and
  `SCROLL_BOTTOM_EVENT` the same way. VERIFIED. SK/handle-input simply maps them to swipes. They fire only
  at the boundary, not at every step, according to CN/even-g2-notes input-events.md. ASSUMPTION.
  EXPERIMENT NEEDED for a text container that does not overflow.

## 5. Input and events

`onEvenHubEvent(cb: (event: EvenHubEvent) => void): () => void`. VERIFIED DTS:1507.

`EvenHubEvent` is `{ listEvent?, textEvent?, sysEvent?, audioEvent?, menuItemClickEvent?, jsonData? }`.
VERIFIED DTS:1092.

`Sys_ItemEvent` is `{ eventType?, eventSource?, imuData?, systemExitReasonCode? }`. VERIFIED DTS:985.

| Value | `OsEventTypeList` | Label and source |
| --- | --- | --- |
| 0 | `CLICK_EVENT` | VERIFIED DTS:871 |
| 1 | `SCROLL_TOP_EVENT` | VERIFIED DTS:872 |
| 2 | `SCROLL_BOTTOM_EVENT` | VERIFIED DTS:873 |
| 3 | `DOUBLE_CLICK_EVENT` | VERIFIED DTS:874 |
| 4 | `FOREGROUND_ENTER_EVENT` | VERIFIED DTS:875 |
| 5 | `FOREGROUND_EXIT_EVENT` | VERIFIED DTS:876 |
| 6 | `ABNORMAL_EXIT_EVENT` | VERIFIED DTS:877 |
| 7 | `SYSTEM_EXIT_EVENT` | VERIFIED DTS:878 |
| 8 | `IMU_DATA_REPORT` | VERIFIED DTS:879 |
| 9 | `LONG_PRESS_EVENT` | VERIFIED DTS:881, RM:390 |
| 10 | `LONG_PRESS_RELEASE_EVENT` | VERIFIED DTS:883, RM:390 |

`EventSourceType`: 0 null, 1 right temple, 2 ring, 3 left temple. VERIFIED DTS:900.

Routing with a text container in capture (VERIFIED SK/handle-input):

- Swipes arrive on `textEvent`.
- Press and double press arrive on `sysEvent`.
- Single press has `eventType` undefined, so use `?? 0`. On hardware the key is absent altogether.
  ASSUMPTION GH#31.

Other notes:

- Scroll events can fire rapidly, and firmware can emit duplicate sys events 50 to 100 ms apart.
  ASSUMPTION CN/even-g2-notes. Debounce them. The prototype does not debounce yet, so a duplicated press
  would count twice towards the press pattern. HT-9 checks this.
- The exit dialog may clear the page on the host side and fire event 4 as it opens. "No" then fires
  event 5. ASSUMPTION CN/even-g2-notes page-lifecycle.md, which says to rebuild on that event 4. The
  prototype resends with `textContainerUpgrade` only. HT-9 checks what the lens shows after "No".
- Root page double-tap must call `shutDownPageContainer(1)`; apps that ignore it are rejected in
  review. VERIFIED D/ship/app-submission.
- A plugin's own long press may overlap other firmware uses. Support describes long press on the
  touchpad as opening the notifications menu from the main menu, and GH#18 mentions a glasses
  long-press exit dialog. EXPERIMENT NEEDED before using raw long press for anything.

### Contextual menu (the recovery path)

Requires SDK 0.0.14 or later and Even App 2.2.9 or later. VERIFIED D/build/contextual-menu.

- Declared as `menuObject: MenuContainerProperty` on create and rebuild. VERIFIED DTS:804, DTS:841.
- `MenuContainerProperty { menuItems?: MenuItemProperty[] }`, `MenuItemProperty { itemName?, itemID? }`.
  VERIFIED DTS:515, DTS:530.
- Up to 10 items. `itemID` is non-zero and unique. `itemName` is at most 32 UTF-8 bytes. VERIFIED RM:428.
- The OS raises the menu on tap then long press, and "holds it and renders it without waking your
  WebView". VERIFIED D/build/contextual-menu.
- A click arrives as `event.menuItemClickEvent.itemID`, not through `isEventCapture`. VERIFIED
  D/build/contextual-menu, RM:364.
- Whether a click wakes a suspended WebView is not stated. EXPERIMENT NEEDED.
- System slots "Display off", "Brightness" and "Close [app name]" are always present. VERIFIED
  D/build/contextual-menu.
- Opening the menu delivers `FOREGROUND_ENTER_EVENT`; dismissing it delivers `FOREGROUND_EXIT_EVENT`.
  VERIFIED D/build/contextual-menu. So events 4 and 5 are not reliable app-lifecycle signals.

## 6. Storage and state

| API | Signature | Label and source |
| --- | --- | --- |
| Write | `setLocalStorage(key: string, value: string): Promise<boolean>` | VERIFIED DTS:1358 |
| Read | `getLocalStorage(key: string): Promise<string>`; empty string when the key is missing | VERIFIED DTS:1371, SK/device-features |

`setBackgroundState` and `onBackgroundRestore` are **not available in 0.0.16**. VERIFIED: missing from
the export list at DTS:1535, and no match in DIST. See discrepancy 1.

Debounce storage writes; they share the Bluetooth link. VERIFIED SK/glasses-ui.

## 7. Background and lifecycle

| Mode | Behaviour when the phone locks | Label and source |
| --- | --- | --- |
| Local Testing (QR) | "dies the moment the phone locks" | VERIFIED D/test/local-testing |
| Private build | Survives briefly, does not pass the 5-minute lock test | VERIFIED D/test/private-testing |
| Beta build | "identically to a published app"; the only mode that appears in the glasses menu | VERIFIED D/test/beta-testing |

Beta setup needs no Even review: add your own email as a tester, accept the invite, upload the
`.ehpk`, promote to Beta, install from Me > Beta tester. VERIFIED D/test/beta-testing (no review step
is mentioned there; review comes at public submission).

| Statement | Label and source |
| --- | --- |
| Android WebView "May be suspended under memory pressure"; if the process is reclaimed, in-memory state is gone; treat as a cold start | VERIFIED D/build/background-lifecycle |
| Mic and location streams stop if the WebView is suspended. The IMU is not mentioned | VERIFIED D/build/background-lifecycle |
| Backgrounded network calls: "WebView is suspended on background; in-flight requests stall" | VERIFIED D/reference/faq |
| "Plugins are foreground-only on the glasses"; plugins cannot receive push notifications | VERIFIED D/reference/faq |
| Reviewers test with the phone locked. A glasses-launched app must render, long single-shot tasks must complete, and after two minutes idle it must still be responsive | VERIFIED D/ship/app-submission |
| The host moves the plugin to a Headless WebView when the phone backgrounds, "continuing to push frames to the glasses" | VERIFIED as text in SK/background-state. Whether current Android builds do this is EXPERIMENT NEEDED. GH#16 asks this about iOS and has no official answer |
| The host snapshots state through `window.__getStateSnapshot()` and replays with `window.__restoreState(snapshot)` | VERIFIED as text in SK/background-state. Community plugins shim these globals. ASSUMPTION GH#16 |
| "Enhanced WebView background keep-alive" in SDK 0.0.10 | VERIFIED RM:529 |
| The SDK contains a shadow-timer mechanism (`__tickShadowTimers`, `skipNextShadowTick`, `shadow-timer:`), and `src/shadow-timers.ts` is a declared side effect | VERIFIED DIST decoded strings, `package.json` |
| The host calls `__tickShadowTimers` to drive JS timers when native timers are throttled | ASSUMPTION inferred from the names; 0.0.16 "Fixed repeated execution of setTimeout / setInterval callbacks" (RM:494) fits this |
| Foreground timer stalls, ghost WebViews and silent instance death occur on Android | ASSUMPTION GH#16 (m0a) |
| `createStartUpPageContainer` returns 1 after a reload in the same launch; `rebuildPageContainer` works intermittently | ASSUMPTION GH#32, seen in the simulator by SL |
| On Android, lock the Even app in the recent-apps manager and allow background use | ASSUMPTION SUP/known, labelled for G1 |
| Microphone capture continues while locked on iPhone, SDK 0.0.16 | ASSUMPTION GH#26 (MMMMarc). iOS only, so it says little about Android |

## 8. Networking

| Rule | Label and source |
| --- | --- |
| Every `fetch`, XHR and WebSocket must match a `network` whitelist entry in `app.json`, as a full origin | VERIFIED D/build/networking, D/ship/packaging |
| Standard CORS still applies on top of the whitelist | VERIFIED D/build/networking |
| Use HTTPS in production | VERIFIED D/build/networking |
| WebSockets are allowed but may drop on background | VERIFIED D/reference/faq |

## 9. Other relevant facts

| Fact | Label and source |
| --- | --- |
| No direct Bluetooth, no pixel drawing, no audio output, no glasses camera | VERIFIED D/build/device-apis, SK/device-features |
| App logic runs on the phone; glasses only render and send input, apart from native scroll | VERIFIED D/get-started/architecture |
| Phone camera is available: `captureImageFromCamera(): Promise<AppImageAsset \| null>` | VERIFIED DTS:1390 |
| HeadUp Display is on by default. When the display is off, raising the head to the set angle turns it on. Slider 0 to 60 degrees with Reset; the 0 degree position can be recalibrated; it can be switched off in the Dashboard section of the app | VERIFIED SUP/dashboard |
| Dashboard auto-off default is 10 seconds | VERIFIED SUP/dashboard |
| Silent Mode: hold both touchpads about 1 second, or use the app home screen. No content is displayed and standard touchpad controls are disabled | VERIFIED SUP/silent |
| Starting a feature from the app during Silent Mode prompts the user to end it first | VERIFIED SUP/silent |
| No SDK API reads or changes Silent Mode, Wear Detection, HeadUp or notification settings | VERIFIED by absence in DTS:1219 to 1533 |
| Notifications: Auto Display is on by default, new ones appear on the glasses. When off they only count as unread. Even app > Settings > Notifications has a per-app list | VERIFIED SUP/notifications, SL docs/ANDROID.md |
| A setting suppresses pop-ups during full-screen features such as Navigate or Teleprompt. Earlier extracts named it "Don't disturb other features"; the 2026-11-07 extract confirmed the behaviour but not that label | VERIFIED SUP/notifications. Whether an Even Hub plugin counts is EXPERIMENT NEEDED |

Simulator:

- `imuData` is always null. VERIFIED SK/test-with-simulator, D/reference/changelog (simulator 0.6.1).
- In simulator 0.9.5, `imuControl` returned false. VERIFIED `npm run sim:e2e`. Another project reports
  the error `unknown variant imuControl`. ASSUMPTION CN/g2Rest. Handle both a false result and a rejection.
- `POST /api/input` accepts `up`, `down`, `click`, `double_click`, `long_press`, `long_press_release`,
  `context_menu`. VERIFIED D/test/simulator.

## 10. Discrepancies between docs and the package

| # | Topic | One source says | Another says | What this project does |
| --- | --- | --- | --- | --- |
| 1 | Background state API | SK/background-state: import `setBackgroundState`, `onBackgroundRestore` | Not exported by 0.0.16 (DTS:1535), no match in DIST. GH#16 still open | Do not import them. Persist with `setLocalStorage` |
| 2 | Plugin SDK version | SK/sdk-reference line 28: "Current version: 0.0.12" | Package is 0.0.16 | Treat DTS as the authority |
| 3 | Event list | SK/handle-input stops at value 8 | DTS has 9 and 10 | Use DTS |
| 4 | What IMU values are | SK/sdk-reference: "accelerometer/gyro"; SK/handle-input and D/build/device-apis: "Head orientation, motion data" | DTS states nothing; FAQ: units "TBD"; CN/zenn: accelerometer | Treat as unknown; use an adapter |
| 5 | Android suspension | D/build/background-lifecycle: "May be suspended under memory pressure" | D/reference/faq: "suspended on background"; SK/background-state: headless WebView keeps running; D/ship/app-submission: must work while locked | Unresolved. Test on a Beta build |
| 6 | Which storage survives | D/build/background-lifecycle: `localStorage` always survives; D/test/beta-testing agrees | SK/device-features: browser `localStorage` does not reliably persist | Use `bridge.setLocalStorage` as the source of truth |
| 7 | Foreground events | SK/handle-input: 4 means app resumed, 5 means app backgrounded | D/build/contextual-menu: also fired when the menu opens and closes. CN/even-g2-notes: same for the exit dialog | Do not derive app state from 4 and 5 alone |
| 8 | Event-capture validation | SK/handle-input: SDK "rejects the page with a validation error" when several containers capture | The validation code enum has no such code (DTS:660 to 673); RM:422 says "should" | Always set exactly one |
| 9 | Exit mode | SK/handle-input: mode 1 "recommended" | D/build/page-lifecycle and D/ship/app-submission: required on the root page | Use mode 1 on double-tap |
| 10 | Simulator input | SK/simulator-automation: 4 actions | D/test/simulator: 7 actions | Use the docs list |
| 11 | Simulator version | SK/test-with-simulator: v0.7.1; D/test/simulator: v0.9.3 | D/reference/changelog: 0.9.5 | Use the current npm version |
| 12 | iOS background | D/build/background-lifecycle: "clean" | GH#16 reports process kills on iOS | Not relevant to this Android user, but a sign the page is optimistic |
| 13 | Scroll events | SK/handle-input: swipe means event 1 or 2 | D/build/device-apis: swipe or boundary. CN/even-g2-notes: fired at the boundary only | Test on hardware |
| 14 | Network whitelist | D/ship/packaging: `whitelist` is optional, default `[]` | D/ship/app-submission: `network` entries need a `whitelist`. SL `app.json` has none | Always declare it |
| 15 | Long press source | D/build/device-apis: `eventSource` is absent on events 9 and 10 | DTS:988 comment and RM:390: `eventSource` identifies the temple or ring | Do not rely on it. The app does not use long press |
| 16 | Abnormal exit | SK/handle-input: stop hardware, unsubscribe, flush on event 6 | SK/handle-input also calls event 6 an "Unexpected disconnect" | The app hides, flushes and stops the IMU, but stays subscribed so recovery is possible. ASSUMPTION that this is right |
