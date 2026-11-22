import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RemovalLock, type RemovalReason } from '../src/core/removalLock.ts';
import type { RawSample } from '../src/core/imuAdapter.ts';
import { Rig } from './helpers.ts';

const at = (hms: string): number => Date.parse(`2026-11-22T${hms}Z`);

function realTrace(): RawSample[] {
  const text = readFileSync(new URL('./wear-traces/g2-wear-2026-11-22.csv', import.meta.url), 'utf8');
  return text.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => {
    const [t, x, y, z] = l.split(',').map(Number);
    return { t, x, y, z };
  });
}

function fires(samples: RawSample[]): { t: number; reason: RemovalReason }[] {
  const d = new RemovalLock();
  const out: { t: number; reason: RemovalReason }[] = [];
  for (const s of samples) {
    const reason = d.push(s);
    if (reason) out.push({ t: s.t, reason });
  }
  return out;
}

// 10 Hz samples of a fixed gravity vector with a little sensor noise.
function hold(t0: number, ms: number, g: [number, number, number], noise = 0.004): RawSample[] {
  const out: RawSample[] = [];
  for (let t = 0; t < ms; t += 100) {
    const n = (k: number) => noise * Math.sin(t / 37 + k * 2.1);
    out.push({ t: t0 + t, x: g[0] + n(0), y: g[1] + n(1), z: g[2] + n(2) });
  }
  return out;
}

const WORN: [number, number, number] = [0.05, -0.19, 0.98];
const TABLE: [number, number, number] = [0.04, -0.05, 1.0];
const ON_SIDE: [number, number, number] = [0.13, 0.86, 0.49];

test('real G2 trace: no lock while worn, a lock at each removal before the glasses go back on', () => {
  const got = fires(realTrace());
  const during = (a: string, b: string) => got.filter((f) => f.t >= at(a) && f.t < at(b));
  // Worn: still, looking down and up, turning left and right, shaking no, reading.
  assert.deepEqual(during('09:08:56', '09:11:58'), []);
  // Taken off at 09:12:04 and laid flat; worn again at 09:12:16.
  assert.equal(during('09:12:04', '09:12:16')[0]?.reason, 'flat-still');
  // Taken off at 09:15:22 and the arms folded.
  assert.equal(during('09:15:22', '09:15:26')[0]?.reason, 'odd-pose');
  // Taken off at 09:18:03 into the case.
  assert.equal(during('09:18:03', '09:18:09')[0]?.reason, 'odd-pose');
});

test('worn and perfectly still never locks, however long', () => {
  assert.deepEqual(fires(hold(0, 120_000, WORN, 0.002)), []);
});

test('rolling onto the side locks within half a second, and only once', () => {
  const got = fires([...hold(0, 3000, WORN), ...hold(3000, 10_000, ON_SIDE)]);
  assert.equal(got.length, 1);
  assert.equal(got[0].reason, 'odd-pose');
  assert.ok(got[0].t - 3000 <= 500);
});

test('a pose held from the start, such as lying on one side, does not lock again and again', () => {
  assert.deepEqual(fires(hold(0, 30_000, ON_SIDE)), []);
});

test('flat on a table locks after about 1.5 s of stillness, and a nudge re-arms it', () => {
  const nudge: RawSample = { t: 7000, x: 0.2, y: 0.1, z: 0.97 };
  const got = fires([...hold(0, 3000, WORN), ...hold(3000, 4000, TABLE, 0.002), nudge, ...hold(7100, 4000, TABLE, 0.002)]);
  assert.equal(got.length, 2);
  assert.ok(got.every((f) => f.reason === 'flat-still'));
  assert.ok(got[0].t >= 4300 && got[0].t <= 4700, `first lock at ${got[0].t}`);
});

test('readings that are not gravity are ignored', () => {
  const d = new RemovalLock();
  for (let t = 0; t < 5000; t += 100) assert.equal(d.push({ t, x: 30, y: -2, z: 40 }), null);
  assert.equal(d.push({ t: 5100, x: Number.NaN, y: 0, z: 1 }), null);
});

async function motionRig(): Promise<Rig> {
  const r = await new Rig(undefined, { initialSettings: { unlockGesture: 'touch', recoveryPresses: 5, unlockTouchpad: 'right',
    trustWearSensor: false, motionLock: true, tiltEnabled: false } }).start();
  r.a.handleConnection(true);
  r.a.handleWear(true);
  r.wait(r.a.settings.wearSettleMs + 100);
  return r;
}

