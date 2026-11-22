import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MotionWear } from '../src/core/motionWear.ts';
import { sanitizeSettings } from '../src/core/settings.ts';
import { Rig } from './helpers.ts';
import { shake, still } from '../src/core/synth.ts';

const cfg = sanitizeSettings({ trustWearSensor: false, neutralPitch: 0 });

function feed(w: MotionWear, from: number, ms: number, f: (t: number) => { pitch: number; yaw: number }, hz = 10) {
  const changes: string[] = [];
  for (let t = from; t < from + ms; t += 1000 / hz) {
    const c = w.push({ t, dt: 1000 / hz, ...f(t), pitchRate: 0, yawRate: 0, gap: false });
    if (c) changes.push(`${c}@${Math.round(t)}`);
  }
  return changes;
}
// A worn head: slow breathing sway plus small posture shifts.
const head = (t: number) => ({ pitch: 1.5 * Math.sin(t / 1300) + 0.8 * Math.sin(t / 4700), yaw: 2 * Math.sin(t / 2100) });
const noise = (t: number) => 0.15 * Math.sin(t * 7.3) + 0.1 * Math.sin(t * 13.1);

test('a worn head is never taken for removed, even over minutes', () => {
  const w = new MotionWear(cfg);
  assert.deepEqual(feed(w, 0, 300_000, head), []);
});

test('glasses put down at a normal angle count as removed after the still time', () => {
  const w = new MotionWear(cfg);
  feed(w, 0, 5000, head);
  const c = feed(w, 5000, 60_000, (t) => ({ pitch: 3 + noise(t), yaw: 10 + noise(t) }));
  assert.equal(c.length, 1);
  const at = Number(c[0].split('@')[1]);
  assert.ok(c[0].startsWith('removed') && at >= 5000 + cfg.motionWearOffMs && at <= 5000 + cfg.motionWearOffMs + 1500, c[0]);
});

test('folded or lying flat: removed within about 10 s', () => {
  const w = new MotionWear(cfg);
  feed(w, 0, 5000, head);
  const c = feed(w, 5000, 15_000, (t) => ({ pitch: 85 + noise(t), yaw: noise(t) }));
  assert.ok(c[0]?.startsWith('removed'), String(c));
  assert.ok(Number(c[0].split('@')[1]) <= 5000 + 11_000);
});

test('looking down at a desk to read, very still, is not removal', () => {
  const w = new MotionWear(cfg);
  assert.deepEqual(feed(w, 0, 30_000, (t) => ({ pitch: -45 + noise(t), yaw: noise(t) })), []);
});

test('without a calibrated neutral, the table pose is never learned as the head pose', () => {
  const w = new MotionWear(sanitizeSettings({ trustWearSensor: false }));
  feed(w, 0, 3000, (t) => ({ pitch: 80 + noise(t), yaw: noise(t) }));
  assert.deepEqual(feed(w, 3000, 30_000, (t) => ({ pitch: 5 + 0.2 * Math.sin(t / 900), yaw: 0.2 * Math.sin(t / 1100) })), []);
});

test('rate mode judges stillness on rates, so leftover drift does not hide removal', () => {
  const w = new MotionWear(sanitizeSettings({ trustWearSensor: false, imuMode: 'rate' }));
  const c: string[] = [];
  for (let t = 0; t < 60_000; t += 100) {
    const r = w.push({ t, dt: 100, pitch: t * 0.00005, yaw: 0, pitchRate: 0.05, yawRate: 0, gap: false });
    if (r) c.push(r);
  }
  assert.deepEqual(c, ['removed']);
});

test('an unrelated settings change keeps the detected state', () => {
  const w = new MotionWear(cfg);
  feed(w, 0, 15_000, (t) => ({ pitch: 85 + noise(t), yaw: noise(t) }));
  assert.equal(w.state, 'removed');
  w.configure(sanitizeSettings({ ...cfg, scrollLinesPerSec: 4 }));
  assert.equal(w.state, 'removed');
});

test('picking them up again counts as worn', () => {
  const w = new MotionWear(cfg);
  feed(w, 0, 12_000, (t) => ({ pitch: 85 + noise(t), yaw: noise(t) }));
  assert.equal(w.state, 'removed');
  const c = feed(w, 12_000, 3000, (t) => ({ pitch: 85 - (t - 12_000) / 40, yaw: 5 * Math.sin(t / 300) }));
  assert.ok(c[0]?.startsWith('worn'), String(c));
});

test('the app: motion turns the lens off when distrusting the sensor, and a shake brings it back after putting them on', async () => {
  const r = await new Rig().ready();
  await r.a.updateSettings({ trustWearSensor: false, motionWearOffMs: 10_000 });
  r.play(still(1500));
  r.play(shake());
  assert.equal(r.a.state, 'VISIBLE');
  r.play(still(15_000)); // lying on a table (synthetic still has no sway)
  assert.equal(r.a.state, 'REMOVED');
  r.play(shake()); // picked up and put on: motion wakes it, but it stays hidden
  assert.equal(r.a.state, 'HIDDEN');
  r.play(still(2500));
  r.play(shake());
  assert.equal(r.a.state, 'VISIBLE');
});

test('the app: a settings save does not wake glasses lying on a table', async () => {
  const r = await new Rig().ready();
  await r.a.updateSettings({ trustWearSensor: false, motionWearOffMs: 10_000 });
  r.play(still(15_000));
  assert.equal(r.a.state, 'REMOVED');
  await r.a.updateSettings({ scrollLinesPerSec: 4 });
  assert.equal(r.a.state, 'REMOVED');
});

test('the app: time spent recording an example is not counted as lying still', async () => {
  const r = await new Rig().ready();
  await r.a.updateSettings({ trustWearSensor: false, motionWearOffMs: 10_000 });
  r.play(still(9000));
  r.a.startExample('shake');
  r.play(shake()); r.play(shake()); r.play(shake());
  r.a.stopExample();
  r.play(still(300));
  assert.notEqual(r.a.state, 'REMOVED');
});

test('the app: distrusting the sensor still treats a disconnect as unknown and the case as removed', async () => {
  const r = await new Rig().ready();
  await r.a.updateSettings({ trustWearSensor: false });
  r.a.handleConnection(false);
  await r.a.updateSettings({ scrollLinesPerSec: 4 });
  assert.equal(r.a.snapshot().wear, 'unknown');
  r.a.handleConnection(true);
  r.a.handleWear(false, true);
  assert.equal(r.a.snapshot().wear, 'removed');
  r.a.handleWear(false, false);
  assert.equal(r.a.snapshot().wear, 'worn');
});
