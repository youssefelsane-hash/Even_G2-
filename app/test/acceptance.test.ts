// The spec's 12 acceptance tests, as far as they can run without hardware.
// All of them use synthetic motion through the full pipeline: raw samples ->
// adapter -> gesture engine -> state machine -> display plan. A pass proves the
// logic. It does not prove the thresholds, the real IMU or the real host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenario } from '../src/core/scenarios.ts';
import { MemoryStore } from '../src/core/storage.ts';
import { lookSide, nod, sequence, shake, still, talking, tilt, together, walking } from '../src/core/synth.ts';
import { Rig } from './helpers.ts';

const answer = (id = 'q1') => ({
  id,
  short: `Short answer ${id}`,
  details: Array.from({ length: 40 }, (_, i) => `Detail line ${i + 1}`).join('\n'),
});

async function visible(): Promise<Rig> {
  const r = await new Rig().ready();
  r.play(shake());
  assert.equal(r.a.state, 'VISIBLE');
  r.wait(1500);
  r.play(still(800));
  return r;
}

async function withAnswer(): Promise<Rig> {
  const r = await visible();
  r.a.aiResult(answer());
  r.a.handleTouch('press');
  assert.equal(r.a.state, 'VISIBLE');
  return r;
}

test('AT-01 scroll up: tilting up scrolls up and stops at neutral', async () => {
  const r = await withAnswer();
  r.play(tilt(-24, { holdMs: 3000 }));
  r.play(still(800));
  const low = r.a.snapshot().topLine;
  assert.ok(low > 0);
  r.play(tilt(24, { holdMs: 1000 }));
  const after = r.a.snapshot().topLine;
  assert.ok(after < low, `${after} < ${low}`);
  r.play(still(2000));
  assert.equal(r.a.snapshot().topLine, after, 'stopped at neutral');
});

test('AT-02 scroll down: tilting down scrolls down and stops at neutral', async () => {
  const r = await withAnswer();
  r.play(tilt(-24, { holdMs: 2000 }));
  const after = r.a.snapshot().topLine;
  assert.ok(after >= 4, `moved ${after} lines`);
  r.play(still(2000));
  assert.equal(r.a.snapshot().topLine, after);
});

test('AT-03 hide: a shake blanks the lens at once', async () => {
  const r = await withAnswer();
  assert.equal(r.lit(r.a.plan()), true);
  r.play(shake());
  assert.equal(r.a.state, 'HIDDEN');
  assert.deepEqual(r.plans.at(-1), { kind: 'blank' });
});

test('AT-04 show: a shake restores the exact screen and position', async () => {
  const r = await withAnswer();
  r.play(tilt(-24, { holdMs: 2000 }));
  r.play(still(500));
  const line = r.a.snapshot().topLine;
  const screen = r.text();
  assert.ok(line > 0);
  r.play(shake());
  r.wait(1500);
  r.play(still(800));
  r.play(shake());
  assert.equal(r.a.state, 'VISIBLE');
  assert.equal(r.a.snapshot().topLine, line);
  assert.equal(r.text(), screen);
});

test('AT-05 accidental activation: walking, talking and looking sideways do nothing', async () => {
  for (const name of ['walking', 'talking', 'looking-sideways', 'check-both-ways', 'nodding', 'quick-glance', 'small-no']) {
    const r = await withAnswer();
    r.play(scenario(name).motion(21));
    assert.equal(r.a.state, 'VISIBLE', name);
    assert.equal(r.a.snapshot().topLine, 0, name);
  }
});

test('AT-05b hidden state also survives everyday motion', async () => {
  const r = await new Rig().ready();
  r.play(walking(60_000, 8));
  r.play(talking(60_000, 9));
  r.play(sequence(lookSide(), still(500), nod()));
  assert.equal(r.a.state, 'HIDDEN');
  assert.equal(r.plans.filter((p) => r.lit(p)).length, 0);
});

test('AT-06 removal: taking the glasses off hides at once, and motion does nothing', async () => {
  const r = await withAnswer();
  r.a.handleWear(false);
  assert.equal(r.a.state, 'REMOVED');
  assert.deepEqual(r.plans.at(-1), { kind: 'blank' });
  const mark = r.markPlans();
  r.play(shake());
  r.play(tilt(-24));
  assert.equal(r.a.state, 'REMOVED');
  assert.equal(r.plansSince(mark).filter((p) => r.lit(p)).length, 0);
});

test('AT-07 re-wear: stays hidden until a shake, and the settle time ignores the handling motion', async () => {
  const r = await withAnswer();
  r.play(tilt(-24, { holdMs: 1500 }));
  const line = r.a.snapshot().topLine;
  r.a.handleWear(false);
  r.wait(5000);
  r.a.handleWear(true);
  assert.equal(r.a.state, 'HIDDEN');
  r.play(shake()); // putting them on looks like a shake, inside the settle time
  assert.equal(r.a.state, 'HIDDEN');
  r.wait(2000);
  r.play(still(1500));
  r.play(shake());
  assert.equal(r.a.state, 'VISIBLE');
  assert.equal(r.a.snapshot().topLine, line);
});

