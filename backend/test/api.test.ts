import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { CLIENT, DEVICE, DEVICE2, HAVE_SYMPY, captureBody, multipart, startApp } from './helpers.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { makeTestJpeg } from '../src/testing/jpeg.ts';

test('auth: roles are enforced and device tokens are bound to their device', async () => {
  const app = await startApp();
  try {
    assert.equal((await fetch(`${app.base}/v1/healthz`)).status, 200, 'health needs no token');
    assert.equal((await app.capture({ token: 'nope' })).status, 401);
    assert.equal((await app.capture({ token: CLIENT })).status, 401, 'client token cannot upload');
    assert.equal((await app.get('/v1/results', DEVICE)).status, 401, 'device token cannot read results');
    assert.equal((await app.get('/v1/results', '')).status, 401);
    assert.equal((await app.send('POST', '/v1/acks', { jobId: 'x', stage: 'received' }, DEVICE)).status, 401);
    assert.equal((await app.send('PUT', '/v1/camera/config', { burstFrames: 2 }, DEVICE)).status, 401, 'camera cannot change its own settings');
    const spoof = await app.capture({ token: DEVICE2, headers: { 'X-Device-Id': 'cam1' } });
    assert.equal(spoof.status, 403, 'cam2 token cannot claim cam1');
    const own = await app.capture({ token: DEVICE2, headers: { 'X-Device-Id': 'cam2' } });
    assert.equal(own.status, 202);
    const { jobId } = await own.json();
    assert.equal(app.store.get(jobId)?.deviceId, 'cam2', 'device id comes from the token');
    assert.equal((await app.get(`/v1/captures/${jobId}`, DEVICE)).status, 404, 'cam1 cannot read cam2 job');
    assert.equal((await app.get(`/v1/captures/${jobId}`, CLIENT)).status, 401, 'status endpoint is for devices');
  } finally { await app.close(); }
});

test('burst -> received -> processing -> ready on the long-poll, with acks and resumable cursor', async () => {
  const app = await startApp({ env: { VERIFY_MATH: HAVE_SYMPY ? 'true' : 'false' } });
  try {
    const poll = app.events('0', 5);
    const res = await app.capture();
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.status, 'queued');
    assert.equal(typeof body.jobId, 'string');
    assert.equal(body.glassesListening, true, 'a long-poll is open');
    const first = await poll;
    assert.equal(first.events[0].jobId, body.jobId);
    assert.equal(first.events[0].status, 'received');
    assert.equal(first.events[0].photos, 3);

    await app.waitFor(body.jobId);
    const all = await app.events(first.cursor, 0);
    const final = all.events.find((e) => e.jobId === body.jobId)!;
    assert.equal(final.status, 'ready');
    const r = final.result;
    assert.match(r.short, /x = 4/);
    assert.equal(r.pages, 1);
    assert.equal(r.usedFrames, 3);
    assert.equal(r.label, HAVE_SYMPY ? 'CHECKED' : 'LIKELY');
    assert.ok(Array.isArray(r.detail) && r.detail.length === 2 && typeof r.detail[0] === 'string');
    assert.deepEqual(r.caveats, []);
    assert.equal(r.retakeReason, undefined);

    const text = JSON.stringify(all);
    assert.ok(!text.includes(app.dataDir) && !text.includes('.jpg') && !text.includes('idempotency'), 'no server paths or keys leak');

    const st = await (await app.get(`/v1/captures/${body.jobId}`, DEVICE)).json();
    assert.deepEqual(st, { status: 'ready' });

    const a1 = await (await app.send('POST', '/v1/acks', { jobId: body.jobId, stage: 'received' })).json();
    assert.ok(a1.receivedAt && a1.displayedAt === null);
    const a2 = await (await app.send('POST', '/v1/acks', { jobId: body.jobId, stage: 'displayed' })).json();
    assert.equal(a2.receivedAt, a1.receivedAt, 'set once');
    assert.ok(a2.displayedAt);
    assert.equal((await app.events(all.cursor, 0)).events.length, 0, 'acks do not create events');
    const cold = await app.events('0', 0);
    assert.equal(cold.events.length, 1, 'cold start sees the job once, in its latest state');
    assert.equal(cold.events[0].status, 'ready');
  } finally { await app.close(); }
});

