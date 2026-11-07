// Regression tests from the adversarial review. Each one failed before its fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CalibrationWizard } from '../src/core/calibration.ts';
import { GestureEngine, type GestureEvent } from '../src/core/gestureEngine.ts';
import { ImuAdapter, toRawSample, type RawSample } from '../src/core/imuAdapter.ts';
import { countGestures } from '../src/core/scenarios.ts';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/core/settings.ts';
import { MemoryStore, SESSION_KEY, SessionWriter, type Session } from '../src/core/storage.ts';
import { sequence, shake, still, stream, tilt } from '../src/core/synth.ts';
import { wearHelpHidden } from '../src/panel.ts';
import { Rig } from './helpers.ts';

const answer = (id = 'q1') => ({
  id,
  short: `Short answer ${id}`,
  details: Array.from({ length: 40 }, (_, i) => `Detail line ${i + 1}`).join('\n'),
});

async function visibleWithAnswer(): Promise<Rig> {
  const r = await new Rig().ready();
  r.play(shake());
  r.a.aiResult(answer());
  r.a.handleTouch('press');
  r.wait(1500);
  r.play(still(800));
  assert.equal(r.a.state, 'VISIBLE');
  return r;
}

// ---- Content on the lens when it must be dark ----

test('a first "disconnected" status hides content revealed before any status arrived', async () => {
  const r = await new Rig().start();
  for (let i = 0; i < 4; i++) r.a.handleTouch('press');
  assert.equal(r.a.state, 'VISIBLE');
  r.a.handleConnection(false);
  assert.equal(r.a.state, 'HIDDEN');
  assert.equal(r.lit(), false);
  r.a.handleConnection(true);
  assert.equal(r.a.state, 'HIDDEN', 'a reconnect must not bring it back');
});

test('an app exit hides, so a later foreground event cannot redraw content', async () => {
  const r = await visibleWithAnswer();
  r.a.handleExit();
  assert.equal(r.a.state, 'HIDDEN');
  assert.equal(r.lit(), false);
  r.a.handleForeground();
  assert.equal(r.a.state, 'HIDDEN');
  assert.equal(r.lit(), false);
});

// ---- Hidden-state traps ----

test('a phone clock stepping backwards does not block touch recovery', async () => {
  const r = await new Rig().ready();
  r.time -= 3_600_000;
  for (let i = 0; i < 4; i++) { r.a.handleTouch('press'); r.wait(200); }
  assert.equal(r.a.state, 'VISIBLE');
});

test('a phone clock stepping backwards does not block the next shake', async () => {
  const r = await new Rig().ready();
  r.play(shake());
  assert.equal(r.a.state, 'VISIBLE');
  r.wait(1500);
  r.time -= 3_600_000;
  r.play(still(1500));
  r.play(shake());
  assert.equal(r.a.state, 'HIDDEN');
});

test('a storage write that hangs cannot block the wear sensor escape', async () => {
  const r = await new Rig().start();
  r.a.handleConnection(true);
  r.a.handleWear(false);
  assert.equal(r.a.state, 'REMOVED');
  r.store.set = () => new Promise(() => {});
  void r.a.updateSettings({ trustWearSensor: false });
  assert.equal(r.a.state, 'HIDDEN');
});

test('the wear help stays on while Removed, even after the wear value turned unknown', async () => {
  const r = await new Rig().start();
  r.a.handleConnection(true);
  r.a.handleWear(false);
  r.a.handleConnection(false);
  const s = r.a.snapshot();
  assert.equal(s.state, 'REMOVED');
  assert.equal(s.wear, 'unknown');
  assert.equal(wearHelpHidden(s), false);
  assert.equal(wearHelpHidden({ state: 'HIDDEN' }), true);
});