test('AT-08 camera to AI (fake backend only): working state, short answer first, details by scrolling', async () => {
  const r = await visible();
  r.a.aiStarted();
  assert.equal(r.a.state, 'PROCESSING');
  assert.match(r.text(), /WORKING/);
  r.a.aiResult(answer());
  assert.equal(r.a.state, 'RESULT_READY');
  assert.match(r.text(), /Short answer q1/);
  assert.doesNotMatch(r.text(), /Detail line 30/);
  r.play(tilt(-24, { holdMs: 6000 }));
  assert.equal(r.a.state, 'VISIBLE');
  assert.match(r.text(), /Detail line 1\d/);
});

test('AT-08b AI failure shows an error only when visible, and a press dismisses it', async () => {
  const r = await withAnswer();
  r.a.aiError('Upload failed');
  assert.equal(r.a.state, 'ERROR');
  assert.match(r.text(), /Upload failed/);
  r.a.handleTouch('press');
  assert.equal(r.a.state, 'VISIBLE');
  assert.match(r.text(), /Short answer/);
});

test('AT-09 hidden AI result: stored without any reveal, then shown by a shake', async () => {
  const r = await new Rig().ready();
  const mark = r.markPlans();
  r.a.aiStarted();
  r.a.aiResult(answer('hidden'));
  assert.equal(r.a.state, 'HIDDEN');
  assert.equal(r.a.snapshot().unseen, true);
  assert.equal(r.plansSince(mark).filter((p) => r.lit(p)).length, 0);
  r.play(shake());
  assert.equal(r.a.state, 'RESULT_READY');
  assert.match(r.text(), /Short answer hidden/);
});

test('AT-09b a hidden result survives a restart and still does not reveal', async () => {
  const store = new MemoryStore();
  const r = await new Rig(store).ready();
  r.a.aiResult(answer('kept'));
  await r.a.flush();
  const r2 = await new Rig(store).ready();
  assert.equal(r2.a.state, 'HIDDEN');
  assert.equal(r2.plans.filter((p) => r2.lit(p)).length, 0);
  r2.play(shake());
  assert.equal(r2.a.state, 'RESULT_READY');
  assert.match(r2.text(), /Short answer kept/);
});

test('AT-10 connectivity recovery: a lost link hides, and a reconnect stays hidden until a shake', async () => {
  const r = await withAnswer();
  r.play(tilt(-24, { holdMs: 1500 }));
  const line = r.a.snapshot().topLine;
  r.a.handleConnection(false);
  assert.equal(r.a.state, 'HIDDEN');
  r.wait(10_000);
  r.a.handleConnection(true);
  assert.equal(r.a.state, 'HIDDEN');
  r.a.handleWear(true);
  assert.equal(r.a.state, 'HIDDEN');
  assert.equal(r.lit(r.plans.at(-1)), false);
  r.wait(2000);
  r.play(still(1500));
  r.play(shake());
  assert.equal(r.a.state, 'VISIBLE');
  assert.equal(r.a.snapshot().topLine, line);
});

test('AT-10b a restart while visible comes back hidden, with the position kept', async () => {
  const store = new MemoryStore();
  const r = new Rig(store);
  await r.ready();
  r.play(shake());
  r.a.aiResult(answer());
  r.a.handleTouch('press');
  r.wait(1500);
  r.play(still(800));
  r.play(tilt(-24, { holdMs: 1500 }));
  const line = r.a.snapshot().topLine;
  assert.ok(line > 0);
  await r.a.flush();
  const r2 = await new Rig(store).ready();
  assert.equal(r2.a.state, 'HIDDEN');
  r2.play(shake());
  assert.equal(r2.a.state, 'VISIBLE');
  assert.equal(r2.a.snapshot().topLine, line);
});

test('AT-11 competing gestures: shake wins over tilt', async () => {
  const r = await withAnswer();
  r.play(scenario('tilt-during-shake').motion(1));
  assert.equal(r.a.state, 'HIDDEN');
  assert.equal(r.a.snapshot().topLine, 0, 'no scroll fired during the shake');
  const r2 = await withAnswer();
  r2.play(together(tilt(-24, { holdMs: 3000 }), shake(), 1200));
  assert.equal(r2.a.state, 'HIDDEN');
});

test('AT-12 locked phone (logic only): a cold start in the pocket is blank and hidden', async () => {
  const r = await new Rig().start();
  r.a.handleConnection(true);
  assert.equal(r.a.state, 'HIDDEN');
  assert.equal(r.plans.filter((p) => r.lit(p)).length, 0);
  assert.equal(r.a.plan().kind, 'blank');
});

test('recovery: four presses reveal when the IMU has failed', async () => {
  const r = await new Rig().ready();
  r.wait(10_000);
  await r.a.tick();
  assert.equal(r.a.snapshot().sensorStale, true);
  for (let i = 0; i < 3; i++) { r.a.handleTouch('press'); r.wait(300); }
  assert.equal(r.a.state, 'HIDDEN');
  r.a.handleTouch('press');
  assert.equal(r.a.state, 'VISIBLE');
  assert.match(r.text(), /sensor lost/);
});

