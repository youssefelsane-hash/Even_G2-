# Backend API (v1)

This is the contract between the camera, the backend and the glasses app. It describes the code in `backend/src`
(mainly `server.ts`, `captureRequest.ts`, `store.ts`, `cameraConfig.ts`). If the two ever disagree, the code is
wrong or this file is out of date. Fix one of them in the same change.

Status: tested only with automated tests and the mock AI provider. No real camera, phone or glasses has used it yet.

## Basics

- Plain HTTP on `127.0.0.1:8787` by default. Put a TLS reverse proxy in front of it for anything outside the machine.
- All responses are JSON with `Cache-Control: no-store`. Errors look like `{"error": "short message"}`.
- Unknown paths return 404. A known path with the wrong method returns 405.
- `OPTIONS` on any path returns 204 with CORS headers. Allowed headers: `Authorization`, `Content-Type`,
  `Idempotency-Key`, `X-Device-Id`. Allowed methods: `GET, POST, PUT, OPTIONS`. The origin comes from `CORS_ORIGIN`.

### Tokens

| Role | Who holds it | Can call |
| --- | --- | --- |
| Device token | The camera | `POST /v1/captures`, `GET /v1/captures/:jobId`, `GET /v1/camera/config` |
| Client token | The glasses app and the phone panel | `GET /v1/results`, `POST /v1/acks`, `POST /v1/presence`, `GET` and `PUT /v1/camera/config` |

Send it as `Authorization: Bearer <token>`. The server stores only SHA-256 digests and compares them in constant time.

Each device token is bound to one device ID on the server (`DEVICE_TOKENS=cam1:<sha256>`). The device ID comes from
the token, not from the request. `X-Device-Id` is optional; if it is sent and does not match the token's device,
the answer is 403.

Wrong or missing token: 401. After `AUTH_FAILURES_PER_MINUTE` (default 10) failures from one address within a
minute, that address gets 429 with `Retry-After` for `AUTH_BLOCK_MS` (default 60 s), even with a correct token.

## POST /v1/captures

One button press. Device token.

Headers:

| Header | Rule |
| --- | --- |
| `Authorization` | `Bearer <device token>` |
| `Idempotency-Key` | 8 to 64 characters from `A-Z a-z 0-9 _ -`. One new key per press. Reuse the same key for every retry of that press |
| `Content-Type` | `multipart/form-data; boundary=...` |
| `X-Device-Id` | Optional. Must match the token's device |

Body parts:

| Part | Content-Type | Rule |
| --- | --- | --- |
| `meta` | `application/json` (any type is read as JSON) | Exactly one. Fields below |
| `frame0`, `frame1`, `frame2` | `image/jpeg` | One per entry in `meta.frames`, in the same order, starting at `frame0`. Each at most 2.5 MiB (2,621,440 bytes) |

No other part names are accepted. The whole body may be at most 3 x 2.5 MiB + 256 KiB.

`meta`:

```json
{
  "mode": "burst",
  "appendTo": "previous",
  "capturedAt": "2026-11-08T09:30:00Z",
  "battery": 76,
  "frames": [
    { "name": "f2", "score": 0.81, "width": 2048, "height": 1536, "sharpness": 412.5, "brightness": 128, "clipped": 0.01 },
    { "name": "f0", "score": 0.66, "width": 2048, "height": 1536 }
  ]
}
```

| Field | Rule |
| --- | --- |
| `mode` | `single` (exactly 1 frame), `burst` or `clip` (1 to 3 frames) |
| `appendTo` | Optional. A `jobId` of this device, or `"previous"` for this device's most recent question. Either way the earlier question must be younger than `APPEND_MAX_AGE_MS` (default 10 minutes). Used by a double press to add a page |
| `capturedAt` | ISO 8601 time from the camera clock, at most 40 characters. Informational only |
| `battery` | Optional, 0 to 100 |
| `frames[].name` | 1 to 32 characters from `A-Z a-z 0-9 _ . -`, unique within the press |
| `frames[].score` | 0 to 1. The camera's overall quality score, higher is better |
| `frames[].width`, `height` | Integers 1 to 10000. Must equal the size in the JPEG header, or the request fails with 400 |
| `frames[].sharpness` | Optional, 0 or more. Raw Laplacian variance or a proxy. Stored only |
| `frames[].brightness` | Optional, mean luma 0 to 255. Helps pick the retake reason |
| `frames[].clipped` | Optional, fraction 0 to 1 of near-white pixels. Helps detect glare |
| `frames[].issues` | Optional list of the camera's own verdict after decoding the frame: any of `too dark`, `too bright`, `glare`, `blurry`. Empty or absent means the camera found no problem. Unknown names are ignored; anything other than a list of short strings is a 400 |

