import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CalibrationWizard, extractSwings } from '../src/core/calibration.ts';
import { countGestures } from '../src/core/scenarios.ts';
import { sanitizeSettings, type Settings } from '../src/core/settings.ts';
import { sequence, shake, still, stream, tilt, type Motion } from '../src/core/synth.ts';

// What the real device might do, unknown to the wizard.
const device = (patch: Partial<Settings>) => sanitizeSettings(patch);

function runWizard(hw: Settings, base = sanitizeSettings({})) {
  const w = new CalibrationWizard(base);
  const feed = (m: Motion, startT: number) => { for (const s of stream(m, { settings: hw, startT, seed: 9 })) w.push(s); };
  feed(still(1500), 0);
  assert.equal(w.next().ok, true);
  feed(tilt(25, { rampMs: 300, holdMs: 1500, backMs: 1 }), 2000);
  assert.equal(w.next().ok, true);
  feed(tilt(-27, { rampMs: 300, holdMs: 1500, backMs: 1 }), 4000);
  assert.equal(w.next().ok, true);
  feed(shake({ ampDeg: 24, hz: 2, cycles: 3 }), 6000);
  return { w, result: w.next() };
}

test('the wizard walks through its steps and only proposes', () => {
  const { w, result } = runWizard(device({}));
  assert.equal(result.ok, true, result.error);
  assert.equal(w.step, 'review');
  assert.ok(w.proposal());
  assert.ok(w.accept());
  assert.equal(w.step, 'done');
  assert.equal(w.proposal(), null);
});

test('cancel discards the proposal', () => {
  const { w } = runWizard(device({}));
  w.cancel();
  assert.equal(w.accept(), null);
});

test('it finds an unknown axis mapping and sign, in orientation mode', () => {
  const hw = device({ pitchAxis: 'z', yawAxis: 'x', pitchSign: -1 });
  const p = runWizard(hw).w.proposal()!;
  assert.equal(p.imuMode, 'orientation');
  assert.equal(p.pitchAxis, 'z');
  assert.equal(p.pitchSign, -1);
  assert.equal(p.yawAxis, 'x');
});

test('it detects rate-like data', () => {
  const p = runWizard(device({ imuMode: 'rate', pitchAxis: 'y', yawAxis: 'z' })).w.proposal()!;
  assert.equal(p.imuMode, 'rate');
  assert.equal(p.pitchAxis, 'y');
  assert.equal(p.pitchSign, 1);
  assert.equal(p.yawAxis, 'z');
});

test('it works in unknown units, such as radians', () => {
  const hw = device({ imuScale: 180 / Math.PI });
  const p = runWizard(hw).w.proposal()!;
  assert.ok(p.imuScale > 40 && p.imuScale < 70, `scale ${p.imuScale}`);
  assert.ok(Math.abs(p.tiltUpDeg - 14) < 3, `up ${p.tiltUpDeg}`);
});

for (const [label, hw] of [
  ['orientation', device({ pitchAxis: 'z', yawAxis: 'x', pitchSign: -1 })],
  ['rate', device({ imuMode: 'rate', pitchAxis: 'y', yawAxis: 'z' })],
  ['radians', device({ imuScale: 180 / Math.PI })],
] as const) {
  test(`gestures work after calibrating against ${label} data`, () => {
    const p = runWizard(hw).w.proposal()!;
    const play = (m: Motion) => countGestures(stream(sequence(still(1500), m, still(800)), { settings: hw, seed: 12 }), p);
    assert.ok(play(tilt(-25)).downLines > 0, 'tilt down');
    assert.ok(play(tilt(25)).upLines > 0, 'tilt up');
    assert.equal(play(shake({ ampDeg: 24 })).shakes, 1, 'shake');
    assert.equal(play(still(5000)).shakes, 0, 'still');
  });
}

test('a user who does not move gets an error, and the step restarts', () => {
  const hw = device({});
  const w = new CalibrationWizard(sanitizeSettings({}));
  for (const step of [0, 1, 2]) {
    for (const s of stream(still(1000), { startT: step * 2000, settings: hw })) w.push(s);
    assert.equal(w.next().ok, true);
  }
  for (const s of stream(still(1000), { startT: 8000, settings: hw })) w.push(s);
  const r = w.next();
  assert.equal(r.ok, false);
  assert.equal(w.step, 'shake');
});

test('no samples gives a clear error', () => {
  const r = new CalibrationWizard(sanitizeSettings({})).next();
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /samples/);
});

test('swing extraction ignores small reversals', () => {
  const t = [0, 100, 200, 300, 400, 500];
  assert.equal(extractSwings(t, [0, 10, 9, 20, 0, 20], 5).length, 3);
});
