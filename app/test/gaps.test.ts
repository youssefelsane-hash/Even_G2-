// Behaviour that a mutation sweep showed no test was holding in place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CalibrationWizard } from '../src/core/calibration.ts';
import { ImuAdapter } from '../src/core/imuAdapter.ts';
import { countGestures } from '../src/core/scenarios.ts';
import { sanitizeSettings } from '../src/core/settings.ts';
import { ShakeDetector } from '../src/core/shakeDetector.ts';
import { nod, sequence, shake, still, stream, tilt, together, type Motion } from '../src/core/synth.ts';
import { Rig } from './helpers.ts';

const base = sanitizeSettings({});
const answer = { id: 'q', short: 'Short', details: Array.from({ length: 40 }, (_, i) => `Line ${i}`).join('\n') };

/** Straight lines between yaw turning points, sampled every 20 ms. Returns the number of fires. */
function swings(path: [number, number][], s = base): number {
  const d = new ShakeDetector(s);
  let fired = 0;
  let t = 0;
  let from = 0;
  for (const [to, ms] of path) {
    const n = Math.max(1, Math.round(ms / 20));
    for (let k = 1; k <= n; k++) {
      t += ms / n;
      if (d.push(t, from + ((to - from) * k) / n, 0)) fired++;
    }
    from = to;
  }
  return fired;
}

/** Holds near a turning point with sensor wobble, always just short of the extreme. */
function wobble(at: number, inward: number, ms: number): [number, number][] {
  const out: [number, number][] = [];
  for (let t = 0; t < ms; t += 40) out.push([at + inward * (t % 80 === 0 ? 1 : 0.5), 20], [at + inward * 0.5, 20]);
  return out;
}

test('the swing helper does detect a plain shake, so the rejections below mean something', () => {
  assert.equal(swings([[30, 200], [-30, 300], [30, 300]]), 1);
});

test('a pause at a turning point breaks the chain', () => {
  const pause = wobble(30, -1, 400);
  assert.equal(swings([[30, 200], ...pause, [-30, 300], [30, 300]]), 0, 'pause after the first swing');
});

test('a pause before the last swing also breaks the chain', () => {
  const pause = wobble(-30, 1, 400);
  assert.equal(swings([[30, 200], [-30, 300], ...pause, [30, 300]]), 0);
});

test('a final swing much smaller than the one before does not complete a shake', () => {
  // 90 then 27: past the minimum swing, but more than three times smaller.
  assert.equal(swings([[45, 200], [-45, 320], [-18, 100], [-24, 100]]), 0);
});

test('swings that are too quick to be a head are not a shake', () => {
  assert.equal(swings([[0, 100], [30, 40], [-30, 40], [30, 40]]), 0);
  assert.equal(swings([[0, 100], [30, 40], [-30, 40], [30, 40]], sanitizeSettings({ shakeMinSwingMs: 0 })), 1, 'it is the time limit that rejects them');
});

test('swings of a good size that are too slow are not a shake', () => {
  const s = sanitizeSettings({ shakeMinRateDps: 100 });
  assert.equal(swings([[30, 340], [0, 340], [30, 340]], s), 0); // 88 degrees per second each
  assert.equal(swings([[30, 200], [-30, 300], [30, 300]], s), 1);
});

test('a tilt that sags below its band before the minimum time does not start', () => {
  // Reaches 22, then sags to 12 (below 18 - 4), then returns to 22 inside the same candidate.
  const m: Motion = {
    durMs: 1500,
    pose: (t) => ({ yaw: 0, pitch: -(t < 100 ? 22 * (t / 100) : t < 250 ? 22 : t < 350 ? 12 : 22) }),
  };
  assert.equal(countGestures(stream(sequence(still(1500), m, still(800))), base).tiltStarts, 0);
});

test('a new tilt inside the tilt cooldown is ignored', () => {
  const s = sanitizeSettings({ tiltCooldownMs: 1000 });
  const m = () => sequence(still(1500), tilt(-24, { holdMs: 800, backMs: 120 }), still(60), tilt(-24, { holdMs: 800 }), still(800));
  assert.equal(countGestures(stream(m()), s).tiltStarts, 1);
  assert.equal(countGestures(stream(m()), sanitizeSettings({ tiltCooldownMs: 0 })).tiltStarts, 2);
});

test('a tilt right after a shake is ignored until the shake cooldown ends', () => {
  const m = sequence(still(1500), shake(), still(100), tilt(-24, { holdMs: 1000 }), still(800));
  const c = countGestures(stream(m), base);
  assert.equal(c.shakes, 1);
  assert.equal(c.tiltStarts, 0);
});

test('neutral is not learned from a head that keeps moving', () => {
  const m = sequence(nod({ ampDeg: 12, hz: 1, cycles: 6 }), still(300));
  const c = countGestures(stream(m), base, true);
  assert.equal(c.events.filter((e) => e.type === 'neutral').length, 0);
});

