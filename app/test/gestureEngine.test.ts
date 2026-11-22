import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS, countGestures, scenario } from '../src/core/scenarios.ts';
import { DEFAULT_SETTINGS, sanitizeSettings, type Settings } from '../src/core/settings.ts';
import { ShakeDetector } from '../src/core/shakeDetector.ts';
import { sequence, shake, still, stream, talking, tilt, together, walking, type StreamOptions } from '../src/core/synth.ts';

const base = sanitizeSettings(DEFAULT_SETTINGS);
const run = (name: string, o: StreamOptions = {}, s: Settings = base) =>
  countGestures(stream(scenario(name).motion(o.seed ?? 1), { settings: s, ...o }), s, true);

const checkExpected = (name: string, o: StreamOptions, s: Settings) => {
  const sc = scenario(name);
  const c = run(name, o, s);
  assert.equal(c.shakes, sc.expect.shakes, `${name}: shakes`);
  assert.equal(c.upLines > 0, sc.expect.up, `${name}: up lines ${c.upLines}`);
  assert.equal(c.downLines > 0, sc.expect.down, `${name}: down lines ${c.downLines}`);
};

// The reading case scrolls by design only if it looks deliberate. Everything
// here must hold under every stream condition.
const conditions: [string, StreamOptions][] = [
  ['clean 50 Hz', { hz: 50 }],
  ['clean 25 Hz', { hz: 25 }],
  ['100 Hz', { hz: 100 }],
  ['jitter 12 ms', { hz: 50, jitterMs: 12 }],
  ['5% dropped', { hz: 50, dropRate: 0.05 }],
  ['batches of 4', { hz: 50, batch: 4 }],
  ['jitter, drops and batches', { hz: 50, jitterMs: 8, dropRate: 0.03, batch: 3 }],
];

for (const [label, o] of conditions) {
  for (const s of SCENARIOS) {
    test(`${s.name} under ${label}`, () => checkExpected(s.name, { seed: 3, ...o }, base));
  }
}

const remapped = sanitizeSettings({ ...base, pitchAxis: 'z', yawAxis: 'x', pitchSign: -1, yawSign: -1, imuScale: 0.01 });
const rate = sanitizeSettings({ ...base, imuMode: 'rate' });

for (const name of ['tilt-up', 'tilt-down', 'shake', 'looking-sideways', 'nodding', 'shake-during-tilt']) {
  test(`${name} with a different axis mapping, sign and scale`, () => checkExpected(name, { seed: 4 }, remapped));
  test(`${name} in rate mode`, () => checkExpected(name, { seed: 4 }, rate));
}

test('rate mode tolerates a small leftover gyro bias', () => {
  for (const name of ['tilt-down', 'shake', 'reading-slow-look-down']) {
    checkExpected(name, { seed: 5, rateBias: 0.05 }, rate);
  }
});

test('scrolling is continuous while tilted and stops at neutral', () => {
  const held = countGestures(stream(sequence(still(1500), tilt(-24, { holdMs: 3000 }), still(2000))), base, true);
  const short = countGestures(stream(sequence(still(1500), tilt(-24, { holdMs: 1000 }), still(2000))), base, true);
  assert.ok(held.downLines >= 8 && held.downLines <= 12, `lines ${held.downLines}`);
  assert.ok(short.downLines < held.downLines);
  const stop = held.events.find((e) => e.type === 'tiltStop');
  assert.equal(stop?.type === 'tiltStop' ? stop.reason : '', 'neutral');
  const lastScroll = held.events.filter((e) => e.type === 'scroll').at(-1)!;
  assert.ok(lastScroll.t <= stop!.t, 'no scroll after the stop');
});

test('scroll speed comes from settings', () => {
  const fast = sanitizeSettings({ ...base, scrollLinesPerSec: 6 });
  const m = () => sequence(still(1500), tilt(-24, { holdMs: 3000 }), still(1000));
  const slow = countGestures(stream(m()), base).downLines;
  const quick = countGestures(stream(m()), fast).downLines;
  assert.ok(quick > slow * 1.6, `${quick} vs ${slow}`);
});

