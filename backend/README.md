# Backend

Receives photos from the camera, sends all frames of a question to the AI in one request, and holds the result
until the glasses app fetches it. The API is in [../docs/API.md](../docs/API.md).

**Tested with automated tests and the mock AI only.** It has not been used by a real camera, phone or glasses, and
the Anthropic provider has not been called from this repository (only type-checked).

Ported from the Study Lens backend and changed. Study Lens faults that are fixed here:

| Study Lens fault | Here |
| --- | --- |
| ntfy fallback could put answers on the lens in Hidden mode | No notification code at all. The glasses app's long-poll is the only way out |
| Images were never deleted | Deleted when the job ends (after a short append window), hard limit 1 hour, result text 30 days |
| Idempotency race: the key was recorded after the image write | The key is reserved before the first `await`; concurrent attempts share one job |
| Any device token could claim any device ID | Tokens are bound to a device ID; `X-Device-Id`, when sent, must match the token |
| Bound to `0.0.0.0`, no rate limits | Binds to `127.0.0.1`; per-device capture limit; blocks addresses after repeated bad tokens |
| One photo per request | Up to 3 frames per press, several pages per question, fused in one AI call |

## Run

Node 22.18 or later.

```bash
npm install
npm run typecheck
npm test                    # no network, no key, mock provider
npm run setup:python        # optional: .venv with pinned SymPy for step checks (tests use it if present)
cp .env.example .env        # then fill in tokens, see below
npm start
```

Tokens:

```bash
node scripts/make-token.mjs device cam1   # prints the camera's token and a DEVICE_TOKENS entry
node scripts/make-token.mjs client        # prints the glasses app's token and a CLIENT_TOKEN_SHA256 entry
```

Only the digests go into `.env`. The raw tokens go into the camera config and the glasses app settings, never into
this repository. `.env`, `data/` and `.venv/` are git-ignored.

To try it without a key: `AI_PROVIDER=mock npm start`. Test JPEGs with a fixture comment can be built with
`makeTestJpeg()` from `src/testing/jpeg.ts`.

## Layout

| File | Job |
| --- | --- |
| `src/server.ts` | HTTP routes, auth, rate limits, long-poll |
| `src/captureRequest.ts` | Multipart and `meta` validation, per-frame checks |
| `src/multipart.ts`, `src/jpeg.ts` | Dependency-free multipart parser and JPEG header reader |
| `src/quality.ts` | Frame checks without decoding pixels; retake reason |
| `src/store.ts` | Jobs on disk, idempotency, page merging, event stream, retention sweep |
| `src/worker.ts` | One job at a time; frame selection, AI call, SymPy, retries |
| `src/fusion.ts` | Frame selection across pages, label rules, text limits |
| `src/providers/` | `anthropic.ts` (prompt, request, schema), `mock.ts` (fixtures) |
| `src/cameraConfig.ts`, `src/presence.ts` | Camera settings, display mode and "is the app listening" |
| `scripts/verify_math.py` | SymPy checker, run with `python -I` in a subprocess with a timeout |

## Known limits

- One process, one worker. Fine for one person; not built to scale out.
- Rate limits and the bad-token blocker live in memory and reset on restart.
- Quality thresholds are guesses (ASSUMPTION). Tune them with real frames from the chosen camera (EXPERIMENT NEEDED).
- No pixel decoding on the server. A pure-JS decoder of 2-5 MP JPEGs would block the event loop for a noticeable
  time per frame, so the server trusts the camera's scores plus header and size checks, and leaves the final
  readability call to the AI.
- The answer language is one server setting (`ANSWER_LANGUAGE`). Whether the glasses render non-Latin scripts such
  as Arabic is unknown (EXPERIMENT NEEDED).