test('settings can never make shake or touch recovery impossible', () => {
  const a = sanitizeSettings({ shakeSensitivity: 0.25 });
  assert.ok(a.shakeMaxAmpDeg > a.shakeMinAmpDeg / a.shakeSensitivity, 'smallest swing fits under the largest');

  const b = sanitizeSettings({ shakeMinRateDps: 3000, shakeMaxAmpDeg: 90, shakeMinSwingMs: 60 });
  assert.ok((b.shakeMaxAmpDeg / Math.max(b.shakeMinSwingMs, 1)) * 1000 > b.shakeMinRateDps / b.shakeSensitivity, 'required speed is reachable');

  const c = sanitizeSettings({ shakeSwings: 8, shakeMaxTotalMs: 200, shakeMinSwingMs: 60 });
  assert.ok(c.shakeMaxTotalMs >= c.shakeSwings * c.shakeMinSwingMs, 'all swings fit in the time limit');

  const d = sanitizeSettings({ shakeReversalDeg: 60, shakeMinAmpDeg: 1, shakeMaxAmpDeg: 5 });
  assert.ok(d.shakeMaxAmpDeg > d.shakeReversalDeg, 'a swing can be big enough to count as a reversal');

  const e = sanitizeSettings({ shakeMaxDwellMs: 0 });
  assert.ok(e.shakeMaxDwellMs >= 50, 'turning points take time');

  const f = sanitizeSettings({ recoveryPresses: 10, recoveryWindowMs: 500 });
  assert.ok(f.recoveryWindowMs / f.recoveryPresses >= 400, 'a person can press that fast');
});

test('cleaning settings twice changes nothing', () => {
  const nasty = { shakeSensitivity: 0.25, shakeMinRateDps: 3000, shakeSwings: 8, shakeMaxTotalMs: 200, recoveryPresses: 10, recoveryWindowMs: 500, deadZoneDeg: 30, tiltUpDeg: 2, driftWindowDeg: 45 };
  const once = sanitizeSettings(nasty);
  assert.deepEqual(sanitizeSettings(once), once);
});

test('a bad value in an update keeps the current value, not the factory one', async () => {
  const r = await new Rig().start();
  await r.a.updateSettings({ tiltUpDeg: 22 });
  await r.a.updateSettings({ tiltUpDeg: Number.NaN });
  assert.equal(r.a.settings.tiltUpDeg, 22);
});

test('an update can still clear the stored neutral', async () => {
  const r = await new Rig().start();
  await r.a.updateSettings({ neutralPitch: 4 });
  await r.a.updateSettings({ neutralPitch: null });
  assert.equal(r.a.settings.neutralPitch, null);
});

test('an absurd stored neutral is ignored', () => {
  assert.equal(sanitizeSettings({ neutralPitch: 1e300 }).neutralPitch, null);
});

test('presses made before a lost connection do not count after it', async () => {
  const r = await new Rig().ready();
  r.a.handleTouch('press');
  r.a.handleTouch('press');
  r.a.handleConnection(false);
  r.a.handleConnection(true);
  r.a.handleTouch('press');
  r.a.handleTouch('press');
  assert.equal(r.a.state, 'HIDDEN');
});

// ---- Restore exactly what was hidden ----

test('touch recovery while the head is tilted does not scroll the restored screen', async () => {
  const r = await new Rig().ready();
  r.a.aiResult(answer());
  const samples = [...stream(sequence(tilt(-24, { holdMs: 5000 }), still(100)), { settings: r.a.settings })];
  const start = r.time;
  let pressed = false;
  for (const s of samples) {
    r.time = start + s.t;
    r.a.handleImu({ ...s, t: r.time });
    if (!pressed && s.t > 2000) {
      pressed = true;
      assert.equal(r.a.snapshot().engine.phase, 'active', 'the tilt is running while hidden');
      for (let i = 0; i < 4; i++) r.a.handleTouch('press');
      assert.notEqual(r.a.state, 'HIDDEN');
    }
  }
  assert.equal(r.a.snapshot().topLine, 0);
});

// ---- Stored and displayed errors ----

test('an unseen error is not reported as a new answer after a restart', async () => {
  const store = new MemoryStore();
  const r = await new Rig(store).ready();
  r.a.aiError('Upload failed');
  await r.a.flush();
  const r2 = await new Rig(store).ready();
  assert.equal(r2.a.snapshot().unseen, false);
  r2.play(shake());
  assert.equal(r2.a.state, 'VISIBLE');
  assert.doesNotMatch(r2.text(), /NEW ANSWER/);
});