`sharpness`, `brightness`, `clipped` and `issues` are additions to the original design. They are optional. The
Linux camera client sends all four; the ESP32 firmware sends none of them.

### What the server checks

The server never decodes pixels. For each frame it reads the JPEG header and checks, in this order:

1. Width at least `MIN_FRAME_WIDTH` (480) and height at least `MIN_FRAME_HEIGHT` (360), else rejected as `blurry`.
2. `issues`, if sent: a frame the camera flagged is rejected with that reason (`too dark`; `glare` for `glare` or
   `too bright`; `blurry`). The camera is the only part that decoded the pixels, so its verdict wins over the cheap
   checks below. Before this rule, a press the camera judged blurry in every frame still went to the AI with a
   score above `MIN_FRAME_SCORE` (found by `tools/e2e-system`). The camera's thresholds are in
   `camera/linux/evencam/scoring.py` and are ASSUMPTIONS too.
3. `brightness` below 35, if sent: rejected as `too dark`.
4. `clipped` above 0.2, if sent: rejected as `glare`.
5. `score` below `MIN_FRAME_SCORE` (0.15): rejected as `too dark` if `brightness` is below 60, else `blurry`.
6. Fewer than `MIN_BYTES_PER_PIXEL` (0.01) bytes per pixel: rejected as `blurry` if `brightness` is 60 or more,
   else `too dark`. A dark or very blurred JPEG compresses to almost nothing.

All thresholds are ASSUMPTIONS and must be tuned on real camera output (EXPERIMENT NEEDED).

A rejected frame is recorded (name, score, reason) but its image is not written to disk. If every frame of a press
is rejected, the job goes straight to `retake` and no AI call is made.

### Responses

`202 Accepted`:

```json
{ "jobId": "3f1c...", "status": "queued", "glassesListening": true }
```

- `glassesListening`: whether a glasses app had a long-poll open in the last `POLL_GRACE_MS` (5 s). The camera
  can show a distinct LED pattern when it is false. Added to the original design.
- Same `Idempotency-Key` again (a retry): 202 with the same `jobId`, `"duplicate": true`, and the job's current
  `status` (`queued`, `processing`, `ready`, `retake` or `failed`). This also holds for two attempts that arrive at
  the same moment and across server restarts. Keys are scoped per device and kept as long as the job record.
- A retry of an accepted press is answered before the body is read and is not counted by the rate limit.

Page merging with `appendTo`:

- If the earlier question has not started processing yet, the new frames are added to it as the next page. The
  reply carries **the earlier question's `jobId`**. One AI call covers all pages.
- If it is already processing or finished, a new job is created with `appendedTo` set to the earlier job. It
  includes the earlier pages' photos if they are still on the server (see retention), otherwise the earlier
  transcript as text. It is processed only after the earlier job has finished, so results arrive in order.
- `"previous"` with no recent question of this device starts a new question. It is not an error.
- The same holds for a `jobId` that is unknown (purged, or the server data was reset), belongs to another device, or
  is older than `APPEND_MAX_AGE_MS`: the press becomes a new question (202, no `appendedTo`), so the camera never
  throws the photos away because of a stale id.

Errors:

| Status | When |
| --- | --- |
| 400 | Bad `Idempotency-Key`, not multipart, malformed multipart, missing or duplicate `meta`, `meta` not JSON or invalid, wrong or missing frame parts, frame count not matching `meta.frames`, JPEG size not matching `meta` |
| 401 | Missing or wrong device token |
| 403 | `X-Device-Id` does not match the token |
| 409 | The question already has `MAX_PAGES` pages (default 4) |
| 413 | A frame over 2.5 MiB, or the whole body over the limit |
| 415 | A frame part not typed `image/jpeg`, or not a complete JPEG (no start marker, no end marker, no frame header) |
| 429 | More than `CAPTURES_PER_MINUTE` (default 10) new presses per minute from this device, or the address is blocked. `Retry-After` gives seconds |

Camera retry rule: on a network error, 5xx or 429, retry the same press with the same key, with backoff, honouring
`Retry-After`. Do not retry 400, 401, 403, 409, 413 or 415: the request itself is wrong.

## GET /v1/captures/:jobId

Device token. For camera feedback after upload. Contains no answer text.

`200`: `{"status": "processing"}` or `{"status": "retake", "retakeReason": "glare"}`.

`status` is one of `queued`, `processing`, `ready`, `retake`, `failed`. `retakeReason` is present only for
`retake`. It is one of `too dark`, `blurry`, `page cut off`, `glare`, `too far`, `no text found`.

404 if the job does not exist, was purged, or belongs to another device. 429 after `STATUS_POLLS_PER_MINUTE`
(default 120) per device.

Suggested camera use: poll every 1 to 2 s for up to `statusPollSeconds` (from the camera config, default 30), stop at
`ready`, `retake` or `failed`, and show the matching LED pattern.

## GET /v1/results?cursor=N&wait=S

Client token. The glasses app's long-poll. It is the only way a result leaves the server: there are no push
notifications and no ntfy in V1.

| Parameter | Rule |
| --- | --- |
| `cursor` | Optional, default `0`. Non-negative integer, up to 15 digits. Send back the `cursor` from the previous reply |
| `wait` | Optional, default `0`. Seconds to hold the request if nothing is new. 0 to 999 is accepted, values above 30 are treated as 30 |

The server answers at once if there are events after `cursor`, otherwise when one arrives or `wait` runs out.

`200`:

```json
{
  "cursor": "41",
  "more": false,
  "events": [
    {
      "jobId": "3f1c...",
      "seq": 41,
      "status": "ready",
      "photos": 3,
      "pages": 1,
      "createdAt": "2026-11-08T09:30:01.120Z",
      "result": {
        "short": "x = 4. Subtract 6, then divide by 2.",
        "detail": ["Subtract 6 from both sides: 2x = 8.", "Divide both sides by 2: x = 4."],
        "label": "CHECKED",
        "caveats": [],
        "pages": 1,
        "usedFrames": 3,
        "question": "Solve for x: 2x + 6 = 14"
      }
    }
  ]
}
```

Rules:

- `cursor` is a string holding an integer. Store it and send it back.
- Each event is the **latest state** of one job. A job appears again whenever its visible state changes: created,
  page merged, processing, finished. Several changes between two polls are combined into one event. De-duplicate by
  `jobId`, keeping the highest `seq`.
