import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GestureEvent } from '../src/core/gestureEngine.ts';
import type { RawSample } from '../src/core/imuAdapter.ts';
import { SCENARIOS, countGestures } from '../src/core/scenarios.ts';
import { DEFAULT_SETTINGS, sanitizeSettings, type Settings } from '../src/core/settings.ts';
import { sequence, shake, still, stream, tilt, type Motion } from '../src/core/synth.ts';
import { Rng, forAll, randomMotionSeq } from './prop.ts';

// Metamorphic tests: change the input in a way that must not change the
// answer (units, sample rate, axis wiring, mirror image, clock offset), and
// check that the gestures found stay the same. These need no expected values,
// so they also hold for motion nobody has labelled.

const base = sanitizeSettings(DEFAULT_SETTINGS);

/** The gestures found, without timing detail. */
function shape(events: GestureEvent[]): string[] {
  return events.filter((e) => e.type === 'shake' || e.type === 'tiltStart').map((e) => (e.type === 'tiltStart' ? `tilt-${e.direction}` : 'shake'));
}

// How many compared cases had any gesture at all. An invariance over empty
// results would prove nothing, so each random test checks this afterwards.
const seen = { cases: 0, withGesture: 0 };
function run(samples: Iterable<RawSample>, s: Settings) {
  const c = countGestures(samples, s, true);
  seen.cases++;
  if (c.events.some((e) => e.type === 'shake' || e.type === 'tiltStart')) seen.withGesture++;
  return { shape: shape(c.events), times: c.events.map((e) => e.t), lines: c.upLines + c.downLines, c };
}

const mapPose = (m: Motion, f: (p: { pitch: number; yaw: number }) => { pitch: number; yaw: number }): Motion => ({ durMs: m.durMs, pose: (t) => f(m.pose(t)) });

test('metamorphic: scaling the raw unit (radians, milli-units) with a matching imuScale finds the same gestures', async () => {
  await forAll((r) => ({ seed: r.int(1, 1e9), k: r.pick([1 / 57.29578, 0.01, 1000, 3.7]) }), ({ seed, k }) => {
    const m = randomMotionSeq(new Rng(seed), 2, 6);
    const plain = [...stream(m, { seed, noiseDeg: 0.15 })];
    const scaled = plain.map((x) => ({ ...x, x: x.x * k, y: x.y * k, z: x.z * k }));
    const a = run(plain, base);
    const b = run(scaled, sanitizeSettings({ ...base, imuScale: 1 / k }));
    assert.deepEqual(b.shape, a.shape, `scale ${k}`);
    assert.equal(b.lines, a.lines);
  }, { runs: 60 });
});

test('metamorphic: any axis wiring and sign, set to match, finds the same gestures', async () => {
  const wirings: Partial<Settings>[] = [
    { pitchAxis: 'z', yawAxis: 'x', pitchSign: -1, yawSign: 1 },
    { pitchAxis: 'y', yawAxis: 'z', pitchSign: 1, yawSign: -1 },
    { pitchAxis: 'x', yawAxis: 'y', pitchSign: -1, yawSign: -1 },
  ];
  await forAll((r) => ({ seed: r.int(1, 1e9), w: r.pick(wirings) }), ({ seed, w }) => {
    const m = randomMotionSeq(new Rng(seed), 2, 6);
    const other = sanitizeSettings({ ...base, ...w });
    const a = run(stream(m, { seed }), base);
    const b = run(stream(m, { seed, settings: other }), other);
    assert.deepEqual(b.shape, a.shape, JSON.stringify(w));
    assert.deepEqual(b.times, a.times);
  }, { runs: 60 });
});

test('metamorphic: a mirror image (left and right swapped) finds the same gestures', async () => {
  await forAll((r) => r.int(1, 1e9), (seed) => {
    const m = randomMotionSeq(new Rng(seed), 2, 6);
    const a = run(stream(m, { seed, noiseDeg: 0 }), base);
    const b = run(stream(mapPose(m, (p) => ({ pitch: p.pitch, yaw: -p.yaw })), { seed, noiseDeg: 0 }), base);
    assert.deepEqual(b.shape, a.shape);
  }, { runs: 60 });
});

