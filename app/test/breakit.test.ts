import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActivityMonitor } from '../src/core/activity.ts';
import { ResultClient, parseEvent, type FetchLike, type JobEvent } from '../src/core/backend.ts';
import { GestureEngine } from '../src/core/gestureEngine.ts';
import { ImuAdapter } from '../src/core/imuAdapter.ts';
import { INBOX_KEY, INBOX_SIZE, Inbox, type AnswerRecord } from '../src/core/inbox.ts';
import { analyseExamples, type Example } from '../src/core/personal.ts';
import { LEGACY_SETTINGS } from '../src/core/population.ts';
import { countGestures } from '../src/core/scenarios.ts';
import { ShakeDetector } from '../src/core/shakeDetector.ts';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/core/settings.ts';
import { MemoryStore } from '../src/core/storage.ts';
import { sequence, shake, still, stream, talking, tilt, type Motion } from '../src/core/synth.ts';
import { FakeBackend, MemoryKV, TOKEN, until } from './fakeBackend.ts';
import { Rig } from './helpers.ts';

// Defects found by trying to break the smart gestures and the display privacy
// rules. Each test failed before its fix.

const base = sanitizeSettings(DEFAULT_SETTINGS);
const settle = (...m: Motion[]) => sequence(still(1500), ...m, still(800));
const ex = (label: Example['label'], m: Motion, seed = 1): Example => ({ label, samples: [...stream(sequence(still(300), m, still(300)), { seed })] });
const tilts = (): Example[] => [1, 2, 3].flatMap((s) => [ex('tiltUp', tilt(20), s), ex('tiltDown', tilt(-20), s)]);

// ---- Personal calibration from bad examples ----

test('personal: tiny "shakes" (3 degrees each side) are refused, not turned into a limit that conversation passes', () => {
  const tiny = [1, 2, 3].map((s) => ex('shake', shake({ ampDeg: 3, hz: 2.5, cycles: 2 }), s));
  const r = analyseExamples([...tiny, ...tilts()], base);
  if (r.ok) {
    assert.ok(r.proposal);
    // Whatever is proposed must not fire constantly while talking.
    const talk = countGestures(stream(talking(600_000, 3, 1), { seed: 4 }), r.proposal).shakes;
    assert.ok(talk <= 3, `${talk} false shakes in 10 minutes of talking`);
  } else {
    assert.match(r.error ?? '', /small|wider/i);
  }
});

test('personal: a proposal never sets the minimum shake below the floor, even for a small shaker', () => {
  const small = [1, 2, 3].map((s) => ex('shake', shake({ ampDeg: 7.5, hz: 2.5, cycles: 2 }), s));
  const r = analyseExamples([...small, ...tilts()], base);
  assert.ok(r.ok && r.proposal, r.error);
  assert.ok(r.proposal.shakeMinAmpDeg / r.proposal.shakeSensitivity >= 14 - 1e-9, `min ${r.proposal.shakeMinAmpDeg}`);
  assert.ok(r.warnings.some((w) => /small/.test(w)), 'the user is told their shakes are small');
  const wider = analyseExamples([...[1, 2, 3].map((s) => ex('shake', shake({ ampDeg: 10, hz: 2.5, cycles: 2 }), s)), ...tilts()], base);
  assert.ok(wider.ok && wider.after && wider.proposal, wider.error);
  assert.ok(wider.proposal.shakeMinAmpDeg >= 14 - 1e-9);
  assert.equal(wider.after.shake.hit, wider.after.shake.of, 'slightly wider shakes are all caught');
});

test('personal: very slow shakes get a proposal that can actually fire on them', () => {
  const slow = [1, 2, 3].map((s) => ex('shake', shake({ ampDeg: 25, hz: 0.6, cycles: 2 }), s));
  const r = analyseExamples([...slow, ...tilts()], base);
  assert.ok(r.ok && r.proposal && r.after, r.error);
  assert.equal(r.after.shake.hit, r.after.shake.of, `caught ${r.after.shake.hit} of ${r.after.shake.of}`);
});

test('personal: an ok result whose own shakes are mostly missed carries a warning', () => {
  // Shakes and "ordinary" movement that are the same motion: the tuning has to give up on one of them.
  const sh = [1, 2, 3].map((s) => ex('shake', shake({ ampDeg: 15, hz: 2.5, cycles: 2 }), s));
  const other = [4, 5].map((s) => ex('other', shake({ ampDeg: 15, hz: 2.5, cycles: 2 }), s));
  const r = analyseExamples([...sh, ...other, ...tilts()], base);
  assert.ok(r.warnings.length > 0, 'contradicting examples are never silently accepted');
});

// ---- Activity boost ----

test('activity boost can never push the minimum shake above the maximum, so a shake stays possible while busy', () => {
  const s = sanitizeSettings({ ...base, shakeMinAmpDeg: 60, activityShakeBoost: 3 });
  const d = new ShakeDetector(s);
  d.setBoost(3);
  // Big but legal shake: 2 x 40 = 80 degrees per swing, under the 90 maximum.
  let fired = false;
  for (const raw of stream(settle(shake({ ampDeg: 40, hz: 2, cycles: 2 })), { seed: 2 })) {
    if (d.push(raw.t, raw.y, raw.x)) fired = true;
  }
  assert.ok(fired, 'a shake within the allowed range still fires at the highest boost');
});

