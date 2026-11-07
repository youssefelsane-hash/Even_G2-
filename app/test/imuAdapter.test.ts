import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ImuAdapter, toRawSample, type ImuSignal, type RawSample } from '../src/core/imuAdapter.ts';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/core/settings.ts';

const cfg = (patch = {}) => sanitizeSettings({ ...DEFAULT_SETTINGS, ...patch });
const raw = (t: number, x = 0, y = 0, z = 0): RawSample => ({ x, y, z, t });

function feed(a: ImuAdapter, samples: RawSample[]): ImuSignal[] {
  return samples.map((s) => a.push(s)).filter((s): s is ImuSignal => s !== null);
}

test('axis, sign and scale are configuration', () => {
  const a = new ImuAdapter(cfg({ pitchAxis: 'z', yawAxis: 'x', pitchSign: -1, yawSign: 1, imuScale: 2 }));
  const s = a.push(raw(0, 3, 0, 5))!;
  assert.equal(s.pitch, -10);
  assert.equal(s.yaw, 6);
});

test('orientation mode derives rate from the angle change', () => {
  const a = new ImuAdapter(cfg());
  const [, b] = feed(a, [raw(0, 0), raw(20, 2)]);
  assert.equal(b.pitch, 2);
  assert.equal(b.pitchRate, 100);
});

test('rate mode integrates, and subtracts the configured bias', () => {
  const a = new ImuAdapter(cfg({ imuMode: 'rate', rateBiasPitch: 1 }));
  const out = feed(a, [raw(0, 11), raw(100, 11), raw(200, 11)]);
  assert.equal(out[2].pitchRate, 10);
  assert.ok(Math.abs(out[2].pitch - 2) < 1e-9);
});

test('orientation angles unwrap across the wrap point', () => {
  const a = new ImuAdapter(cfg());
  const out = feed(a, [raw(0, 0, 359), raw(20, 0, 1)]);
  assert.equal(out[1].yaw - out[0].yaw, 2);
});

test('a time gap is flagged, gives zero rates and resets nothing else', () => {
  const a = new ImuAdapter(cfg());
  const out = feed(a, [raw(0, 1), raw(20, 1), raw(2000, 30)]);
  assert.equal(out[2].gap, true);
  assert.equal(out[2].pitchRate, 0);
  assert.equal(out[2].pitch, 30);
  assert.equal(a.stats().gaps, 1);
});

test('rate mode does not integrate across a gap', () => {
  const a = new ImuAdapter(cfg({ imuMode: 'rate' }));
  const out = feed(a, [raw(0, 10), raw(100, 10), raw(5000, 10)]);
  assert.ok(Math.abs(out[2].pitch - out[1].pitch) < 1e-9);
});

test('non-finite values are rejected and counted', () => {
  const a = new ImuAdapter(cfg());
  assert.equal(a.push(raw(0, NaN)), null);
  assert.equal(a.push({ x: 1, y: 1, z: Infinity, t: 1 }), null);
  assert.equal(a.stats().rejected, 2);
});

test('a batch with one arrival time keeps time moving forward at the real rate', () => {
  const a = new ImuAdapter(cfg());
  const samples: RawSample[] = [];
  for (let b = 0; b < 40; b++) for (let i = 0; i < 4; i++) samples.push(raw(b * 80, b * 4 + i));
  const out = feed(a, samples);
  for (let i = 1; i < out.length; i++) assert.ok(out[i].t > out[i - 1].t, `time must increase at ${i}`);
  const hz = a.stats().hz!;
  assert.ok(hz > 40 && hz < 60, `estimated ${hz} Hz for a real 50 Hz`);
  const rates = out.slice(40).map((s) => s.pitchRate);
  assert.ok(Math.max(...rates) < 400, 'rates stay near the true 50/s, not divided by zero');
  assert.ok(a.stats().batched > 100);
});

test('a clock stepping backwards cannot produce negative time', () => {
  const a = new ImuAdapter(cfg());
  const out = feed(a, [raw(100, 1), raw(120, 2), raw(90, 3), raw(140, 4)]);
  for (let i = 1; i < out.length; i++) assert.ok(out[i].t > out[i - 1].t);
});

test('sample rate is measured, not assumed', () => {
  const a = new ImuAdapter(cfg());
  for (let i = 0; i < 40; i++) a.push(raw(i * 40));
  assert.ok(Math.abs(a.stats().hz! - 25) < 0.01);
});

test('a missing axis means zero, a missing report means no sample', () => {
  assert.deepEqual(toRawSample({ x: 1.5 }, 9), { x: 1.5, y: 0, z: 0, t: 9 });
  assert.equal(toRawSample(undefined, 9), null);
});