test('metamorphic: shifting the clock by days changes nothing but the times', async () => {
  await forAll((r) => ({ seed: r.int(1, 1e9), offset: r.pick([86_400_000, 1.7e12, 5]) }), ({ seed, offset }) => {
    const m = randomMotionSeq(new Rng(seed), 2, 6);
    const a = run(stream(m, { seed }), base);
    const b = run(stream(m, { seed, startT: offset }), base);
    assert.deepEqual(b.shape, a.shape);
    assert.deepEqual(b.times.map((t) => Math.round(t - offset)), a.times.map((t) => Math.round(t)));
  }, { runs: 40 });
});

test('metamorphic: a constant yaw offset (facing another way) changes nothing', async () => {
  await forAll((r) => ({ seed: r.int(1, 1e9), yaw: r.float(-170, 170) }), ({ seed, yaw }) => {
    const m = randomMotionSeq(new Rng(seed), 2, 6);
    const a = run(stream(m, { seed, noiseDeg: 0 }), base);
    const b = run(stream(mapPose(m, (p) => ({ pitch: p.pitch, yaw: p.yaw + yaw })), { seed, noiseDeg: 0 }), base);
    assert.deepEqual(b.shape, a.shape);
  }, { runs: 40 });
});

// Sample rate changes the data itself, so only clear, labelled gestures are
// compared, not borderline random motion.
test('metamorphic: the labelled scenarios give the same gestures at 25, 50 and 100 Hz', () => {
  for (const s of SCENARIOS) {
    if (s.name === 'walking' || s.name === 'talking' || s.name === 'shake-while-walking') continue;
    const at = (hz: number) => run(stream(s.motion(1), { hz, seed: 3 }), base).shape;
    const ref = at(50);
    assert.deepEqual(at(25), ref, `${s.name} at 25 Hz`);
    assert.deepEqual(at(100), ref, `${s.name} at 100 Hz`);
  }
});

test('metamorphic: deliberate gestures are found the same way at every rate from 15 to 100 Hz', async () => {
  await forAll((r) => ({ amp: r.float(18, 30), f: r.float(1.7, 2.8), deg: r.float(22, 32), ramp: r.int(150, 300), sign: r.bool() ? 1 : -1 }), ({ amp, f, deg, ramp, sign }) => {
    const m = sequence(still(1500), shake({ ampDeg: amp, hz: f, cycles: 2 }), still(2000), tilt(sign * deg, { rampMs: ramp, holdMs: 1200 }), still(800));
    const want = ['shake', sign > 0 ? 'tilt-up' : 'tilt-down'];
    for (const hz of [15, 25, 50, 100]) assert.deepEqual(run(stream(m, { hz, seed: hz }), base).shape, want, `${hz} Hz`);
  }, { runs: 40 });
});

test('metamorphic: the same motion as rate data, with rate settings, finds the same deliberate gestures', async () => {
  const rate = sanitizeSettings({ ...base, imuMode: 'rate' });
  await forAll((r) => ({ amp: r.float(18, 30), f: r.float(1.7, 2.8), deg: r.float(22, 32), sign: r.bool() ? 1 : -1 }), ({ amp, f, deg, sign }) => {
    const m = sequence(still(1500), shake({ ampDeg: amp, hz: f, cycles: 2 }), still(2000), tilt(sign * deg, { rampMs: 200, holdMs: 1200 }), still(800));
    assert.deepEqual(run(stream(m, { seed: 1, settings: rate }), rate).shape, run(stream(m, { seed: 1 }), base).shape);
  }, { runs: 30 });
});

test('metamorphic coverage: a real share of the random cases contained gestures', () => {
  assert.ok(seen.withGesture >= seen.cases * 0.25, `${seen.withGesture} of ${seen.cases}`);
  console.log(`# metamorphic cases ${seen.cases}, with a gesture ${seen.withGesture}`);
});
