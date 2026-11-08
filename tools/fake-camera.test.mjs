// node --test tools/fake-camera.test.mjs
// Runs the fake camera against an in-process stand-in server. No backend needed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jpegSize, prepare, testSet, upload, pollStatus, TESTDATA } from './fake-camera.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let server;
let base;
const seen = [];
const keys = new Map();
let failNext = 0;

before(async () => {
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.headers.authorization !== 'Bearer tok' || req.headers['x-device-id'] !== 'cam1') return send(401, { error: 'unauthorized' });
    if (req.method === 'POST' && req.url === '/v1/captures') {
      if (failNext > 0) { failNext--; return send(503, { error: 'busy' }); }
      const key = req.headers['idempotency-key'];
      if (keys.has(key)) return send(200, { jobId: keys.get(key), status: 'queued', duplicate: true });
      const form = await new Response(body, { headers: { 'content-type': req.headers['content-type'] } }).formData();
      const jobId = `job${keys.size + 1}`;
      keys.set(key, jobId);
      const meta = JSON.parse(await form.get('meta').text());
      const frames = [];
      for (let i = 0; i < 3; i++) {
        const f = form.get(`frame${i}`);
        if (f) frames.push({ type: f.type, bytes: Buffer.from(await f.arrayBuffer()) });
      }
      seen.push({ jobId, key, meta, frames, metaType: form.get('meta').type });
      return send(202, { jobId, status: 'queued' });
    }
    if (req.method === 'GET' && req.url.startsWith('/v1/captures/')) {
      return send(200, { status: 'retake', retakeReason: 'blurry' });
    }
    send(404, { error: 'not found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

test('jpegSize reads test images', async () => {
  assert.deepEqual(jpegSize(await readFile(path.join(TESTDATA, 'clean.jpg'))), { width: 640, height: 480 });
  assert.equal(jpegSize(Buffer.from('not a jpeg')), null);
});

test('prepare keeps the 3 largest frames, largest first', async () => {
  const bufs = await Promise.all((await testSet('burst')).map((f) => readFile(f)));
  const { meta, frames } = prepare(bufs, { capturedAt: '2026-11-08T10:00:00.000Z' });
  assert.equal(meta.mode, 'burst');
  assert.equal(frames.length, 3);
  assert.equal(frames[0].data, bufs[1]); // the sharp frame compresses least
  assert.equal(meta.frames[0].score, 1);
  assert.deepEqual(Object.keys(meta.frames[0]).sort(), ['height', 'name', 'score', 'width']);
  assert.equal(prepare([bufs[0]]).meta.mode, 'single');
  assert.equal(prepare([bufs[0]], { appendTo: 'previous' }).meta.appendTo, 'previous');
  assert.throws(() => prepare([]), /no frames/);
  assert.throws(() => prepare([Buffer.from('xx')]), /not a JPEG/);
});

test('upload sends multipart that a standard parser reads, and duplicates return the same job', async () => {
  const bufs = await Promise.all((await testSet('burst')).map((f) => readFile(f)));
  const { meta, frames } = prepare(bufs);
  const args = { server: base, token: 'tok', deviceId: 'cam1', key: 'k'.repeat(32), meta, frames, baseDelayMs: 5 };
  const a = await upload(args);
  assert.equal(a.status, 202);
  const got = seen.at(-1);
  assert.deepEqual(got.meta, meta);
  assert.equal(got.metaType, 'application/json');
  assert.equal(got.frames.length, 3);
  assert.equal(got.frames[0].type, 'image/jpeg');
  assert.ok(got.frames[0].bytes.equals(bufs[1]));
  const b = await upload(args);
  assert.equal(b.status, 200);
  assert.equal(b.body.jobId, a.body.jobId);
  assert.equal(b.body.duplicate, true);
});

test('upload retries 503 with the same key', async () => {
  failNext = 2;
  const { meta, frames } = prepare([await readFile(path.join(TESTDATA, 'clean.jpg'))]);
  const r = await upload({ server: base, token: 'tok', deviceId: 'cam1', key: 'retry-key-123', meta, frames, baseDelayMs: 5 });
  assert.equal(r.status, 202);
  assert.equal(r.attempts, 3);
});

test('bad token is not retried', async () => {
  const { meta, frames } = prepare([await readFile(path.join(TESTDATA, 'clean.jpg'))]);
  const r = await upload({ server: base, token: 'nope', deviceId: 'cam1', key: 'badtok-key-1', meta, frames, baseDelayMs: 5 });
  assert.equal(r.status, 401);
  assert.equal(r.attempts, 1);
});

test('pollStatus returns the final status', async () => {
  const s = await pollStatus({ server: base, token: 'tok', deviceId: 'cam1', jobId: 'job1', forMs: 1000, everyMs: 10 });
  assert.deepEqual(s, { status: 'retake', retakeReason: 'blurry' });
});

test('command line, JSON output', async () => {
  const child = spawn(process.execPath, [path.join(HERE, 'fake-camera.mjs'), '--set', 'glare', '--json', '--no-poll'], {
    env: { PATH: process.env.PATH, SERVER_URL: base, DEVICE_TOKEN: 'tok', DEVICE_ID: 'cam1' },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const code = await new Promise((r) => child.on('close', r));
  assert.equal(code, 0);
  const res = JSON.parse(out.trim());
  assert.equal(res.status, 202);
  assert.match(res.jobId, /^job\d+$/);
  assert.equal(seen.at(-1).meta.mode, 'single');
});