test('the first line moves as soon as a tilt is accepted', () => {
  const c = countGestures(stream(sequence(still(1500), tilt(-24, { rampMs: 200, holdMs: 400 }), still(800))), base);
  assert.equal(c.tiltStarts, 1);
  assert.ok(c.downLines >= 1);
});

test('scrolling pauses during a shake, and at most one line slips out at its very start', () => {
  const shakeStart = 1500 + 1200;
  const m = sequence(still(1500), together(tilt(-24, { holdMs: 3000 }), shake(), 1200), still(800));
  const c = countGestures(stream(m), base, true);
  const fire = c.events.find((e) => e.type === 'shake')!;
  const during = c.events.filter((e) => e.type === 'scroll' && e.t >= shakeStart);
  assert.ok(during.length <= 1, `${during.length} scrolls after the shake began`);
  assert.ok(during.every((e) => e.t < shakeStart + 100), 'none once the yaw is clearly moving');
  assert.ok(fire.t > shakeStart);
});

test('the measured sample rate restarts after a gap', () => {
  const a = new ImuAdapter(base);
  for (let i = 0; i < 40; i++) a.push({ x: 0, y: 0, z: 0, t: i * 20 });
  for (let i = 0; i < 10; i++) a.push({ x: 0, y: 0, z: 0, t: 60_000 + i * 20 });
  assert.ok(Math.abs(a.stats().hz! - 50) < 1, `${a.stats().hz} Hz`);
});

test('re-wearing learns a new neutral, because the glasses may sit differently', async () => {
  const r = await new Rig().ready();
  r.play(shake());
  r.a.aiResult(answer);
  r.a.handleTouch('press');
  r.a.handleWear(false);
  r.a.handleWear(true);
  r.wait(r.a.settings.wearSettleMs + 1);
  const offset = (m: Motion) => [...stream(m, { settings: r.a.settings })].map((s) => ({ ...s, x: s.x + 12 }));
  r.feed(offset(still(1500)));
  r.play(still(0));
  for (let i = 0; i < 4; i++) r.a.handleTouch('press');
  assert.equal(r.a.state, 'VISIBLE');
  r.wait(600);
  r.feed(offset(sequence(still(300), tilt(-24, { holdMs: 1500 }), still(300))));
  assert.ok(r.a.snapshot().topLine > 0, 'the tilt is measured from the new neutral');
});

test('a reconnect and a return to the foreground force a redraw, because the page may be gone', async () => {
  const r = await new Rig().start();
  r.a.handleConnection(true);
  assert.equal(r.forced.at(-1), true, 'reconnect');
  r.a.handleForeground();
  assert.equal(r.forced.at(-1), true, 'foreground');
  r.a.handleConnection(false);
  assert.equal(r.forced.at(-1), false, 'nothing to redraw on a disconnect');
});

test('an old wear report does not come back after a disconnect', async () => {
  const r = await new Rig().ready();
  r.a.handleConnection(false);
  await r.a.updateSettings({ scrollLinesPerSec: 4 });
  assert.equal(r.a.snapshot().wear, 'unknown');
});

test('an error screen stays until pressed: scrolling does not clear it or move the text', async () => {
  const r = await new Rig().ready();
  r.play(shake());
  r.a.aiResult(answer);
  r.a.handleTouch('press');
  r.a.aiError('Upload failed');
  r.a.handleTouch('swipeDown');
  assert.equal(r.a.state, 'ERROR');
  assert.equal(r.a.snapshot().topLine, 0);
});

test('the wizard measures gyro bias from the neutral step', () => {
  const hw = sanitizeSettings({ imuMode: 'rate', pitchAxis: 'y', yawAxis: 'z' });
  const w = new CalibrationWizard(sanitizeSettings({}));
  const feed = (m: Motion, startT: number) => { for (const s of stream(m, { settings: hw, startT, seed: 9, rateBias: 2 })) w.push(s); };
  feed(still(1500), 0);
  w.next();
  feed(tilt(25, { rampMs: 300, holdMs: 1500, backMs: 1 }), 2000);
  w.next();
  feed(tilt(-27, { rampMs: 300, holdMs: 1500, backMs: 1 }), 4000);
  w.next();
  feed(shake({ ampDeg: 24, hz: 2, cycles: 3 }), 6000);
  assert.equal(w.next().ok, true);
  const p = w.proposal()!;
  assert.ok(Math.abs(p.rateBiasPitch / (2 * p.imuScale) - 1) < 0.2, `pitch bias ${p.rateBiasPitch}, scale ${p.imuScale}`);
  assert.ok(Math.abs(p.rateBiasYaw / (2 * p.imuScale) - 1) < 0.2, `yaw bias ${p.rateBiasYaw}`);
});
