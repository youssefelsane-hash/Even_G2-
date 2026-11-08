import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActivityMonitor } from '../src/core/activity.ts';
import { GestureEngine } from '../src/core/gestureEngine.ts';
import { ImuAdapter } from '../src/core/imuAdapter.ts';
import { LEGACY_SETTINGS } from '../src/core/population.ts';
import { countGestures } from '../src/core/scenarios.ts';
import { DEFAULT_SETTINGS, sanitizeSettings, type Settings } from '../src/core/settings.ts';
import { lookSide, sequence, shake, still, stream, talking, tilt, together, walking, type Motion } from '../src/core/synth.ts';
import { Rig } from './helpers.ts';

const base = sanitizeSettings(DEFAULT_SETTINGS);
const settle = (...m: Motion[]) => sequence(still(1500), ...m, still(800));

function glancePair(deg: number, turnMs: number, holdMs: number): Motion {
  return settle(lookSide({ deg: -deg, turnMs, holdMs, backMs: turnMs }), lookSide({ deg, turnMs, holdMs, backMs: turnMs }));
}

// ---- Quick-glance rejection (the known weakness of V0.3) ----

test('left-right looks resting 100 ms or more at each side no longer fire a shake', () => {
  let legacy = 0;
  let now = 0;
  let cases = 0;
  for (const hold of [100, 150, 200, 300]) {
    for (const deg of [25, 35, 45]) {
      for (const turn of [150, 200, 300, 400]) {
        cases++;
        const samples = [...stream(glancePair(deg, turn, hold), { hz: 50, seed: deg + turn })];
        legacy += countGestures(samples, LEGACY_SETTINGS).shakes > 0 ? 1 : 0;
        now += countGestures(samples, base).shakes > 0 ? 1 : 0;
      }
    }
  }
  assert.equal(now, 0, `${now} of ${cases} glance pairs fired`);
  assert.ok(legacy > 0, 'the legacy settings did fire on some of them, so the test can see the difference');
});

test('quick-glance rejection holds at 25 Hz too', () => {
  for (const hold of [120, 200]) {
    for (const turn of [150, 250]) {
      assert.equal(countGestures(stream(glancePair(35, turn, hold), { hz: 25, seed: turn }), base).shakes, 0, `hold ${hold} turn ${turn}`);
    }
  }
});

test('a real shake still fires at every sample rate down to 10 Hz, at slow and fast speeds', () => {
  for (const hz of [100, 50, 25, 15, 10]) {
    for (const f of [1.6, 2, 3]) {
      const c = countGestures(stream(settle(shake({ ampDeg: 22, hz: f, cycles: 2 })), { hz, seed: Math.round(f * 10) }), base);
      assert.equal(c.shakes, 1, `${hz} Hz sampling, ${f} Hz shake`);
    }
  }
});

test('the reason a glance was refused is reported', () => {
  const adapter = new ImuAdapter(base);
  const engine = new GestureEngine(base);
  let reject = 'none';
  for (const raw of stream(glancePair(35, 150, 100), { seed: 3 })) {
    const s = adapter.push(raw);
    if (!s) continue;
    engine.push(s);
    const r = engine.status(s.t).shakeReject;
    if (r !== 'none') reject = r;
  }
  assert.equal(reject, 'plateau');
});

// ---- Confidence ----

function shakeConfidence(m: Motion, s: Settings = base): number[] {
  const adapter = new ImuAdapter(s);
  const engine = new GestureEngine(s);
  const out: number[] = [];
  for (const raw of stream(m, { seed: 9 })) {
    const sig = adapter.push(raw);
    if (!sig) continue;
    for (const e of engine.push(sig)) if (e.type === 'shake') out.push(e.confidence);
  }
  return out;
}

test('confidence is between 0 and 1, and a wide fast shake scores higher than a borderline one', () => {
  const [wide] = shakeConfidence(settle(shake({ ampDeg: 30, hz: 2.2, cycles: 2 })));
  const [weak] = shakeConfidence(settle(shake({ ampDeg: 14, hz: 1.7, cycles: 2 })));
  assert.ok(wide >= 0 && wide <= 1 && weak >= 0 && weak <= 1);
  assert.ok(wide > weak, `wide ${wide} weak ${weak}`);
});