test('mock fixtures through the API: unsure, partial, retake, failed, retried', async () => {
  const app = await startApp();
  try {
    const run = async (comment: string) => {
      const { jobId } = await (await app.capture({ frames: [{ comment }, {}] })).json();
      return app.waitFor(jobId);
    };
    const unsure = await run('mock:unsure');
    assert.equal(unsure.status, 'ready');
    assert.equal(unsure.result?.label, 'UNSURE');
    const partial = await run('mock:partial');
    assert.equal(partial.result?.label, 'LIKELY');
    assert.match(partial.result!.caveats[0], /Could not read: the last line/);
    const retake = await run('mock:retake:glare');
    assert.equal(retake.status, 'retake');
    assert.equal(retake.result?.retakeReason, 'glare');
    assert.equal(retake.result?.short, 'Retake: glare');
    assert.deepEqual(await (await app.get(`/v1/captures/${retake.id}`, DEVICE)).json(), { status: 'retake', retakeReason: 'glare' });
    const failed = await run('mock:fail');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.attempts, 1, 'non-retryable errors are not retried');
    const ev = (await app.events('0')).events.find((e) => e.jobId === failed.id)!;
    assert.equal(ev.error, 'AI could not process this capture');
    assert.equal(ev.result, undefined);
    const flaky = await run('mock:flaky');
    assert.equal(flaky.status, 'ready');
    assert.equal(flaky.attempts, 2);
  } finally { await app.close(); }
});

test('server-side quality: all frames bad -> retake without an AI call; one bad frame is dropped', async () => {
  const provider = new MockProvider();
  const app = await startApp({ provider });
  try {
    const dark = await (await app.capture({ frames: [{ meta: { brightness: 10 } }, { meta: { brightness: 12 } }, { meta: { brightness: 200, score: 0.01 } }] })).json();
    const j = await app.waitFor(dark.jobId);
    assert.equal(j.status, 'retake');
    assert.equal(j.result?.retakeReason, 'too dark');
    assert.equal(provider.calls, 0, 'no AI cost for a press that is clearly unusable');
    const files = await readdir(path.join(app.dataDir, 'images', dark.jobId)).catch(() => [] as string[]);
    assert.deepEqual(files, [], 'rejected pixels never stored');

    const mixed = await (await app.capture({ frames: [{}, { meta: { clipped: 0.6 } }, {}] })).json();
    const m = await app.waitFor(mixed.jobId);
    assert.equal(m.status, 'ready');
    assert.equal(m.result?.usedFrames, 2);
    assert.equal(provider.lastInput?.images.length, 2);
    assert.deepEqual(provider.lastInput?.images.map((i) => i.score), [0.8, 0.6], 'best first');
  } finally { await app.close(); }
});

test('single and clip modes are accepted; mode single with several frames is not', async () => {
  const app = await startApp();
  try {
    assert.equal((await app.capture({ mode: 'single', frames: [{}] })).status, 202);
    assert.equal((await app.capture({ mode: 'clip', frames: [{}, {}, {}] })).status, 202);
    assert.equal((await app.capture({ mode: 'single', frames: [{}, {}] })).status, 400);
  } finally { await app.close(); }
});

test('size limits: big frame 413, big body 413, wrong types 400/415', async () => {
  const app = await startApp();
  try {
    const big = await app.capture({ frames: [{ jpeg: makeTestJpeg({ bytes: 2_621_441 }) }] });
    assert.equal(big.status, 413);
    const huge = Buffer.alloc(9 * 1024 * 1024, 0x41);
    const r = await app.rawCapture(huge, 'multipart/form-data; boundary=x').catch((e) => e as Error);
    // Either a clean 413, or the server closed the socket while the client was still sending.
    if (r instanceof Response) assert.equal(r.status, 413); else assert.ok(r instanceof Error);
    assert.equal((await app.rawCapture(Buffer.from('{}'), 'application/json')).status, 400);
    assert.equal((await app.rawCapture(makeTestJpeg(), 'image/jpeg')).status, 400, 'old single-JPEG body is refused');
    const png = multipart([{ name: 'meta', type: 'application/json', data: JSON.stringify({ mode: 'single', capturedAt: new Date().toISOString(), frames: [{ name: 'a', score: 1, width: 1, height: 1 }] }) }, { name: 'frame0', type: 'image/png', data: Buffer.from('png') }]);
    assert.equal((await app.rawCapture(png.body, png.contentType)).status, 415);
    const truncated = captureBody();
    assert.equal((await app.rawCapture(truncated.body.subarray(0, truncated.body.length - 100), truncated.contentType)).status, 400);
    assert.equal((await app.capture({ key: 'short' })).status, 400, 'idempotency key too short');
    assert.equal((await app.capture({ metaOverride: { mode: 'video' } })).status, 400);
    // The server still works after all of that.
    assert.equal((await app.capture()).status, 202);
  } finally { await app.close(); }
});

