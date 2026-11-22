import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAPTURE_COUNTDOWN_MS, CAPTURE_DURATION_MS, CalibrationWizard, extractSwings } from '../src/core/calibration.ts';
import { countGestures } from '../src/core/scenarios.ts';
import { sanitizeSettings, type Settings } from '../src/core/settings.ts';
import { SETTINGS_KEY } from '../src/core/storage.ts';
import { sequence, shake, still, stream, tilt, type Motion } from '../src/core/synth.ts';
import { recordCalibration, Rig } from './helpers.ts';

// What the real device might do, unknown to the wizard.
const device = (patch: Partial<Settings>) => sanitizeSettings(patch);

function runWizard(hw: Settings, w = new CalibrationWizard(sanitizeSettings({}))) {
  const options = { settings: hw, seed: 9 };
  assert.equal(recordCalibration(w, still(1500), options).ok, true);
  assert.equal(recordCalibration(w, tilt(25, { rampMs: 300, holdMs: 1500, backMs: 1 }), options).ok, true);
  assert.equal(recordCalibration(w, tilt(-27, { rampMs: 300, holdMs: 1500, backMs: 1 }), options).ok, true);
  return { w, result: recordCalibration(w, shake({ ampDeg: 24, hz: 2, cycles: 3 }), options) };
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

test('a failed settings write leaves the calibration available to save again', async () => {
  const rig = await new Rig().start();
  const hw = device({ pitchAxis: 'z', yawAxis: 'x' });
  const { w, result } = runWizard(hw, rig.a.startCalibration());
  assert.equal(result.ok, true);
  const write = rig.store.set.bind(rig.store);
  rig.store.set = async () => false;
  assert.equal(await rig.a.finishCalibration(true), false);
  assert.equal(w.step, 'review');
  assert.notEqual(rig.a.settings.pitchAxis, 'z');
  rig.store.set = write;
  assert.equal(await rig.a.finishCalibration(true), true);
  assert.equal(rig.a.settings.pitchAxis, 'z');
  assert.equal(JSON.parse((await rig.store.get(SETTINGS_KEY))!).pitchAxis, 'z');
});

test('saving calibration preserves unlock and scrolling choices made since it began', async () => {
  const rig = await new Rig().start();
  const { result } = runWizard(device({ pitchAxis: 'z', yawAxis: 'x' }), rig.a.startCalibration());
  assert.equal(result.ok, true);
  await rig.a.updateSettings({ unlockGesture: 'touch', recoveryPresses: 5, tiltEnabled: false });
  assert.equal(await rig.a.finishCalibration(true), true);
  assert.equal(rig.a.settings.pitchAxis, 'z');
  assert.equal(rig.a.settings.unlockGesture, 'touch');
  assert.equal(rig.a.settings.recoveryPresses, 5);
  assert.equal(rig.a.settings.tiltEnabled, false);
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

test('a missed tilt is rejected immediately and the user can retry just that step', () => {
  const w = new CalibrationWizard(sanitizeSettings({}));
  assert.equal(recordCalibration(w, still(1000)).ok, true);
  assert.equal(recordCalibration(w, still(1000)).ok, false);
  assert.equal(w.step, 'tiltUp');
  assert.equal(recordCalibration(w, tilt(25, { backMs: 1 })).ok, true);
  assert.equal(recordCalibration(w, tilt(25, { backMs: 1 })).ok, false);
  assert.equal(w.step, 'tiltDown');
  assert.equal(recordCalibration(w, tilt(-25, { backMs: 1 })).ok, true);
  assert.equal(recordCalibration(w, still(1000)).ok, false);
  assert.equal(w.step, 'shake');
  assert.equal(recordCalibration(w, sequence(still(2000), shake({ cycles: 3 }))).ok, true);
  assert.equal(w.step, 'review');
});

test('reading time and the countdown do not enter the recording', () => {
  const w = new CalibrationWizard(sanitizeSettings({}));
  const start = 120_000;
  for (const s of stream(shake(), { startT: 0 })) w.push(s);
  assert.equal(w.captureProgress(start), null);
  w.beginCapture(start);
  assert.deepEqual(w.captureProgress(start), { phase: 'countdown', seconds: 3 });
  for (const s of stream(tilt(25), { startT: start + 10 })) w.push(s);
  const recordingStart = start + CAPTURE_COUNTDOWN_MS;
  const end = recordingStart + CAPTURE_DURATION_MS.neutral;
  for (const s of stream(still(CAPTURE_DURATION_MS.neutral), { startT: recordingStart, hz: 10 })) w.push(s);
  w.push({ t: end, x: 9e8, y: 0, z: 0 });
  assert.equal(w.finishCapture(end - 1), null);
  assert.equal(w.finishCapture(end)?.ok, true);
  assert.equal(recordCalibration(w, tilt(25, { backMs: 1 })).ok, true);
});

test('a missing or interrupted sensor recording can be retried', () => {
  const w = new CalibrationWizard(sanitizeSettings({}));
  const end = CAPTURE_COUNTDOWN_MS + CAPTURE_DURATION_MS.neutral;
  w.beginCapture(0);
  assert.equal(w.interruptCapture(), true);
  assert.equal(w.finishCapture(end), null);
  w.beginCapture(0);
  for (const s of stream(still(1000), { startT: CAPTURE_COUNTDOWN_MS })) w.push(s);
  assert.equal(w.finishCapture(end)?.sensorIssue, true);
  assert.equal(w.step, 'neutral');
  assert.equal(recordCalibration(w, still(1000)).ok, true);
});

test('swing extraction ignores small reversals', () => {
  const t = [0, 100, 200, 300, 400, 500];
  assert.equal(extractSwings(t, [0, 10, 9, 20, 0, 20], 5).length, 3);
});

test('real G2 shape: 10 Hz, noisy, small raw values: the saved gestures actually fire', () => {
  for (const noiseDeg of [0.3, 0.8, 1.5]) {
    const hw = device({ imuScale: 50 }); // the G2 calibrated at 50 to 66: small raw values
    const w = new CalibrationWizard(sanitizeSettings({}));
    const options = { settings: hw, seed: 4, hz: 10, noiseDeg };
    recordCalibration(w, still(1500), options);
    recordCalibration(w, tilt(18, { rampMs: 400, holdMs: 1500, backMs: 1 }), options);
    recordCalibration(w, tilt(-24, { rampMs: 400, holdMs: 1500, backMs: 1 }), options);
    const r = recordCalibration(w, shake({ ampDeg: 24, hz: 2, cycles: 3 }), options);
    if (!r.ok) { assert.match(r.error ?? '', /unsteady|shake/i, `noise ${noiseDeg}: ${r.error}`); continue; }
    const p = w.proposal()!;
    assert.ok(p.tiltUpDeg < p.tiltMaxDeg && p.deadZoneDeg < p.tiltUpDeg, `noise ${noiseDeg}`);
    for (const deg of [18, -24]) {
      const m = sequence(still(1500), tilt(deg, { rampMs: 400, holdMs: 1500 }), still(1000));
      const c = countGestures(stream(m, { ...options, settings: hw }), p);
      assert.equal(c.tiltStarts, 1, `noise ${noiseDeg}, tilt ${deg}`);
    }
  }
});

test('real G2 data is gravity: calibration switches to true angles in degrees', () => {
  // Accelerometer samples like the G2's: head about 20 degrees down at rest, x forward, z up.
  const g = (pitchDeg: number, rollDeg = 0) => {
    const p = (pitchDeg * Math.PI) / 180, r = (rollDeg * Math.PI) / 180;
    return { x: Math.sin(p), y: Math.cos(p) * Math.sin(r), z: Math.cos(p) * Math.cos(r) };
  };
  const w = new CalibrationWizard(sanitizeSettings({}));
  const feed = (f: (t: number) => { x: number; y: number; z: number }) => {
    w.beginCapture(0);
    const start = CAPTURE_COUNTDOWN_MS, step = w.captureStep()!;
    const end = start + CAPTURE_DURATION_MS[step];
    let i = 0;
    for (let t = start; t < end; t += 100) w.push({ t, ...f(t), x: f(t).x + 0.004 * Math.sin(i++ * 2.1) });
    return w.finishCapture(end)!;
  };
  assert.equal(feed(() => g(-20)).ok, true);
  assert.equal(feed((t) => g(-20 + Math.min(1, (t - 3000) / 400) * 22)).ok, true);
  assert.equal(feed((t) => g(-20 - Math.min(1, (t - 3000) / 400) * 24)).ok, true);
  const r = feed((t) => g(-20, 25 * Math.sin(((t - 3000) / 1000) * 2 * Math.PI * 2)));
  assert.equal(r.ok, true, r.error);
  const p = w.proposal()!;
  assert.equal(p.gravityAngles, true);
  assert.equal(p.imuScale, 1);
  assert.equal(p.pitchAxis, 'x');
  assert.ok(Math.abs(p.neutralPitch! + 20) < 1, `neutral ${p.neutralPitch}`);
  assert.ok(p.tiltUpDeg > 10 && p.tiltUpDeg < 16, `up ${p.tiltUpDeg}`);
  assert.ok(p.tiltDownDeg > 11 && p.tiltDownDeg < 18, `down ${p.tiltDownDeg}`);
});