test('an unseen result survives a later error and a restart', async () => {
  const store = new MemoryStore();
  const r = await new Rig(store).ready();
  r.a.aiResult(answer('kept'));
  r.a.aiError('Second photo failed');
  await r.a.flush();
  const r2 = await new Rig(store).ready();
  assert.equal(r2.a.snapshot().unseen, true);
});

test('a long error fits the screen and keeps the way to dismiss it', async () => {
  const r = await visibleWithAnswer();
  r.a.aiError(`${'word '.repeat(600)}\n`.repeat(4));
  const lines = r.text().split('\n');
  assert.ok(lines.length <= 10, `${lines.length} lines`);
  assert.ok(r.text().length <= 1000);
  assert.match(r.text(), /Press to dismiss/);
});

test('a flush waits for a write in progress, so the last state is not lost', async () => {
  const store = new MemoryStore();
  const set = store.set.bind(store);
  let open!: () => void;
  const gate = new Promise<void>((res) => { open = res; });
  store.set = async (k, v) => { await gate; return set(k, v); };
  const w = new SessionWriter(store, 0);
  const session = (topLine: number): Session => ({ docId: 'a', short: 's', details: 'd', topLine, unseen: false });
  w.queue(session(1));
  const first = w.flush(1);
  w.queue(session(2));
  const last = w.flush(2);
  open();
  await Promise.all([first, last]);
  assert.equal(JSON.parse(store.data.get(SESSION_KEY)!).topLine, 2);
});

test('a timer tick does not queue up behind a write in progress', async () => {
  const store = new MemoryStore();
  store.set = () => new Promise(() => {});
  const w = new SessionWriter(store, 0);
  w.queue({ docId: 'a', short: 's', details: 'd', topLine: 1, unseen: false });
  void w.flush(1);
  await w.tick(5000); // would never return
});

// ---- Calibration ----

test('calibrating does not raise a false "sensor lost"', async () => {
  const r = await visibleWithAnswer();
  r.a.startCalibration();
  r.play(still(5000));
  await r.a.tick();
  assert.equal(r.a.snapshot().sensorStale, false);
  await r.a.finishCalibration(false);
});

test('non-finite samples are kept out of the calibration', () => {
  const w = new CalibrationWizard(sanitizeSettings({}));
  for (const s of stream(still(1000))) w.push(s);
  w.push({ x: Number.NaN, y: Number.NaN, z: Number.NaN, t: 1001 });
  assert.equal(w.next().ok, true);
  for (const s of stream(tilt(25, { rampMs: 300, holdMs: 1500, backMs: 1 }), { startT: 2000 })) w.push(s);
  w.push({ x: Number.NaN, y: 0, z: 0, t: 4000 });
  assert.equal(w.next().ok, true);
  for (const s of stream(tilt(-27, { rampMs: 300, holdMs: 1500, backMs: 1 }), { startT: 4000 })) w.push(s);
  assert.equal(w.next().ok, true);
  for (const s of stream(shake({ ampDeg: 24, hz: 2, cycles: 3 }), { startT: 6000 })) w.push(s);
  assert.equal(w.next().ok, true);
  const p = w.proposal()!;
  assert.equal(p.pitchAxis, 'x');
  assert.ok(p.neutralPitch !== null && Number.isFinite(p.neutralPitch));
});

function calibrate(base: ReturnType<typeof sanitizeSettings>, hw: ReturnType<typeof sanitizeSettings>) {
  const w = new CalibrationWizard(base);
  const feed = (m: Parameters<typeof stream>[0], startT: number) => { for (const s of stream(m, { settings: hw, startT, seed: 9 })) w.push(s); };
  feed(still(1500), 0);
  w.next();
  feed(tilt(25, { rampMs: 300, holdMs: 1500, backMs: 1 }), 2000);
  w.next();
  feed(tilt(-27, { rampMs: 300, holdMs: 1500, backMs: 1 }), 4000);
  w.next();
  feed(shake({ ampDeg: 24, hz: 2, cycles: 3 }), 6000);
  assert.equal(w.next().ok, true);
  return w.proposal()!;
}