test('a deeper tilt scrolls faster, a small tilt reads slowly', () => {
  const m = (deg: number) => sequence(still(1500), tilt(deg, { holdMs: 3000 }), still(1000));
  const shallow = countGestures(stream(m(-21)), base).downLines;
  const deep = countGestures(stream(m(-33)), base).downLines;
  assert.ok(shallow >= 6 && shallow <= 10, `shallow ${shallow}`);
  assert.ok(deep > shallow * 1.5, `${deep} vs ${shallow}`);
  assert.ok(deep <= 3 * base.scrollMaxLinesPerSec + 2, `deep ${deep}`);
});

test('the speed setting for a deep tilt is never below the base speed', () => {
  const s = sanitizeSettings({ ...base, scrollLinesPerSec: 9, scrollMaxLinesPerSec: 2 });
  assert.equal(s.scrollMaxLinesPerSec, 9);
});

test('real glasses: a natural tilt at 10 Hz with sensor noise scrolls every time once noise is calibrated', () => {
  // Values like the calibration on the user's G2 (2026-11-14): up 12.8, down 15.8, dead zone 5.9.
  const tuned = sanitizeSettings({ ...base, tiltUpDeg: 12.8, tiltDownDeg: 15.8, deadZoneDeg: 5.9, tiltHysteresisDeg: 2.5, tiltMaxDeg: 40, sensorNoiseDeg: 0.8, smoothingMs: 120 });
  const untuned = sanitizeSettings({ ...tuned, sensorNoiseDeg: 0 });
  let tunedHits = 0, untunedHits = 0;
  for (let seed = 1; seed <= 20; seed++) {
    for (const [deg, rampMs] of [[-22, 600], [20, 500], [-24, 750]] as const) {
      const m = sequence(still(1500), tilt(deg, { rampMs, holdMs: 1500 }), still(1000));
      const opts = { hz: 10, noiseDeg: 0.8, seed };
      if (countGestures(stream(m, opts), tuned).tiltStarts === 1) tunedHits++;
      if (countGestures(stream(m, opts), untuned).tiltStarts === 1) untunedHits++;
    }
  }
  assert.equal(tunedHits, 60, `tuned ${tunedHits}/60, untuned ${untunedHits}/60`);
});

test('a tilt shorter than the minimum duration does nothing', () => {
  const c = countGestures(stream(sequence(still(1500), tilt(-24, { rampMs: 100, holdMs: 150, backMs: 100 }), still(800))), base);
  assert.equal(c.tiltStarts, 0);
});

test('a gradual tilt up or down scrolls once it reaches and holds the calibrated angle', () => {
  const settings = sanitizeSettings({ deadZoneDeg: 3.7, tiltUpDeg: 8, tiltDownDeg: 20.6, tiltMaxDeg: 54, tiltHysteresisDeg: 1.85 });
  const rampMs = 950;
  for (const hz of [10, 15, 50]) {
    for (const [angle, direction] of [[12, 'up'], [-25, 'down']] as const) {
      const motion = sequence(still(1500), tilt(angle, { rampMs, holdMs: 1200 }), still(800));
      const result = countGestures(stream(motion, { hz, jitterMs: 12, seed: 2 }), settings, true);
      const first = result.events.find((event) => event.type === 'scroll');
      assert.ok(first, `${direction} at ${hz} Hz`);
      assert.equal(first.direction, direction);
      assert.ok(first.t >= 1500 + rampMs, 'waits until the tilt settles');
      assert.ok(first.t <= 1500 + rampMs + 550, 'starts promptly during the hold');
      assert.equal(result.tiltStarts, 1);
      assert.equal(direction === 'up' ? result.downLines : result.upLines, 0);
    }
  }
});

test('risk 5: a slow look down never scrolls, however far inside the band', () => {
  for (const rampMs of [1500, 2500, 4000]) {
    const c = countGestures(stream(sequence(still(1500), tilt(-28, { rampMs, holdMs: 8000, backMs: rampMs }), still(800))), base);
    assert.equal(c.tiltStarts, 0, `ramp ${rampMs}`);
  }
});

test('risk 5: a fast look down that stays is bounded by the hold limit', () => {
  const c = countGestures(stream(sequence(still(1500), tilt(-26, { rampMs: 300, holdMs: 30_000, backMs: 500 }), still(800))), base, true);
  const limit = (base.tiltMaxHoldMs / 1000) * base.scrollMaxLinesPerSec + 2;
  assert.ok(c.downLines <= limit, `lines ${c.downLines}, limit ${limit}`);
  assert.equal(c.tiltStarts, 1, 'staying down must not restart scrolling');
  assert.ok(c.events.some((e) => e.type === 'tiltStop' && e.reason === 'hold-limit'));
});

