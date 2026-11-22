import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WearCheck, type WearReport } from '../src/core/wearCheck.ts';
import { wearCheckText } from '../src/panel.ts';

const worn: WearReport = { connected: true, wearing: true, inCase: false };
const removed: WearReport = { ...worn, wearing: false };

test('six outside-case removal and re-wear reports complete the sensor check', () => {
  const check = new WearCheck();
  check.start(0);
  check.observe(removed, 10);
  assert.equal(check.snapshot(10).phase, 'baseline', 'the check first needs a worn report');
  check.observe(worn, 20);
  for (let cycle = 1; cycle <= 6; cycle++) {
    const time = cycle * 1000;
    assert.equal(check.snapshot(time).phase, 'remove');
    check.observe(removed, time);
    assert.equal(check.snapshot(time).phase, 'wear');
    check.observe(removed, time + 10);
    assert.equal(check.snapshot(time).completed, cycle - 1);
    check.observe(worn, time + 20);
    assert.equal(check.snapshot(time).completed, cycle);
  }
  assert.equal(check.active, false);
  assert.equal(check.snapshot(7000).phase, 'complete');
  assert.match(wearCheckText(check.snapshot(7000)), /6\/6 cycles/);
});

test('folding or case reports fail the test and cannot count as off-head removal', () => {
  const check = new WearCheck();
  check.start(0);
  check.observe(worn, 1);
  check.observe({ ...removed, inCase: true }, 100);
  check.observe(worn, 200);
  assert.equal(check.snapshot(200).phase, 'failed');
  assert.equal(check.snapshot(200).failure, 'case-reported');
  assert.equal(check.snapshot(200).completed, 0);
  assert.match(wearCheckText(check.snapshot(200)), /both arms open/);
});

test('a stream of unchanged worn reports cannot pass or prolong the removal deadline', () => {
  const check = new WearCheck();
  check.start(0);
  check.observe(worn, 1);
  for (let t = 1000; t <= 16_000; t += 1000) check.observe(worn, t);
  assert.equal(check.snapshot(16_000).phase, 'failed');
  assert.equal(check.snapshot(16_000).failure, 'no-removal-report');
  assert.equal(check.snapshot(16_000).completed, 0);
  assert.match(wearCheckText(check.snapshot(16_000)), /Wear Detection/);
});

test('an incomplete report cannot be accepted as removal or a completed wear cycle', () => {
  const check = new WearCheck();
  check.start(0);
  check.observe(worn, 1);
  check.observe({ ...removed, inCase: undefined }, 10);
  check.observe({ ...removed, wearing: undefined }, 20);
  assert.equal(check.snapshot(20).phase, 'remove');
  check.tick(16_000);
  assert.equal(check.snapshot(16_000).failure, 'no-removal-report');
});

test('a missing wear report times out and a late response cannot revive the test', () => {
  const check = new WearCheck();
  check.start(0);
  check.observe(worn, 1);
  check.observe(removed, 100);
  check.observe(worn, 30_100);
  assert.equal(check.snapshot(30_100).failure, 'no-wear-report');
  assert.equal(check.snapshot(30_100).completed, 0);
});

for (const reason of ['disconnected', 'backgrounded'] as const) {
  test(`${reason} cannot complete an interrupted sensor check`, () => {
    const check = new WearCheck();
    check.start(0);
    check.observe(worn, 1);
    check.observe(removed, 2);
    if (reason === 'disconnected') check.observe({ ...worn, connected: false }, 3);
    else check.fail(reason);
    check.observe(worn, 4);
    assert.equal(check.snapshot(4).phase, 'failed');
    assert.equal(check.snapshot(4).failure, reason);
    check.start(5);
    assert.equal(check.snapshot(5).completed, 0);
    assert.equal(check.snapshot(5).failure, null);
    check.cancel();
    assert.equal(check.snapshot(6).phase, 'idle');
  });
}
