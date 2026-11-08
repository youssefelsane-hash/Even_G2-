# Full-system test

Runs the three parts together on one computer and checks what the user would see on the lens and on the camera LED:

- the **backend** (`backend/`) with the mock AI (every answer takes 3 s, so "Reading" can be seen),
- the **Linux camera client** (`camera/linux/`), the real code and loops, with a fake button and a fake sensor that
  "sees" images from `camera/testdata`,
- the **glasses app** (`app/`) in the official Even Hub simulator, screenshots taken from the simulator's real
  glasses framebuffer.

**This is not a hardware test.** No real camera, button, LED, phone or glasses take part. The simulator has no IMU and
no wear sensor, so head shakes and putting the glasses on or off are injected inside the app. The mock AI never looks
at pixels. Passing here means the parts agree with each other; it says nothing about real optics, real Bluetooth or a
locked Android phone.

## Run

Set up once: `npm install` in `backend/` and `app/`, and the camera's Python environment
(`python3 -I -m venv camera/.venv && camera/.venv/bin/python -I -m pip install -r camera/requirements-dev.txt`).
Optional: `npm run setup:python` in `backend/` for the SymPy check; without it the run uses `VERIFY_MATH=false`.

```bash
node tools/e2e-system/run.mjs                      # all scenarios, about 3 minutes
node tools/e2e-system/run.mjs --only burst,hidden  # some scenarios (boot is needed first in practice)
node tools/e2e-system/run.mjs --screens /tmp/shots # screenshots somewhere other than docs/screenshots
node tools/e2e-system/run.mjs --keep-tmp           # keep the backend data and camera queue for a look
```

Ports 5174 (Vite) and 9898 (simulator) must be free. Everything listens on 127.0.0.1 only. The backend data and the
camera queue go to a new temporary folder (`E2E_TMP` chooses the parent), deleted at the end. Device and client tokens
are generated for each run and exist only in memory and that folder. At the end the app is told to forget the test
server, token and cursor (the simulator keeps WebView storage between runs), and every process the script started is
stopped, also when a scenario fails. Exit code 0 means every scenario passed.

## How it is wired

```
camera_agent.py --(camera proxy)--> backend <--(app proxy)-- app in simulator
      ^ stdin commands                ^ read-only checks          ^ control server (dev-only driver)
      └──────────────────────── run.mjs ─────────────────────────┘
```

- `camera_agent.py` builds the same objects as `python -m evencam` (button loop every 5 ms, uploader thread). Presses
  are made by changing the fake button level with real timing, so debounce and the press grammar decide what a press
  is. It prints every LED pattern as a JSON line.
- Two small TCP proxies let the test cut the camera's or the app's network separately, and drop one upload reply after
  the server has received the request (to force a retry with the same Idempotency-Key).
- `app/src/e2eDriver.ts` is loaded only by the Vite dev server with `?e2e=...` and is not in a production build. It
  polls the control server for commands (wear on/off, play a synthetic shake, press, reload, forget) and replies with
  the app state and the text the lens would show.

## Scenarios

| Name | What happens | What is checked |
| --- | --- | --- |
| `boot` | App starts, glasses connect, worn, shake | Lens dark at start, camera loaded its config from the backend, presence reaches the backend |
| `burst` | Single press on a sharp page | "Reading" on the lens, then this job's answer; best 2 of 4 frames uploaded; LED captured, uploaded, ready |
| `dark` | Single press, every frame too dark | Camera takes a second burst by itself, then the lens shows "Retake: too dark", LED retake |
| `blurry` | Single press, every frame blurry | Server answers retake "blurry", lens and LED say so |
| `glare` | Single press, glare on every frame | Server answers retake "glare", lens and LED say so |
| `multipage` | Single press, then double press on page 2 | One appended capture, a 2-page answer replaces page 1 on the lens ("2p" in the header) |
| `clip` | Long press | One clip capture, at most 3 frames sent, answer on the lens, camera queue empty |
| `hidden` | Hide, two presses | Lens dark while processing and with two answers waiting; on restore the newest shows with "+1 new"; a press opens the other |
| `restart` | Backend killed (SIGKILL) during the AI call, restarted | Same job finishes once, answer on the lens, camera LED still gets "ready" |
| `camera-offline` | Camera network down, press, network back after 4 s | LED queued-offline, then uploaded and ready; answer on the lens |
| `app-offline` | App network down while a job finishes | App gets nothing while offline, then exactly one new answer after recovery |
| `duplicates` | Upload reply lost; bouncy button contact | One job for the retried press, one answer stored; chatter gives one capture |
| `removed` | Glasses taken off during processing | Lens dark, presence REMOVED; putting them back on stays dark; a shake shows the answer |
| `reload` | App restarted while hidden with a new answer | Lens dark after restart, reconnect and wear; nothing doubled; a shake shows the answer |
| `retention` | Wait after the last job | No image left on the backend (append window set to 20 s for this run) |

Screenshots (`docs/screenshots/e2e-*.png`) are the simulator's glasses framebuffer at the named moments. The header
shows "! sensor lost" in most of them: the simulator sends no IMU data between the injected motions, which is expected
there.

## Found by this test

- The camera judged every frame of a blurry or glare press as bad, but the server's cheaper checks (score, brightness,
  clipped) let the frames through, so the AI was asked anyway and the mock answered with a confident result. The camera
  now sends its verdict per frame (`frames[].issues`) and the server rejects flagged frames (see `docs/API.md`).
- The simulator keeps the app's localStorage between runs. A run that left its test server in storage made the next
  plain `npm run sim:e2e` log fetch errors. The run now ends with a `forget` command.