test('tilt can be switched off without affecting shake', () => {
  const off = sanitizeSettings({ ...base, tiltEnabled: false });
  assert.equal(run('tilt-down', {}, off).tiltStarts, 0);
  assert.equal(run('shake', {}, off).shakes, 1);
});

test('shake sensitivity changes what counts as a shake', () => {
  const soft = sequence(still(1500), shake({ ampDeg: 10, hz: 2.5, cycles: 3 }), still(800));
  assert.equal(countGestures(stream(soft), base).shakes, 0);
  assert.equal(countGestures(stream(soft), sanitizeSettings({ ...base, shakeSensitivity: 1.6 })).shakes, 1);
});

test('one long shake fires once because of the cooldown', () => {
  const c = countGestures(stream(sequence(still(1500), shake({ cycles: 4 }), still(800))), base);
  assert.equal(c.shakes, 1);
});

test('two shakes separated by more than the cooldown fire twice', () => {
  const c = countGestures(stream(sequence(still(1500), shake(), still(1500), shake(), still(500))), base);
  assert.equal(c.shakes, 2);
});

test('a too slow or too huge side to side motion is not a shake', () => {
  const slow = sequence(still(1500), shake({ ampDeg: 25, hz: 0.7, cycles: 3 }), still(500));
  const huge = sequence(still(1500), shake({ ampDeg: 60, hz: 2, cycles: 2 }), still(500));
  assert.equal(countGestures(stream(slow), base).shakes, 0);
  assert.equal(countGestures(stream(huge), base).shakes, 0);
});

test('tilt does not fire while a shake may be starting, even if the shake never completes', () => {
  // One fast cycle is not a shake, but the tilt started with it must still be dropped.
  // Both orders matter: yaw first, and tilt first with the yaw just after.
  for (const offset of [0, 120, 200]) {
    const m = sequence(still(1500), together(tilt(-24, { rampMs: 120, holdMs: 1500 }), shake({ cycles: 1 }), offset), still(800));
    const c = countGestures(stream(m), base);
    assert.equal(c.shakes, 0, `offset ${offset}`);
    assert.equal(c.tiltStarts, 0, `offset ${offset}`);
  }
});

test('looking past the upper limit during a scroll stops it', () => {
  const m = sequence(still(1500), tilt(-24, { holdMs: 4000 }));
  const deeper = { durMs: m.durMs, pose: (t: number) => { const p = m.pose(t); return { yaw: p.yaw, pitch: t > 3500 ? -55 : p.pitch }; } };
  const c = countGestures(stream(deeper), base, true);
  assert.ok(c.events.some((e) => e.type === 'tiltStop' && e.reason === 'overshoot'));
});

test('a head roll with as much pitch as yaw is not a shake', () => {
  const s = shake({ ampDeg: 24, hz: 2, cycles: 3 });
  const roll = { durMs: s.durMs, pose: (t: number) => { const p = s.pose(t); return { yaw: p.yaw, pitch: 0.9 * s.pose(t + 125).yaw }; } };
  assert.equal(countGestures(stream(sequence(still(1500), roll, still(500))), base).shakes, 0);
});

test('swings slower than the limit are rejected even when fast enough on average', () => {
  const m = sequence(still(1500), shake({ ampDeg: 40, hz: 1, cycles: 3 }), still(500));
  assert.equal(countGestures(stream(m), base).shakes, 0);
});

test('the total time limit is respected', () => {
  const m = () => sequence(still(1500), shake({ ampDeg: 24, hz: 2, cycles: 3 }), still(500));
  assert.equal(countGestures(stream(m()), base).shakes, 1);
  assert.equal(countGestures(stream(m()), sanitizeSettings({ ...base, shakeMaxTotalMs: 300 })).shakes, 0);
});

test('swings of very different size do not chain into a shake', () => {
  const d = new ShakeDetector(base);
  let fired = 0;
  const points = [0, 27, -58, -31, -116, -89, -174, -147];
  let t = 0;
  for (let i = 1; i < points.length; i++) {
    for (let k = 1; k <= 10; k++) {
      t += 20;
      if (d.push(t, points[i - 1] + ((points[i] - points[i - 1]) * k) / 10, 0)) fired++;
    }
  }
  assert.equal(fired, 0);
});