test('activity: steady drift (rate-mode bias) is not background motion', () => {
  const mon = new ActivityMonitor(base);
  // Yaw drifting at 25 degrees a second with no oscillation, for 12 s.
  for (let t = 0; t <= 12_000; t += 20) mon.push(t, (25 * t) / 1000, 0);
  const lvl = mon.level(12_000);
  assert.equal(lvl.label, 'still', `drift read as ${lvl.label} (yaw ${lvl.yaw.toFixed(1)})`);
  assert.equal(lvl.shakeBoost, 1);
});

test('activity: rate mode with an uncorrected gyro bias still lets a shake through', () => {
  const s = sanitizeSettings({ ...base, imuMode: 'rate', rateBiasYaw: 0, rateBiasPitch: 0 });
  // 18 dps bias on both rate axes; the user shakes after 12 s of sitting still.
  const samples = [...stream(sequence(still(12_000), shake({ ampDeg: 15, hz: 2.5, cycles: 2 }), still(500)), { settings: s, rateBias: 18, seed: 3 })];
  const adapter = new ImuAdapter(s);
  const engine = new GestureEngine(s);
  let shakes = 0;
  for (const raw of samples) {
    const sig = adapter.push(raw);
    if (sig) shakes += engine.push(sig).filter((e) => e.type === 'shake').length;
  }
  assert.equal(shakes, 1);
});

// ---- Quick-glance rule rejecting real shakes ----

test('glance rule: real slow shakes that the old settings caught are still caught (1.2 to 1.4 Hz)', () => {
  for (const hz of [1.2, 1.3, 1.4]) {
    for (const seed of [2, 5, 9]) {
      const samples = [...stream(settle(shake({ ampDeg: 25, hz, cycles: 2 })), { seed })];
      if (countGestures(samples, LEGACY_SETTINGS).shakes !== 1) continue;
      assert.equal(countGestures(samples, base).shakes, 1, `${hz} Hz seed ${seed}`);
    }
  }
});

// ---- Long-poll storms ----

function stormFetch(reply: () => unknown, count: { n: number }): FetchLike {
  return async (url) => {
    if (url.includes('/v1/results')) count.n++;
    await new Promise((r) => setImmediate(r)); // let timers run, or a spinning client would starve the test
    return { ok: true, status: 200, json: async () => reply() };
  };
}

test('long-poll: a server that answers at once with nothing (ignores wait) is not hammered', async () => {
  const count = { n: 0 };
  const naps: number[] = [];
  const c = new ResultClient({
    kv: new MemoryKV(),
    fetch: stormFetch(() => ({ cursor: '0', events: [], more: false }), count),
    sleep: (ms, signal) => { naps.push(ms); return new Promise((r) => { const t = setTimeout(r, 1); signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); }); },
    waitSeconds: 25,
    onEvent: () => {},
  });
  c.start({ serverUrl: 'https://fake.test', token: TOKEN });
  await until(() => count.n >= 6, 2000, 'polls');
  await c.stop();
  const restful = naps.filter((ms) => ms >= 1000).length;
  assert.ok(restful >= count.n - 2, `${count.n} polls but only ${restful} pauses of 1 s or more`);
});

test('long-poll: "more: true" with no events does not spin', async () => {
  const count = { n: 0 };
  const naps: number[] = [];
  const c = new ResultClient({
    kv: new MemoryKV(),
    fetch: stormFetch(() => ({ cursor: '5', events: [], more: true }), count),
    sleep: (ms, signal) => { naps.push(ms); return new Promise((r) => { const t = setTimeout(r, 1); signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); }); },
    waitSeconds: 25,
    onEvent: () => {},
  });
  c.start({ serverUrl: 'https://fake.test', token: TOKEN });
  await until(() => count.n >= 6, 2000, 'polls');
  await c.stop();
  assert.ok(naps.filter((ms) => ms >= 1000).length >= count.n - 2, `${count.n} polls, naps ${naps.join(',')}`);
});

// ---- Lost cursor: old results must not come back as new ----

const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();
const DAY = 86_400_000;

function seenRecord(i: number): AnswerRecord {
  return { jobId: `j${i}`, short: `Answer ${i}`, detail: [], label: 'LIKELY', caveats: [], pages: 1, usedFrames: 1, at: i, seen: true };
}

async function wired(store: MemoryStore, fake: FakeBackend, kv = new MemoryKV()) {
  const r = await new Rig(store).ready();
  const c = new ResultClient({
    kv,
    fetch: fake.fetch,
    sleep: (ms, signal) => new Promise((res) => { const t = setTimeout(res, Math.min(ms, 5)); signal.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true }); }),
    waitSeconds: 1,
    onEvent: (e) => r.a.handleJobEvent(e),
  });
  return { r, c };
}