test('an IMU that never delivers a sample is reported as lost', async () => {
  const r = await new Rig().start();
  r.a.handleConnection(true);
  r.wait(r.a.settings.sensorStaleMs + 1);
  await r.a.tick();
  assert.equal(r.a.snapshot().sensorStale, true);
});

test('recovery: two double presses count, and one or two presses do not', async () => {
  const r = await new Rig().ready();
  r.a.handleTouch('press');
  r.wait(100);
  r.a.handleTouch('press');
  r.wait(5000);
  r.a.handleTouch('press');
  assert.equal(r.a.state, 'HIDDEN', 'presses outside the window do not add up');
  r.wait(5000);
  r.a.handleTouch('double');
  r.a.handleTouch('double');
  assert.equal(r.a.state, 'VISIBLE');
  assert.equal(r.exits, 0, 'recovery must not open the exit dialog');
});

test('recovery works with unknown wear, so a silent wear sensor cannot trap the app', async () => {
  const r = await new Rig().start();
  r.a.handleConnection(true);
  for (let i = 0; i < 4; i++) r.a.handleTouch('press');
  assert.equal(r.a.state, 'VISIBLE');
});

test('recovery cannot fire while removed, and earlier presses do not carry over', async () => {
  const r = await new Rig().ready();
  r.a.handleTouch('press');
  r.a.handleTouch('press');
  r.a.handleWear(false);
  for (let i = 0; i < 6; i++) r.a.handleTouch('press');
  assert.equal(r.a.state, 'REMOVED');
});

test('presses made before a removal do not count after re-wear', async () => {
  const r = await new Rig().ready();
  r.a.handleTouch('press');
  r.a.handleTouch('press');
  r.a.handleWear(false);
  r.a.handleWear(true);
  r.wait(r.a.settings.wearSettleMs + 1);
  r.a.handleTouch('press');
  r.a.handleTouch('press');
  assert.equal(r.a.state, 'HIDDEN');
});

test('presses during the settle time are ignored', async () => {
  const r = await new Rig().start();
  r.a.handleConnection(true);
  r.a.handleWear(true);
  for (let i = 0; i < 6; i++) r.a.handleTouch('press');
  assert.equal(r.a.state, 'HIDDEN');
});

test('a wear sensor stuck on removed is escaped only by a deliberate phone setting', async () => {
  const r = await new Rig().start();
  r.a.handleConnection(true);
  r.a.handleWear(false);
  assert.equal(r.a.state, 'REMOVED');
  await r.a.updateSettings({ trustWearSensor: false });
  assert.equal(r.a.state, 'HIDDEN');
  r.wait(2000);
  r.play(still(1500));
  r.play(shake());
  assert.equal(r.a.state, 'VISIBLE');
});

test('gestures do nothing until wear is known', async () => {
  const r = await new Rig().start();
  r.a.handleConnection(true);
  r.play(still(1500));
  r.play(shake());
  assert.equal(r.a.state, 'HIDDEN');
  assert.equal(r.a.snapshot().shakes, 0);
});

test('touch scrolling still works after recovery with no wear data', async () => {
  const r = await new Rig().start();
  r.a.aiResult(answer());
  for (let i = 0; i < 4; i++) r.a.handleTouch('press');
  r.a.handleTouch('swipeDown');
  assert.ok(r.a.snapshot().topLine > 0);
});

test('a double press while visible asks for the exit dialog', async () => {
  const r = await withAnswer();
  r.a.handleTouch('double');
  assert.equal(r.exits, 1);
});

test('the phone snapshot never carries answer text', async () => {
  const r = await withAnswer();
  assert.doesNotMatch(JSON.stringify(r.a.snapshot()), /Short answer|Detail line/);
});

test('no gesture fires during calibration, and a cancel changes no setting', async () => {
  const r = await withAnswer();
  const before = JSON.stringify(r.a.settings);
  r.a.startCalibration();
  r.play(shake());
  r.play(tilt(-24));
  assert.equal(r.a.state, 'VISIBLE');
  assert.equal(r.a.snapshot().topLine, 0);
  await r.a.finishCalibration(false);
  assert.equal(JSON.stringify(r.a.settings), before);
});

test('the raw logger records state changes and wear next to the samples', async () => {
  const r = await new Rig().start();
  r.a.logger.start();
  r.a.handleConnection(true);
  r.a.handleWear(true);
  r.wait(2000);
  r.play(still(1500));
  r.play(shake());
  const csv = r.a.logger.toCsv();
  assert.match(csv, /wear true/);
  assert.match(csv, /gesture shake/);
  assert.match(csv, /HIDDEN -> VISIBLE/);
  assert.ok(r.a.logger.summary().samples > 50);
});

test('every screen fits the display limits', async () => {
  const r = await visible();
  r.a.aiResult({ id: 'big', short: 'x'.repeat(3000), details: 'y '.repeat(3000) });
  for (let i = 0; i < 10; i++) {
    const t = r.text();
    assert.ok(t.length <= 1000);
    assert.ok(t.split('\n').length <= 10);
    r.a.handleTouch('swipeDown');
  }
});
