import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResultClient, cleanCameraPatch, loadBackendSettings, parseEvent, saveBackendSettings, type ClientOptions, type JobEvent } from '../src/core/backend.ts';
import { FakeBackend, MemoryKV, TOKEN, until } from './fakeBackend.ts';

const fastSleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  const t = setTimeout(resolve, Math.min(ms, 5));
  signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

function client(fake: FakeBackend, kv = new MemoryKV(), extra: Partial<ClientOptions> = {}) {
  const got: JobEvent[] = [];
  const states: string[] = [];
  const c = new ResultClient({
    kv,
    fetch: fake.fetch,
    sleep: fastSleep,
    random: () => 0.5,
    waitSeconds: 1,
    onEvent: (e) => { got.push(e); },
    onState: (s) => states.push(s),
    ...extra,
  });
  return { c, got, states, kv };
}

const SETTINGS = { serverUrl: 'https://fake.test', token: TOKEN };

test('long-poll delivers events in order and acknowledges final ones as received', async () => {
  const fake = new FakeBackend();
  const { c, got } = client(fake);
  c.start(SETTINGS);
  fake.push({ jobId: 'j1', status: 'received', photos: 3, pages: 1 });
  await until(() => got.length === 1, 2000, 'received');
  fake.ready('j1', 'Answer one');
  await until(() => got.length === 2 && fake.acks.length === 1, 2000, 'ready and ack');
  assert.deepEqual(got.map((e) => e.status), ['received', 'ready']);
  assert.deepEqual(fake.acks, [{ jobId: 'j1', stage: 'received' }]);
  await c.stop();
});

test('the cursor survives a restart, and a new client does not get old events again', async () => {
  const fake = new FakeBackend();
  const kv = new MemoryKV();
  const first = client(fake, kv);
  first.c.start(SETTINGS);
  fake.ready('j1', 'one');
  fake.ready('j2', 'two');
  await until(() => first.got.length === 2);
  await first.c.stop();
  const second = client(fake, kv);
  assert.equal(second.c.cursor, first.c.cursor);
  second.c.start(SETTINGS);
  fake.ready('j3', 'three');
  await until(() => second.got.length === 1);
  assert.equal(second.got[0].jobId, 'j3');
  await second.c.stop();
});

test('if the app dies before the cursor is saved, events come again and the app can drop them', async () => {
  const fake = new FakeBackend();
  const kv = new MemoryKV();
  let die = true;
  const first = client(fake, kv, { onEvent: () => { if (die) throw new Error('killed while storing'); } });
  first.c.start(SETTINGS);
  fake.ready('j1', 'one');
  await until(() => fake.polls.length >= 2);
  await first.c.stop();
  assert.equal(first.c.cursor, '0', 'cursor not advanced past an event that was not stored');
  die = false;
  const second = client(fake, kv);
  second.c.start(SETTINGS);
  await until(() => second.got.length === 1);
  assert.equal(second.got[0].jobId, 'j1');
  await second.c.stop();
});

test('repeated and older events for a job are handed over once', async () => {
  const fake = new FakeBackend();
  const { c, got } = client(fake);
  const ev = fake.ready('j1', 'one');
  c.start(SETTINGS);
  await until(() => got.length === 1);
  // Later polls repeat the event and bring an older one for the same job.
  fake.inject = [ev, { ...ev }, { ...ev, seq: ev.seq - 1, status: 'processing' }];
  const polls = fake.polls.length;
  await until(() => fake.polls.length >= polls + 2);
  await c.stop();
  assert.equal(got.filter((e) => e.jobId === 'j1').length, 1);
});

test('malformed events are dropped and the poll goes on', async () => {
  const fake = new FakeBackend();
  const { c, got } = client(fake);
  fake.inject = [null, 'x', { jobId: 5, seq: 1, status: 'ready' }, { jobId: 'a', seq: 2, status: 'weird' }, { jobId: 'b', seq: 3, status: 'ready' }];
  c.start(SETTINGS);
  fake.ready('ok', 'fine');
  await until(() => got.length === 1);
  await c.stop();
  assert.equal(got[0].jobId, 'ok');
});

