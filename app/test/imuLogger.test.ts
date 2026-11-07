import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ImuLogger } from '../src/core/imuLogger.ts';

const s = (t: number, x = 1) => ({ x, y: 2, z: 3, t });

test('nothing is recorded until started', () => {
  const l = new ImuLogger();
  l.push(s(0));
  l.note(0, 'x');
  assert.equal(l.length, 0);
});

test('values are recorded unchanged and exported as CSV with notes', () => {
  const l = new ImuLogger();
  l.start();
  l.push(s(10, 0.125));
  l.note(15, 'mark "tilt, up"');
  l.push(s(20, -4));
  l.stop();
  l.push(s(30));
  assert.equal(l.toCsv(), 't_ms,x,y,z,note\n10,0.125,2,3,\n15,,,,"mark ""tilt, up"""\n20,-4,2,3,\n');
});

test('the CSV can be limited to the newest rows', () => {
  const l = new ImuLogger();
  l.start();
  for (let i = 0; i < 5; i++) l.push(s(i));
  assert.equal(l.toCsv(2).trim().split('\n').length, 3);
});

test('the summary reports real rate, spread, gaps and axis ranges', () => {
  const l = new ImuLogger();
  l.start();
  for (let i = 0; i < 100; i++) l.push(s(i * 20, i));
  for (let i = 0; i < 100; i++) l.push(s(10_000 + i * 20, -i));
  const m = l.summary();
  assert.equal(m.samples, 200);
  assert.equal(m.dtP50, 20);
  assert.equal(m.gapsOver1s, 1, 'a suspension shows up as a gap');
  assert.ok((m.dtMax ?? 0) > 7000);
  assert.equal(m.x?.max, 99);
  assert.equal(m.x?.min, -99);
});

test('the JSON export parses and holds the summary and rows', () => {
  const l = new ImuLogger();
  l.start();
  l.push(s(1));
  const j = JSON.parse(l.toJson());
  assert.equal(j.rows.length, 1);
  assert.equal(j.summary.samples, 1);
});

test('memory is bounded: the oldest rows go first and are counted', () => {
  const l = new ImuLogger(100);
  l.start();
  for (let i = 0; i < 250; i++) l.push(s(i));
  assert.ok(l.length <= 100);
  assert.ok(l.summary().discarded >= 150);
  assert.match(l.toCsv(), /\n249,/);
});