test('a second calibration gives the same scale as the first', () => {
  const hw = sanitizeSettings({ imuScale: 180 / Math.PI }); // the device reports radians
  const first = calibrate(sanitizeSettings({}), hw);
  const second = calibrate(first, hw);
  assert.ok(Math.abs(second.imuScale / first.imuScale - 1) < 0.01, `${first.imuScale} then ${second.imuScale}`);
  assert.ok(Math.abs(second.wrapPeriod / first.wrapPeriod - 1) < 0.01, `${first.wrapPeriod} then ${second.wrapPeriod}`);
  const play = (m: Parameters<typeof stream>[0]) => countGestures(stream(sequence(still(1500), m, still(800)), { settings: hw, seed: 12 }), second);
  assert.ok(play(tilt(-25)).downLines > 0);
  assert.equal(play(still(5000)).tiltStarts, 0);
});

// ---- Bad input ----

test('an IMU report with no axes at all is not a sample', () => {
  assert.equal(toRawSample({}, 9), null);
});

test('values that overflow after scaling cannot poison the angles', () => {
  const a = new ImuAdapter(sanitizeSettings({ imuScale: 1e6 }));
  a.push({ x: 1, y: 1, z: 0, t: 0 });
  assert.equal(a.push({ x: 1e308, y: 1e308, z: 0, t: 20 }), null);
  const s = a.push({ x: 2, y: 2, z: 0, t: 40 })!;
  assert.ok(Number.isFinite(s.pitch) && Number.isFinite(s.yaw));
  assert.equal(a.stats().rejected, 1);
});

test('one absurd sample cannot permanently shift a rate-mode angle', () => {
  const a = new ImuAdapter(sanitizeSettings({ imuMode: 'rate' }));
  a.push({ x: 0, y: 0, z: 0, t: 0 });
  a.push({ x: 0, y: 0, z: 0, t: 20 });
  assert.equal(a.push({ x: 1e7, y: 1e7, z: 0, t: 40 }), null);
  const s = a.push({ x: 0, y: 0, z: 0, t: 60 })!;
  assert.equal(s.pitch, 0);
  assert.equal(s.yaw, 0);
});

test('a stored neutral on the other side of the wrap point still works', () => {
  const s = sanitizeSettings({ neutralPitch: 179 });
  const wrap = (v: number) => ((((v + 180) % 360) + 360) % 360) - 180;
  // The head rests at 181, which the device reports as -179.
  const samples = [...stream(sequence(still(1500), tilt(-24), still(800)))].map((r) => ({ ...r, x: wrap(r.x + 181) }));
  const c = countGestures(samples, s);
  assert.ok(c.downLines > 0, 'tilt still works');
  assert.equal(c.upLines, 0);
});

test('rate mode learns neutral again after a gap, because the head may have moved', () => {
  const s = sanitizeSettings({ imuMode: 'rate' });
  const m = sequence(still(1500), tilt(-24, { holdMs: 1200 }), still(1500), tilt(-24, { holdMs: 1500 }), still(800));
  // The return to neutral falls inside the gap, so integration misses it.
  const samples = [...stream(m, { settings: s })].filter((r) => r.t < 2800 || r.t > 3400);
  const c = countGestures(samples, s);
  assert.equal(c.tiltStarts, 2, 'the second tilt still works');
});

test('drift tracking cannot walk neutral into a held tilt that a user lowered the threshold for', () => {
  const s = sanitizeSettings({ tiltUpDeg: 11, tiltDownDeg: 11, tiltHysteresisDeg: 4, tiltMaxHoldMs: 1000 });
  const e = new GestureEngine(s);
  const a = new ImuAdapter(s);
  const events: GestureEvent[] = [];
  const held = sequence(still(1500), tilt(-10.5, { rampMs: 150, holdMs: 300_000, backMs: 200 }));
  for (const raw of stream(held, { noiseDeg: 0.01 })) {
    const sig = a.push(raw as RawSample);
    if (sig) events.push(...e.push(sig));
  }
  assert.ok(Math.abs(e.status(0).neutral ?? 99) < 1, `neutral moved to ${e.status(0).neutral}`);
});

test('defaults stay valid under the new consistency rules', () => {
  assert.deepEqual(sanitizeSettings(DEFAULT_SETTINGS), { ...DEFAULT_SETTINGS });
});