test('a dropout in the middle of a shake cancels it', () => {
  const samples = [...stream(sequence(still(1500), shake({ cycles: 3 }), still(800)))]
    .filter((s) => s.t < 1900 || s.t > 2600);
  assert.equal(countGestures(samples, base).shakes, 0);
});

test('a dropout during a scroll stops it', () => {
  const samples = [...stream(sequence(still(1500), tilt(-24, { holdMs: 4000 }), still(800)))]
    .filter((s) => s.t < 3000 || s.t > 3600);
  const c = countGestures(samples, base, true);
  assert.ok(c.events.some((e) => e.type === 'tiltStop' && e.reason === 'gap'));
});

test('neutral is learned, so a head held at an offset still scrolls correctly', () => {
  const offset = (samples: Iterable<{ x: number; y: number; z: number; t: number }>) =>
    [...samples].map((s) => ({ ...s, x: s.x + 9 }));
  const c = countGestures(offset(stream(sequence(still(1500), tilt(-24), still(800)))), base);
  assert.ok(c.downLines > 0 && c.upLines === 0);
});

test('a stored neutral is not replaced by a pose far away from it', () => {
  const stored = sanitizeSettings({ ...base, neutralPitch: 0 });
  // Starts looking far down and still: must not become the new neutral.
  const samples = [...stream(still(3000))].map((s) => ({ ...s, x: s.x - 25 }));
  const c = countGestures(samples, stored, true);
  assert.equal(c.events.filter((e) => e.type === 'neutral').length, 0);
});

test('slow posture change is absorbed by drift tracking', () => {
  // Slumps 8 degrees, then tilts 32 from there. Measured from the old neutral that
  // is 40, past the upper limit, so this scrolls only if neutral really followed.
  const long = 300_000;
  const drift = { durMs: long, pose: (t: number) => ({ pitch: -8 * (t / long), yaw: 0 }) };
  const t = tilt(-32);
  const after = { durMs: t.durMs, pose: (u: number) => ({ pitch: t.pose(u).pitch - 8, yaw: 0 }) };
  const c = countGestures(stream(sequence(still(1500), drift, after, still(500))), base);
  assert.ok(c.downLines > 0, 'still scrolls after the posture has moved');
  assert.equal(c.upLines, 0);
});

test('short walking and talking runs stay quiet', () => {
  for (const seed of [1, 2, 3]) {
    const w = countGestures(stream(walking(120_000, seed), { jitterMs: 8, dropRate: 0.02, seed }), base);
    const t = countGestures(stream(talking(120_000, seed), { jitterMs: 8, dropRate: 0.02, seed }), base);
    assert.equal(w.shakes + w.tiltStarts + t.shakes + t.tiltStarts, 0);
  }
});

// Review findings, 2026-11-14: re-centering must not ratchet or fire a false opposite tilt.
const pose = (durMs: number, from: number, to: number, rampMs = 300) =>
  ({ durMs, pose: (t: number) => ({ pitch: from + (to - from) * Math.min(1, t / rampMs), yaw: 0 }) });

test('re-centering: a look down in steps does not become neutral, and coming back does not scroll up', () => {
  const m = sequence(still(1500), pose(1500, 0, -10), pose(1500, -10, -20), pose(3000, -20, -30), pose(2500, -30, 0, 400));
  for (const hz of [10, 50]) {
    const r = countGestures(stream(m, { hz, noiseDeg: 0.3 }), base, true);
    assert.equal(r.upLines, 0, `${hz} Hz`);
  }
});

test('re-centering: a pause on the way back from a scroll is not the new rest', () => {
  const m = sequence(still(1500), pose(1500, 0, -24, 200), pose(1200, -24, -10), pose(2000, -10, 7));
  for (const hz of [10, 50]) for (let seed = 1; seed <= 5; seed++) {
    const r = countGestures(stream(m, { hz, noiseDeg: 0.5, seed }), base, true);
    assert.equal(r.upLines, 0, `${hz} Hz seed ${seed}`);
  }
});

test('re-centering: a resting pose just outside the dead zone stops locking tilt', () => {
  // The head settles 8 degrees down and stays: a later deliberate tilt still works.
  const m = sequence(still(1500), pose(4000, 0, -8, 600), pose(1500, -8, -8 - 24, 200), pose(1500, -32, -8, 300), still(0));
  const r = countGestures(stream(m, { hz: 10, noiseDeg: 0.3 }), base, true);
  assert.equal(r.tiltStarts, 1);
  assert.ok(r.downLines >= 1);
});
