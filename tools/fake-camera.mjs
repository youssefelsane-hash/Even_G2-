#!/usr/bin/env node
// Stands in for the camera: uploads real JPEGs exactly as the camera clients do
// (POST /v1/captures, multipart "meta" + frame0..frame2, Bearer device token,
// X-Device-Id, one Idempotency-Key reused on every retry), then polls
// GET /v1/captures/:jobId for up to 30 s like the camera's LED feedback does.
//
// Usage:
//   SERVER_URL=http://127.0.0.1:8787 DEVICE_TOKEN=... node tools/fake-camera.mjs [options] [file.jpg ...]
//
// Options:
//   --set NAME        use a test set from camera/testdata: burst (default), clean, blur, dark,
//                     glare, motion, cutoff, page2, dark-burst
//   --mode M          single | burst | clip (default: single for 1 file, burst otherwise)
//   --append ID       send as an extra page: a jobId or "previous"
//   --key K           Idempotency-Key to use (default: random). Reuse it to test duplicates
//   --no-poll         do not poll the job status after upload
//   --json            print one JSON line with the outcome (for scripts)
//
// At most 3 frames are sent (the API limit); with more files, the largest 3 are kept,
// as JPEG size is the same sharpness proxy the ESP32 firmware uses.
// No dependencies: Node 22 fetch, FormData and Blob.

import { readFile, readdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TESTDATA = path.resolve(HERE, '..', 'camera', 'testdata');
export const MAX_FRAMES = 3;
export const MAX_FRAME_BYTES = 2_500_000;

/** Width and height from a JPEG's SOF marker, or null. */
export function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xff) { i += 1; continue; }
    const len = buf.readUInt16BE(i + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    if (marker === 0xda) return null;
    i += 2 + len;
  }
  return null;
}

/** Files for a named test set. */
export async function testSet(name) {
  const dir = path.join(TESTDATA, name);
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith('.jpg')).sort();
    if (files.length) return files.map((f) => path.join(dir, f));
  } catch { /* not a folder: try a single file */ }
  return [path.join(TESTDATA, `${name}.jpg`)];
}

/** Picks up to 3 frames (largest first) and builds the meta object and frame list. */
export function prepare(buffers, { mode, appendTo, capturedAt = new Date().toISOString() } = {}) {
  if (!buffers.length) throw new Error('no frames');
  const ranked = buffers.map((b, i) => ({ b, i })).sort((x, y) => y.b.length - x.b.length || x.i - y.i);
  const kept = ranked.slice(0, MAX_FRAMES);
  const maxLen = kept[0].b.length;
  const frames = kept.map(({ b }, j) => {
    if (b.length > MAX_FRAME_BYTES) throw new Error(`frame ${j} is ${b.length} bytes; limit is ${MAX_FRAME_BYTES}`);
    const size = jpegSize(b);
    if (!size) throw new Error(`frame ${j} is not a JPEG`);
    return { name: `frame${j}`, score: Math.round((b.length / maxLen) * 1000) / 1000, ...size, data: b };
  });
  const meta = {
    mode: mode ?? (buffers.length === 1 ? 'single' : 'burst'),
    capturedAt,
    frames: frames.map(({ data, ...f }) => f),
  };
  if (appendTo) meta.appendTo = appendTo;
  return { meta, frames };
}

export function buildForm(meta, frames) {
  const form = new FormData();
  form.append('meta', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  frames.forEach((f, i) => form.append(`frame${i}`, new Blob([f.data], { type: 'image/jpeg' }), `frame${i}.jpg`));
  return form;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Upload with retry. Returns {status, body, attempts}. Never throws for HTTP errors. */
export async function upload({ server, token, deviceId, key, meta, frames, attempts = 6, baseDelayMs = 1000, log = () => {} }) {
  let last = { status: 0, body: null };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(`${server}/v1/captures`, {
        method: 'POST',
        body: buildForm(meta, frames),
        headers: { Authorization: `Bearer ${token}`, 'X-Device-Id': deviceId, 'Idempotency-Key': key },
        signal: AbortSignal.timeout(25_000),
      });
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch { body = { raw: text }; }
      last = { status: res.status, body };
      log(`attempt ${attempt}: HTTP ${res.status} ${text}`);
      if (res.ok) return { ...last, attempts: attempt };
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        return { ...last, attempts: attempt };
      }
    } catch (err) {
      log(`attempt ${attempt}: ${err.message}`);
    }
    if (attempt < attempts) await sleep(baseDelayMs * 2 ** (attempt - 1));
  }
  return { ...last, attempts };
}

/** Poll job status until a final state or the time limit. Returns the last body or null. */
export async function pollStatus({ server, token, deviceId, jobId, forMs = 30_000, everyMs = 2_000, log = () => {} }) {
  const until = Date.now() + forMs;
  let last = null;
  while (Date.now() <= until) {
    await sleep(everyMs);
    try {
      const res = await fetch(`${server}/v1/captures/${encodeURIComponent(jobId)}`, {
        headers: { Authorization: `Bearer ${token}`, 'X-Device-Id': deviceId },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) { log(`status: HTTP ${res.status}`); if (res.status === 404) return null; continue; }
      last = await res.json();
      log(`status: ${JSON.stringify(last)}`);
      if (['ready', 'retake', 'failed'].includes(last.status)) return last;
    } catch (err) {
      log(`status: ${err.message}`);
    }
  }
  return last;
}

function parseArgs(argv) {
  const opts = { files: [], poll: true, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--set') opts.set = argv[++i];
    else if (a === '--mode') opts.mode = argv[++i];
    else if (a === '--append') opts.appendTo = argv[++i];
    else if (a === '--key') opts.key = argv[++i];
    else if (a === '--no-poll') opts.poll = false;
    else if (a === '--json') opts.json = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else opts.files.push(a);
  }
  if (opts.mode && !['single', 'burst', 'clip'].includes(opts.mode)) throw new Error('--mode must be single, burst or clip');
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const server = (process.env.SERVER_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
  const token = process.env.DEVICE_TOKEN;
  const deviceId = process.env.DEVICE_ID ?? 'fakecam';
  if (!token) { console.error('Set DEVICE_TOKEN'); process.exit(2); }
  const files = opts.files.length ? opts.files : await testSet(opts.set ?? 'burst');
  const buffers = await Promise.all(files.map((f) => readFile(f)));
  const { meta, frames } = prepare(buffers, { mode: opts.mode, appendTo: opts.appendTo });
  const key = opts.key ?? randomBytes(16).toString('hex');
  const log = opts.json ? () => {} : (m) => console.log(m);
  log(`uploading ${frames.length} of ${buffers.length} frame(s), key ${key}`);
  const up = await upload({ server, token, deviceId, key, meta, frames, log });
  const out = { status: up.status, jobId: up.body?.jobId ?? null, duplicate: Boolean(up.body?.duplicate), key, final: null };
  if (up.status >= 200 && up.status < 300 && out.jobId && opts.poll) {
    out.final = await pollStatus({ server, token, deviceId, jobId: out.jobId, log });
  }
  if (opts.json) console.log(JSON.stringify(out));
  process.exit(up.status >= 200 && up.status < 300 ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