test('lost cursor: answers the user already saw do not come back as new, and the kept ones are not pushed out', async () => {
  // The phone keeps the newest 20 answers (seen). The client state is in a different
  // store (localStorage) and was wiped, so the client starts again from cursor 0.
  const store = new MemoryStore();
  const kept = Array.from({ length: INBOX_SIZE }, (_, k) => seenRecord(50 - k)); // j50 .. j31, newest first
  await store.set(INBOX_KEY, JSON.stringify(kept));
  const fake = new FakeBackend();
  for (let i = 1; i <= 50; i++) fake.ready(`j${i}`, `Answer ${i}`, { createdAt: iso((51 - i) * DAY / 2) } as unknown as Partial<JobEvent>);
  const { r, c } = await wired(store, fake);
  c.start({ serverUrl: 'https://fake.test', token: TOKEN });
  await until(() => c.cursor === '50', 3000, 'catch-up');
  await c.stop();
  const snap = r.a.snapshot();
  assert.equal(snap.unseenAnswers, 0, `${snap.unseenAnswers} old answers came back marked new`);
  const stored = JSON.parse((await store.get(INBOX_KEY)) ?? '[]') as AnswerRecord[];
  assert.deepEqual(stored.map((x) => x.jobId), kept.map((x) => x.jobId), 'the 20 newest are still the ones kept, in order');
});

test('lost cursor: an old retake and an old unfinished job draw nothing after the user shows the lens', async () => {
  const store = new MemoryStore();
  const fake = new FakeBackend();
  fake.push({ jobId: 'old-stuck', status: 'processing', photos: 3, pages: 1, createdAt: iso(3 * DAY) } as unknown as Omit<JobEvent, 'seq'>);
  fake.push({ jobId: 'old-retake', status: 'retake', photos: 3, pages: 1, createdAt: iso(2 * DAY), result: { short: 'Retake: too dark', detail: [], label: 'RETAKE', caveats: [], pages: 1, usedFrames: 0, retakeReason: 'too dark' } } as unknown as Omit<JobEvent, 'seq'>);
  const { r, c } = await wired(store, fake);
  c.start({ serverUrl: 'https://fake.test', token: TOKEN });
  await until(() => c.cursor === '2', 3000, 'catch-up');
  await c.stop();
  r.play(shake());
  assert.equal(r.a.state, 'VISIBLE');
  assert.doesNotMatch(r.text(), /Retake|READING|RECEIVED/);
});

test('lost cursor: a result made a minute ago is still delivered as new', async () => {
  const store = new MemoryStore();
  const fake = new FakeBackend();
  fake.ready('old', 'Old answer', { createdAt: iso(5 * DAY) } as unknown as Partial<JobEvent>);
  fake.ready('fresh', 'Fresh answer', { createdAt: iso(60_000) } as unknown as Partial<JobEvent>);
  const { r, c } = await wired(store, fake);
  c.start({ serverUrl: 'https://fake.test', token: TOKEN });
  await until(() => c.cursor === '2', 3000, 'catch-up');
  await c.stop();
  assert.equal(r.a.snapshot().unseenAnswers, 1);
  r.play(shake());
  assert.match(r.text(), /Fresh answer/);
  assert.doesNotMatch(r.text(), /new/);
});

test('a normal poll after the catch-up is never treated as backlog, even for an event without createdAt', async () => {
  const store = new MemoryStore();
  const fake = new FakeBackend();
  const { r, c } = await wired(store, fake);
  c.start({ serverUrl: 'https://fake.test', token: TOKEN });
  await until(() => fake.polls.length >= 2, 3000, 'two polls');
  fake.ready('live', 'Live answer');
  await until(() => c.cursor === '1', 3000, 'live');
  await c.stop();
  assert.equal(r.a.snapshot().unseenAnswers, 1);
});

test('parseEvent reads createdAt only when it is a real time', () => {
  assert.equal(parseEvent({ jobId: 'a', seq: 1, status: 'received', createdAt: 'yesterday' })?.createdAt, undefined);
  assert.equal(parseEvent({ jobId: 'a', seq: 1, status: 'received', createdAt: '2026-11-08T09:30:01.120Z' })?.createdAt, Date.parse('2026-11-08T09:30:01.120Z'));
});

test('inbox: an old result goes in after newer answers and never pushes one out', () => {
  const kept = Array.from({ length: INBOX_SIZE }, (_, k) => ({ ...seenRecord(50 - k), seq: 50 - k }));
  const box = new Inbox(new MemoryStore(), kept);
  assert.equal(box.addHistory({ ...seenRecord(1), seq: 1, seen: false }), false, 'older than everything kept: not kept');
  assert.deepEqual(box.records.map((r) => r.jobId), kept.map((r) => r.jobId));
  const half = new Inbox(new MemoryStore(), kept.slice(0, 5)); // j50..j46
  assert.equal(half.addHistory({ ...seenRecord(48.5), jobId: 'mid', seq: 48.5, seen: false }), true);
  assert.deepEqual(half.records.map((r) => r.jobId), ['j50', 'j49', 'mid', 'j48', 'j47', 'j46']);
  assert.equal(half.get('mid')?.seen, true, 'history is stored as seen');
});