- At most 50 events per reply, oldest first. `more: true` means poll again at once.
- `cursor=0` returns every job the server still has (results are kept 30 days). This is the cold-start path.
- A cursor larger than anything the server has (for example after the server's data was wiped) is treated as `0`.
- Acks never create events.
- Glasses app (not a server rule): a catch-up from `cursor=0`, or a reply whose events go back below the cursor
  it sent, treats jobs created more than 15 minutes earlier (by `createdAt`) as history: no camera status, no
  retake, answers stored as already seen. A reply with no events that came back in under 1 s is followed by a
  pause (1 s, doubling to 30 s), and `more: true` with no events does not trigger an immediate poll.

Event fields:

| Field | Meaning |
| --- | --- |
| `jobId`, `seq` | Job and the sequence number of this state |
| `status` | `received`, `processing`, `ready`, `retake` or `failed`. `received` is the stream's name for `queued`. A retry after an AI error is not shown; the job stays `processing` |
| `photos` | Frames received for this question so far, including rejected ones and earlier pages. For "Received n photos" |
| `pages` | Pages in the question so far |
| `appendedTo` | Present on a continuation job: the earlier job it extends. The app can replace that earlier answer |
| `createdAt` | ISO time the server created the job |
| `result` | Present for `ready` and `retake` |
| `error` | Present for `failed`: `AI unavailable, try again`, `AI could not process this capture`, or `expired` |

`result` fields:

| Field | Meaning |
| --- | --- |
| `short` | At most 140 characters. For `retake`: `Retake: <reason>` |
| `detail` | Up to 8 strings, each at most 400 characters |
| `label` | `CHECKED`, `LIKELY`, `UNSURE` or `RETAKE`, computed by the backend (below) |
| `caveats` | Up to 6 strings, each at most 200 characters. Includes `Could not read: ...` for parts the AI could not read, `Page N photos were unusable (...)`, and a warning when a computer check failed |
| `pages`, `usedFrames` | Pages in the question, and images sent to the AI |
| `retakeReason` | Only for `retake` |
| `question` | The question as the AI read it, so the user can spot a misread. Added to the original design |

All text is plain text: control characters removed, runs of spaces and tabs collapsed, long text cut with `...`.

### Labels

The model never writes the label. The backend computes it from the model's separate `reading` and `reasoning`
judgements and from SymPy checks of calculation steps:

| Label | Rule |
| --- | --- |
| `RETAKE` | The model says nothing is readable (status `retake`), or every frame failed the server checks |
| `UNSURE` | Reading `unclear`, or reasoning `unsure`, or any SymPy check found a step wrong, or the photos disagreed somewhere the model could not settle (a caveat says so) |
| `CHECKED` | Reading `clear`, reasoning `sure`, no unreadable parts, no unsettled photo conflict, at least one checkable step, and every check verified |
| `LIKELY` | Everything else, including reading `partial` |

`CHECKED` means a computer confirmed the listed calculation steps. It does not mean the page was read correctly.
The spec's separate `CHECK FAILED` label is folded into `UNSURE` plus a caveat, so the label set stays at four.

## POST /v1/acks

Client token. Body: `{"jobId": "<uuid>", "stage": "received" | "displayed"}`.

- `received`: the app has stored the result. `displayed`: the user could see it (VISIBLE). `displayed` also sets
  `received` if it was not set. Each time is set once and never changes.
- `200`: `{"jobId": "...", "receivedAt": "<ISO>" | null, "displayedAt": "<ISO>" | null}`.
- 400 for a bad body, 404 for an unknown job. Body at most 8 KiB.

Acks are bookkeeping. In V1 nothing on the server acts on a missing ack.

## POST /v1/presence

Client token. Body: `{"displayMode": "VISIBLE" | "HIDDEN" | "REMOVED" | "UNKNOWN"}`.

`200`: `{"displayMode": "HIDDEN", "updatedAt": "<ISO>", "hidden": true}`. `hidden` is true for everything except
`VISIBLE`. Before any report the stored mode is `UNKNOWN`. The value is saved on disk.

V1 sends no notifications, so the display mode changes nothing the server does. Results are always produced and
always wait for the app, which alone decides whether to show them. It is stored so any later fallback starts from
"hidden unless known visible".

## GET /v1/camera/config and PUT /v1/camera/config

`GET`: device or client token. `PUT`: client token only, so a camera cannot change its own settings.

```json
{
  "version": 3,
  "updatedAt": "2026-11-08T09:00:00.000Z",
  "defaultMode": "burst",
  "burstFrames": 4,
  "uploadFrames": 3,
  "longPressMode": "clip",
  "clipSeconds": 2,
  "resolution": "2048x1536",
  "jpegQuality": 85,
  "minUploadScore": 0.15,
  "statusPollSeconds": 30
}
```

| Field | Values | Default | Meaning |
| --- | --- | --- | --- |
| `version` | integer | 1 | Read-only. Goes up by one on every PUT |
| `updatedAt` | ISO time | | Read-only |
| `defaultMode` | `burst`, `single` | `burst` | What a single press does |
| `burstFrames` | 1 to 8 | 4 | N, frames captured per burst |
| `uploadFrames` | 1 to 3 | 3 | K, best frames uploaded. Lowered to `burstFrames` if larger |
| `longPressMode` | `clip`, `burst` | `clip` | Linux camera. The ESP32 always does an 8-frame burst |
| `clipSeconds` | 1 to 4 | 2 | Clip length on Linux. The clip never leaves the camera |
| `resolution` | `1280x720`, `1600x1200`, `1920x1080`, `2048x1536`, `2592x1944` | `2048x1536` | Capture size |
| `jpegQuality` | 50 to 95 | 85 | Encoder quality |
| `minUploadScore` | 0 to 1 | 0.15 | Camera skips frames below this when better ones exist |
| `statusPollSeconds` | 0 to 60 | 30 | How long the camera polls job status after an upload |

`PUT` takes any subset of the editable fields and returns the full config. `version` and `updatedAt` in the body
are ignored, so a client can send back what it read. Any other field, or a value out of range, is 400. There is no
field for the LED, audio, timed capture or remote capture, by design.

## GET /v1/healthz

No token. `200 {"ok": true}`.

## Retention and privacy

| Data | Kept |
| --- | --- |
| Rejected frames | Never written to disk |
| Accepted frames | Until the job ends, plus `APPEND_WINDOW_MS` (default 2 minutes) so a double press can add a page with the earlier photos. Deleted by the next sweep after that, so up to one `SWEEP_INTERVAL_MS` later. With `APPEND_WINDOW_MS=0` they are deleted the moment the job ends, and earlier pages are carried as text. A continuation job holds its own copies, deleted the same way |
| Any image, any state | Hard limit `IMAGE_MAX_AGE_MS`, 1 hour, counted from when that photo reached the server. A job not finished by then fails with `expired`. Copies of earlier pages inside a continuation keep the original photo's time, so they go at the same moment as the original |
| Job record with result text | `RESULT_TTL_MS`, 30 days after it finished, then deleted with its idempotency keys |

A sweep runs every `SWEEP_INTERVAL_MS` (30 s) and at start. On start the server also removes image folders that
belong to no job, and moves unreadable job files aside as `*.corrupt`.

Logs contain job IDs, counts, labels and timings, never answer text or images.

## AI request

All accepted frames of a question go to the provider in **one** request, at most `MAX_AI_IMAGES` (12) images and
`MAX_AI_BYTES` (20 MiB). When there are more, each page keeps its best frame first. Every image is preceded by a
label such as `Page 2 of 3, photo 1 of 2 (camera rank 1, score 0.81; a hint only)`. The model is told the photos of
one press show the same view, to read their union from the clearest photo for each part, never to guess text no
photo shows clearly, and to report places where photos disagree (`frameConflicts`). An unsettled conflict makes the
label `UNSURE`. `CHECKED` also needs no unreadable parts.

The provider is chosen by `AI_PROVIDER`: `anthropic` (default model `claude-opus-5-5`, adaptive thinking, effort
from `AI_EFFORT`, structured output, server-side refusal fallback) or `mock`. Retryable failures are retried
`MAX_ATTEMPTS` times with exponential backoff from `RETRY_BASE_MS`.

### Mock provider fixtures

The mock reads a JPEG comment segment in any frame. `backend/src/testing/jpeg.ts` (`makeTestJpeg`) builds such files.

| Comment | Result |
| --- | --- |
| none or `mock:ready` | `ready`, two checkable steps: `CHECKED` with SymPy, `LIKELY` without |
| `mock:likely` | `ready`, `LIKELY` |
| `mock:partial` | `ready`, `LIKELY`, caveat `Could not read: the last line of the page` |
| `mock:unsure` | `ready`, `UNSURE` |
| `mock:mismatch` | `ready`, `UNSURE`, check-failed caveat (with SymPy) |
| `mock:conflict` | `ready`, `UNSURE`, "Photos disagree about: ..." caveat |
| `mock:retake:<reason>` | `retake` with that reason, for example `mock:retake:glare` |
| `mock:fail` | `failed` after one attempt |
| `mock:flaky` | Fails once with a retryable error, then `ready` |
| `mock:slow` | `ready` after `MOCK_SLOW_MS` (2000 ms) |