test('parseEvent clips long text and keeps only known labels', () => {
  const e = parseEvent({ jobId: 'j', seq: 4, status: 'ready', photos: 3, result: { short: 'x'.repeat(5000), detail: ['a', 3, 'b'], label: 'HACKED', caveats: 'no', pages: 2, usedFrames: 2 } });
  assert.ok(e?.result);
  assert.equal(e.result.short.length, 300);
  assert.deepEqual(e.result.detail, ['a', 'b']);
  assert.equal(e.result.label, 'UNSURE');
  assert.deepEqual(e.result.caveats, []);
  assert.equal(parseEvent({ jobId: 'j', seq: 1, status: 'ready' }), null, 'ready needs a result');
});

test('a rejected token is reported and polling backs off without a busy loop', async () => {
  const fake = new FakeBackend();
  const { c, states } = client(fake);
  c.start({ ...SETTINGS, token: 'wrong-token-wrong-token' });
  await until(() => states.includes('unauthorized'));
  const n = fake.polls.length;
  await c.stop();
  assert.equal(n, 0, 'the fake never served a poll to a bad token');
  assert.equal(c.connState, 'off');
});

test('network errors back off and recover', async () => {
  const fake = new FakeBackend();
  const slept: number[] = [];
  const { c, got, states } = client(fake, new MemoryKV(), { sleep: (ms, s) => { slept.push(ms); return fastSleep(ms, s); } });
  fake.failNext = { count: 3, status: 0 };
  c.start(SETTINGS);
  fake.ready('j1', 'one');
  await until(() => got.length === 1);
  await c.stop();
  assert.ok(states.includes('offline'));
  assert.ok(slept.length >= 3);
  assert.ok(slept[1] > slept[0] && slept[2] > slept[1], `backoff grows: ${slept.join(', ')}`);
});

test('server errors (500) are retried, the event is not lost', async () => {
  const fake = new FakeBackend();
  const { c, got } = client(fake);
  fake.ready('j1', 'one');
  fake.failNext = { count: 2, status: 503 };
  c.start(SETTINGS);
  await until(() => got.length === 1);
  await c.stop();
});

test('displayed acks are queued, survive a restart and are sent once', async () => {
  const fake = new FakeBackend();
  const kv = new MemoryKV();
  fake.ready('j1', 'one');
  const first = client(fake, kv);
  first.c.ack('j1', 'displayed'); // not running yet: only stored
  assert.equal(first.c.pendingAcks, 1);
  const second = client(fake, kv);
  second.c.start(SETTINGS);
  await until(() => fake.acks.some((a) => a.stage === 'displayed'));
  second.c.ack('j1', 'displayed');
  second.c.ack('j1', 'received'); // displayed already implies it
  await until(() => second.c.pendingAcks === 0);
  await second.c.stop();
  assert.equal(fake.acks.filter((a) => a.jobId === 'j1' && a.stage === 'displayed').length, 1);
  assert.equal(fake.acks.filter((a) => a.stage === 'received').length, 1, 'the received ack from the poll itself');
});

test('an ack for a job the server no longer has is dropped, not retried for ever', async () => {
  const fake = new FakeBackend();
  const { c } = client(fake);
  c.start(SETTINGS);
  c.ack('gone', 'displayed');
  await until(() => c.pendingAcks === 0);
  await c.stop();
});

test('presence sends only the newest value', async () => {
  const fake = new FakeBackend();
  const { c } = client(fake);
  c.setPresence('UNKNOWN');
  c.start(SETTINGS);
  c.setPresence('HIDDEN');
  c.setPresence('VISIBLE');
  c.setPresence('HIDDEN');
  await until(() => c.presence === 'HIDDEN' && fake.presence.at(-1) === 'HIDDEN');
  await c.stop();
  assert.ok(fake.presence.length <= 3, fake.presence.join(','));
});