test('tilt start events carry a confidence too', () => {
  const adapter = new ImuAdapter(base);
  const engine = new GestureEngine(base);
  const conf: number[] = [];
  for (const raw of stream(settle(tilt(-26)), { seed: 2 })) {
    const s = adapter.push(raw);
    if (!s) continue;
    for (const e of engine.push(s)) if (e.type === 'tiltStart') conf.push(e.confidence);
  }
  assert.equal(conf.length, 1);
  assert.ok(conf[0] > 0 && conf[0] <= 1);
});

// ---- Activity awareness ----

function levelAfter(m: Motion, s: Settings = base) {
  const adapter = new ImuAdapter(s);
  const engine = new GestureEngine(s);
  let last = engine.activityLevel(0);
  for (const raw of stream(m, { seed: 4 })) {
    const sig = adapter.push(raw);
    if (!sig) continue;
    engine.push(sig);
    last = engine.activityLevel(sig.t);
  }
  return last;
}

test('standing still applies no boost; busy talking raises the shake limit', () => {
  const quiet = levelAfter(still(20_000));
  assert.equal(quiet.shakeBoost, 1);
  assert.equal(quiet.label, 'still');
  const busy = levelAfter(talking(30_000, 3, 2.5));
  assert.ok(busy.shakeBoost > 1.2, `boost ${busy.shakeBoost}`);
  assert.notEqual(busy.label, 'still');
  assert.equal(levelAfter(talking(30_000, 3, 2.5), { ...base, activityAware: false }).shakeBoost, 1, 'the setting turns it off');
});

test('a recognised shake does not make the next shake harder', () => {
  const m = settle(shake({ ampDeg: 24 }), still(2500), shake({ ampDeg: 24 }), still(4000));
  const lv = levelAfter(m);
  assert.equal(lv.shakeBoost, 1, 'the first shake was left out of the background measurement');
  assert.equal(countGestures(stream(m), base).shakes, 2);
});

test('activity monitor: buckets inside a gesture are left out, and too little data gives no boost', () => {
  const mon = new ActivityMonitor({ ...base });
  for (let t = 0; t < 1500; t += 20) mon.push(t, 10 * Math.sin(t / 50), 0);
  assert.equal(mon.level(1500).buckets, 0);
  for (let t = 1500; t < 12_000; t += 20) mon.push(t, 10 * Math.sin(t / 50), 0);
  assert.ok(mon.level(12_000).shakeBoost > 1);
  mon.exclude(0, 12_000);
  assert.equal(mon.level(12_001).shakeBoost, 1);
});

test('talking at twice the modelled intensity: far fewer false shakes than the legacy settings', () => {
  let legacy = 0;
  let now = 0;
  for (const seed of [11, 22]) {
    const samples = [...stream(talking(30 * 60_000, seed, 2), { hz: 50, jitterMs: 8, dropRate: 0.02, seed })];
    legacy += countGestures(samples, LEGACY_SETTINGS).shakes;
    now += countGestures(samples, base).shakes;
  }
  assert.ok(legacy >= 20, `legacy ${legacy}`);
  assert.ok(now * 4 <= legacy, `now ${now}, legacy ${legacy}`);
});

test('a firm shake while walking still works', () => {
  let ok = 0;
  for (let i = 0; i < 20; i++) {
    const m = together(walking(9000, i + 1), sequence(still(4000), shake({ ampDeg: 26, hz: 2.2, cycles: 2 }), still(2000)));
    if (countGestures(stream(m, { hz: 50, jitterMs: 8, seed: i + 1 }), base).shakes >= 1) ok++;
  }
  assert.ok(ok >= 18, `${ok}/20`);
});

// ---- Tilt can be switched off ----

test('with tilt switched off nothing scrolls, whatever the head does', async () => {
  const r = await new Rig().ready();
  await r.a.updateSettings({ tiltEnabled: false });
  r.play(shake());
  r.a.aiResult({ id: 'x', short: 'Short', details: Array.from({ length: 40 }, (_, i) => `Line ${i}`).join('\n') });
  for (const m of [tilt(-26), tilt(24), tilt(-30, { rampMs: 120, holdMs: 4000 }), walking(20_000, 3)]) r.play(m);
  assert.equal(r.a.snapshot().topLine, 0);
  assert.equal(r.a.state, 'RESULT_READY');
});

// ---- Undo hide ----

async function shown(): Promise<Rig> {
  const r = await new Rig().ready();
  r.play(shake());
  r.a.aiResult({ id: 'u', short: 'Undo me', details: 'Some details.' });
  r.a.handleTouch('press');
  assert.equal(r.a.state, 'VISIBLE');
  r.play(still(1500)); // past the shake cooldown
  return r;
}