function feed(r: Rig, g: [number, number, number], ms: number): void {
  for (const s of hold(0, ms, g)) {
    r.wait(100);
    r.a.handleImu({ ...s, t: r.time });
  }
}

const unlockRight = (r: Rig) => { for (let i = 0; i < 5; i++) r.a.handleTouch('press', 'right'); };

test('five right taps unlock; taking the glasses off locks the lens from motion alone', async () => {
  const r = await motionRig();
  for (let i = 0; i < 4; i++) r.a.handleTouch('press', 'right');
  assert.equal(r.a.state, 'HIDDEN');
  r.a.handleTouch('press', 'left');
  assert.equal(r.a.state, 'HIDDEN');
  r.a.handleTouch('press', 'right');
  assert.equal(r.a.state, 'HIDDEN', 'the left tap broke the sequence');
  unlockRight(r);
  assert.equal(r.a.state, 'VISIBLE');
  assert.equal(r.a.motionNeeded, true);

  feed(r, WORN, 3000);
  assert.equal(r.a.state, 'VISIBLE');
  const mark = r.markPlans();
  feed(r, ON_SIDE, 600);
  assert.equal(r.a.state, 'HIDDEN');
  assert.equal(r.lit(), false);
  assert.ok(r.plansSince(mark).every((p) => p.kind === 'blank'));

  // Back on the head: the host still says nothing, and the lens stays dark until five fresh taps.
  feed(r, WORN, 3000);
  assert.equal(r.a.state, 'HIDDEN');
  unlockRight(r);
  assert.equal(r.a.state, 'VISIBLE');
});

test('with the motion lock, a host wear report stuck on removed does not block unlocking', async () => {
  const r = await motionRig();
  r.a.handleWear(false, false);
  unlockRight(r);
  assert.equal(r.a.state, 'VISIBLE');
  r.a.handleWear(false, true); // the case is still believed
  assert.equal(r.a.state, 'REMOVED');
});

async function fourTapRig(): Promise<Rig> {
  const r = await new Rig(undefined, { initialSettings: { unlockGesture: 'touch', recoveryPresses: 4, unlockTouchpad: 'right',
    recoveryGapMs: 1500, recoveryWindowMs: 6000, doublePressLocks: true, trustWearSensor: false, motionLock: false, tiltEnabled: false } }).start();
  r.a.handleConnection(true);
  r.a.handleWear(true);
  r.wait(r.a.settings.wearSettleMs + 100);
  return r;
}

test('four right taps unlock at a natural pace; a pause over 1.5 s starts the count again', async () => {
  const r = await fourTapRig();
  const tap = (gap: number, touch: 'press' | 'double' = 'press') => { r.wait(gap); r.a.handleTouch(touch, 'right'); };
  tap(0); tap(700); tap(700);
  assert.equal(r.a.snapshot().tapCount, 3);
  r.wait(1600);
  assert.equal(r.a.snapshot().tapCount, 0, 'three taps then a pause expire');
  tap(0);
  assert.equal(r.a.state, 'HIDDEN');
  tap(600); tap(600); tap(600);
  assert.equal(r.a.state, 'VISIBLE');
});

test('a double tap counts as two toward unlocking, and while text shows it hides instead of exiting', async () => {
  const r = await fourTapRig();
  r.a.handleTouch('double', 'right');
  r.wait(500);
  r.a.handleTouch('double', 'right');
  assert.equal(r.a.state, 'VISIBLE');
  r.wait(3000);
  r.a.handleTouch('double', 'right');
  assert.equal(r.a.state, 'HIDDEN');
  assert.equal(r.exits, 0);
  assert.equal(r.lit(), false);
});

test('wrong taps never exit the app: two, then three, then left taps, all just expire', async () => {
  const r = await fourTapRig();
  r.a.handleTouch('double', 'right');
  r.wait(2000);
  for (let i = 0; i < 3; i++) { r.a.handleTouch('press', 'right'); r.wait(500); }
  r.wait(2000);
  for (let i = 0; i < 4; i++) { r.a.handleTouch('press', 'left'); r.wait(500); }
  assert.equal(r.a.state, 'HIDDEN');
  assert.equal(r.exits, 0);
  for (let i = 0; i < 4; i++) { r.a.handleTouch('press', 'right'); r.wait(500); }
  assert.equal(r.a.state, 'VISIBLE');
});