test('rate limits: captures per device, and repeated bad tokens', async () => {
  const app = await startApp({ env: { CAPTURES_PER_MINUTE: '2', AUTH_FAILURES_PER_MINUTE: '3' } });
  try {
    assert.equal((await app.capture({ key: 'rate-key-1' })).status, 202);
    assert.equal((await app.capture({ key: 'rate-key-2' })).status, 202);
    const third = await app.capture({ key: 'rate-key-3' });
    assert.equal(third.status, 429);
    assert.ok(Number(third.headers.get('retry-after')) >= 1);
    assert.equal((await app.capture({ key: 'rate-key-1' })).status, 202, 'a retry of an accepted press is not limited');
    assert.equal((await app.capture({ token: DEVICE2 })).status, 202, 'limits are per device');

    for (let i = 0; i < 3; i++) assert.equal((await app.get('/v1/results', 'wrong')).status, 401);
    const blocked = await app.get('/v1/results', CLIENT);
    assert.equal(blocked.status, 429, 'blocked even with the right token');
  } finally { await app.close(); }
});

test('presence: display mode is stored; UNKNOWN counts as hidden; bad values rejected', async () => {
  const app = await startApp();
  try {
    assert.deepEqual((await (await app.send('POST', '/v1/presence', { displayMode: 'VISIBLE' })).json()).hidden, false);
    assert.equal((await (await app.send('POST', '/v1/presence', { displayMode: 'HIDDEN' })).json()).hidden, true);
    assert.equal((await (await app.send('POST', '/v1/presence', { displayMode: 'UNKNOWN' })).json()).hidden, true);
    assert.equal((await app.send('POST', '/v1/presence', { displayMode: 'visible' })).status, 400);
    assert.equal((await app.send('POST', '/v1/presence', 'not json')).status, 400);
    // Hidden changes nothing on the server: results are still produced and waiting for the app.
    const { jobId } = await (await app.capture()).json();
    assert.equal((await app.waitFor(jobId)).status, 'ready');
  } finally { await app.close(); }
});

test('camera config: read by camera and phone, changed only by the phone', async () => {
  const app = await startApp();
  try {
    const c0 = await (await app.get('/v1/camera/config', DEVICE)).json();
    assert.equal(c0.burstFrames, 4);
    assert.equal(c0.uploadFrames, 3);
    assert.equal(c0.defaultMode, 'burst');
    const put = await app.send('PUT', '/v1/camera/config', { burstFrames: 6, resolution: '2592x1944' });
    assert.equal(put.status, 200);
    const c1 = await put.json();
    assert.equal(c1.version, c0.version + 1);
    assert.equal((await (await app.get('/v1/camera/config', CLIENT)).json()).burstFrames, 6);
    assert.equal((await app.send('PUT', '/v1/camera/config', { ledEnabled: false })).status, 400, 'no LED switch exists');
    assert.equal((await app.send('PUT', '/v1/camera/config', { uploadFrames: 5 })).status, 400);
    assert.equal((await (await app.send('PUT', '/v1/camera/config', { burstFrames: 1 })).json()).uploadFrames, 1, 'K never exceeds N');
  } finally { await app.close(); }
});

test('results: parameter validation and long-poll timeout', async () => {
  const app = await startApp();
  try {
    assert.equal((await app.get('/v1/results?cursor=abc')).status, 400);
    assert.equal((await app.get('/v1/results?cursor=-1')).status, 400);
    assert.equal((await app.get('/v1/results?wait=1000')).status, 400);
    const t0 = Date.now();
    const r = await app.events('0', 1);
    assert.ok(Date.now() - t0 >= 900, 'waited');
    assert.deepEqual(r.events, []);
    assert.equal(r.cursor, '0');
    assert.equal((await app.get('/v1/nothing')).status, 404);
    assert.equal((await app.send('DELETE', '/v1/captures', {})).status, 405);
    assert.equal((await app.send('POST', '/v1/acks', { jobId: '00000000-0000-4000-8000-000000000000', stage: 'received' })).status, 404);
    assert.equal((await app.send('POST', '/v1/acks', { jobId: 'x', stage: 'seen' })).status, 400);
    const pre = await fetch(`${app.base}/v1/captures`, { method: 'OPTIONS' });
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get('access-control-allow-headers') ?? '', /Idempotency-Key/);
  } finally { await app.close(); }
});

test('results: many events are paged with more=true', async () => {
  const app = await startApp({ env: { CAPTURES_PER_MINUTE: '100' } });
  try {
    const ids: string[] = [];
    for (let i = 0; i < 55; i++) ids.push((await (await app.capture({ frames: [{}] })).json()).jobId);
    await Promise.all(ids.map((id) => app.waitFor(id, undefined, 15000)));
    const p1 = await app.events('0');
    assert.equal(p1.events.length, 50);
    assert.equal(p1.more, true);
    const p2 = await app.events(p1.cursor);
    assert.equal(p2.events.length, 5);
    assert.equal(p2.more, false);
    assert.equal(new Set([...p1.events, ...p2.events].map((e) => e.jobId)).size, 55);
  } finally { await app.close(); }
});