test('undo hide: a double press soon after an accidental hide brings back the same screen', async () => {
  const r = await shown();
  const before = r.text();
  r.play(shake());
  assert.equal(r.a.state, 'HIDDEN');
  assert.ok(r.a.snapshot().undoAvailable);
  r.wait(500);
  r.a.handleTouch('double');
  assert.equal(r.a.state, 'VISIBLE');
  assert.equal(r.text(), before);
});

test('undo hide cannot leak: too late, after removal, after reconnect, after a new answer, after a restart', async () => {
  const late = await shown();
  late.play(shake());
  late.wait(late.a.settings.undoHideMs + 50);
  late.a.handleTouch('double');
  assert.equal(late.a.state, 'HIDDEN', 'too late');

  const removed = await shown();
  removed.play(shake());
  removed.a.handleWear(false);
  removed.a.handleWear(true);
  removed.wait(1600);
  removed.a.handleTouch('double');
  assert.equal(removed.a.state, 'HIDDEN', 'after removal and re-wear');

  const recon = await shown();
  recon.play(shake());
  recon.a.handleConnection(false);
  recon.a.handleConnection(true);
  recon.a.handleWear(true);
  recon.wait(1600);
  recon.a.handleTouch('double');
  assert.equal(recon.a.state, 'HIDDEN', 'after a reconnect');

  const fresh = await shown();
  fresh.play(shake());
  fresh.a.aiResult({ id: 'new', short: 'Never shown', details: '' });
  fresh.a.handleTouch('double');
  assert.equal(fresh.a.state, 'HIDDEN', 'a new answer arrived, so the screen would not be the one hidden');

  const store = (await shown()).store;
  const restarted = await new Rig(store).ready();
  restarted.a.handleTouch('double');
  assert.equal(restarted.a.state, 'HIDDEN', 'nothing to undo after a restart');
});

test('undo hide needs a double press: single presses only count towards the slow recovery pattern', async () => {
  const r = await shown();
  r.play(shake());
  r.a.handleTouch('press');
  assert.equal(r.a.state, 'HIDDEN');
});

test('undo hide never applies to a hide by wear removal or connection loss', async () => {
  const r = await shown();
  r.a.handleConnection(false);
  r.a.handleConnection(true);
  r.a.handleWear(true);
  r.wait(1600);
  r.a.handleTouch('double');
  assert.equal(r.a.state, 'HIDDEN');
});

test('undo hide can be switched off', async () => {
  const r = await shown();
  await r.a.updateSettings({ undoHideMs: 0 });
  r.play(still(1500));
  r.play(shake());
  assert.equal(r.a.state, 'HIDDEN');
  r.a.handleTouch('double');
  assert.equal(r.a.state, 'HIDDEN');
});

// ---- Cases added after the mutation check found them unguarded ----

test('a quick look one way and a rest after the look back the other way is not a shake', () => {
  for (const [deg, turn, hold] of [[30, 150, 150], [35, 150, 120], [35, 200, 150]]) {
    const m = settle(lookSide({ deg: -deg, turnMs: turn, holdMs: 0, backMs: turn }), lookSide({ deg, turnMs: turn, holdMs: hold, backMs: turn }));
    for (const seed of [1, 2, 3]) {
      const samples = [...stream(m, { seed })];
      assert.ok(countGestures(samples, LEGACY_SETTINGS).shakes > 0 || seed > 1, 'the legacy settings fire on this');
      assert.equal(countGestures(samples, base).shakes, 0, `${deg} deg, turn ${turn}, rest ${hold}, seed ${seed}`);
    }
  }
});

test('repeated hide and show shakes do not raise the bar for each other', () => {
  // Five moderate shakes 1.5 s apart: they fill much of the activity window.
  const parts: Motion[] = [];
  for (let i = 0; i < 5; i++) parts.push(shake({ ampDeg: 16, hz: 2.2, cycles: 2, startSign: i % 2 ? 1 : -1 }), still(1500));
  assert.equal(countGestures(stream(settle(...parts), { seed: 6 }), base).shakes, 5);
});

test('undo hide refuses when a camera status arrived after the hide', async () => {
  const r = await shown();
  r.play(shake());
  assert.equal(r.a.state, 'HIDDEN');
  await r.a.handleJobEvent({ jobId: 'cam', seq: 1, status: 'received', photos: 2, pages: 1 });
  r.a.handleTouch('double');
  assert.equal(r.a.state, 'HIDDEN', 'the screen would now show a status line that was never on the lens');
});