test('wake polls at once instead of waiting out a long poll', async () => {
  const fake = new FakeBackend();
  fake.holdMs = 5000;
  const { c, got } = client(fake, new MemoryKV(), { waitSeconds: 25 });
  c.start(SETTINGS);
  await until(() => fake.polls.length === 1);
  fake.inject = [{ jobId: 'x', seq: 99, status: 'received' }]; // only seen by a new request
  c.wake();
  await until(() => got.length === 1, 1000, 'a fresh poll after wake');
  await c.stop();
});

test('paged results are fetched without waiting', async () => {
  const fake = new FakeBackend();
  fake.pageSize = 2;
  for (let i = 0; i < 5; i++) fake.ready(`j${i}`, `a${i}`);
  const { c, got } = client(fake);
  c.start(SETTINGS);
  await until(() => got.length === 5);
  await c.stop();
  assert.deepEqual(got.map((e) => e.jobId), ['j0', 'j1', 'j2', 'j3', 'j4']);
});

test('camera settings: load, change only allowed fields, and show server errors', async () => {
  const fake = new FakeBackend();
  const { c } = client(fake);
  c.start(SETTINGS);
  const cfg = await c.getCameraConfig();
  assert.equal(cfg.burstFrames, 4);
  const saved = await c.putCameraConfig({ burstFrames: 6, uploadFrames: 9, defaultMode: 'single', ...({ ledOff: true } as object) });
  assert.equal(saved.burstFrames, 6);
  assert.equal(saved.uploadFrames, 3, 'K is capped at 3 on the phone');
  assert.equal(saved.defaultMode, 'single');
  assert.equal((saved as unknown as Record<string, unknown>).ledOff, undefined, 'no unknown field is ever sent');
  await c.stop();
});

test('cleanCameraPatch keeps K at or below N and rejects unknown values', () => {
  assert.deepEqual(cleanCameraPatch({ burstFrames: 2, uploadFrames: 3 }), { burstFrames: 2, uploadFrames: 2 });
  assert.deepEqual(cleanCameraPatch({ resolution: '9999x9999' as never, defaultMode: 'video' as never }), {});
  assert.deepEqual(cleanCameraPatch({ burstFrames: 0.4 }), { burstFrames: 1 });
});

test('backend settings: only https (or local http), origin only, and a real token', () => {
  const kv = new MemoryKV();
  assert.match(saveBackendSettings(kv, { serverUrl: 'http://evil.example', token: TOKEN }) ?? '', /https/);
  assert.match(saveBackendSettings(kv, { serverUrl: 'https://x.example/api', token: TOKEN }) ?? '', /origin/);
  assert.match(saveBackendSettings(kv, { serverUrl: 'https://x.example', token: 'short' }) ?? '', /short/);
  assert.equal(saveBackendSettings(kv, { serverUrl: 'https://x.example/', token: ` ${TOKEN} ` }), null);
  assert.deepEqual(loadBackendSettings(kv), { serverUrl: 'https://x.example', token: TOKEN });
  assert.equal(saveBackendSettings(kv, { serverUrl: 'http://127.0.0.1:8787', token: TOKEN }), null);
  kv.setItem('g2a.backend.v1', '{broken');
  assert.equal(loadBackendSettings(kv), null);
});

test('a corrupt stored cursor starts from the beginning', () => {
  const fake = new FakeBackend();
  const kv = new MemoryKV();
  kv.setItem('g2a.client.v1', JSON.stringify({ cursor: '../../etc', seen: 'x', acks: [1] }));
  const { c } = client(fake, kv);
  assert.equal(c.cursor, '0');
  assert.equal(c.pendingAcks, 0);
});

test('over real HTTP: a fake server on 127.0.0.1 with the platform fetch', async () => {
  const fake = new FakeBackend();
  const { server, origin } = await fake.listen();
  try {
    const { c, got } = client(fake, new MemoryKV(), { fetch: (url, init) => fetch(url, init) });
    c.start({ serverUrl: origin, token: TOKEN });
    fake.push({ jobId: 'h1', status: 'received', photos: 2, pages: 1 });
    fake.ready('h1', 'over http');
    await until(() => got.some((e) => e.status === 'ready') && fake.acks.length === 1, 3000, 'http delivery');
    assert.equal((await c.getCameraConfig()).resolution, '2048x1536');
    await c.stop();
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
