import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExampleRecorder, analyseExamples, scoreExamples, type Example } from '../src/core/personal.ts';
import { makePopulation, recordExamples, runPerson, type Person } from '../src/core/population.ts';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/core/settings.ts';
import { lookSide, sequence, shake, still, stream, talking, tilt } from '../src/core/synth.ts';
import { Rig } from './helpers.ts';

const base = sanitizeSettings(DEFAULT_SETTINGS);

// A person with a small, quick shake that the defaults mostly miss.
const small: Person = { ...makePopulation(1, 5)[0], id: 900, shakeAmp: 11, shakeHz: 2.4, shakeCycles: 2, tiltUp: 18, tiltDown: 19, busy: 1, sampleHz: 50, noiseDeg: 0.15 };

test('personal: needs enough examples of each kind and says which are missing', () => {
  const r = analyseExamples(recordExamples(small).filter((e) => e.label !== 'tiltUp'), base);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /tiltUp/);
  assert.equal(r.proposal, null);
});

test('personal: a small shaker is caught after calibration, and the user sees before and after on their own examples', () => {
  const examples = recordExamples(small);
  const r = analyseExamples(examples, base);
  assert.ok(r.ok && r.proposal && r.after);
  assert.ok(r.after.shake.hit > r.before.shake.hit, `before ${r.before.shake.hit}, after ${r.after.shake.hit}`);
  assert.equal(r.after.shake.hit, r.after.shake.of);
  assert.equal(r.after.otherFired.hit, 0, 'the ordinary-movement examples still do not fire');
  assert.ok(r.proposal.shakeMinAmpDeg < base.shakeMinAmpDeg);
  const before = runPerson(small, base);
  const after = runPerson(small, base, { personal: true });
  assert.ok(after.shake > before.shake, `fresh trials: ${before.shake} -> ${after.shake} of ${after.shakeOf}`);
});

test('personal: ordinary movement examples push the limits up until they stop firing', () => {
  // Someone whose conversation includes wide, quick head shakes.
  const p: Person = { ...small, id: 901, shakeAmp: 16, busy: 2.4 };
  const examples: Example[] = [...recordExamples(p).filter((e) => e.label !== 'other'), { label: 'other', samples: [...stream(sequence(still(400), shake({ ampDeg: 12, hz: 2.6, cycles: 2 }), still(400)), { seed: 3 })] }];
  const r = analyseExamples(examples, base);
  assert.ok(r.ok && r.after);
  assert.equal(r.after.otherFired.hit, 0, 'the recorded "no" no longer fires');
  assert.ok(r.after.shake.hit >= 2, 'and most real shakes still do');
});

test('personal: large shakers keep the default limit, so walking is not made harder', () => {
  const big: Person = { ...small, id: 902, shakeAmp: 28 };
  const r = analyseExamples(recordExamples(big), base);
  assert.ok(r.ok && r.proposal);
  assert.equal(r.proposal.shakeMinAmpDeg, base.shakeMinAmpDeg);
  assert.ok(r.proposal.shakeMinRateDps <= base.shakeMinRateDps);
});

test('personal: a tilt that goes the wrong way is refused rather than guessed', () => {
  const ex = recordExamples(small).map((e) => (e.label === 'tiltUp' ? { ...e, samples: [...stream(sequence(still(400), tilt(-22), still(400)), { seed: 1 })] } : e));
  const r = analyseExamples(ex, base);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /wrong way/);
});

test('personal: scoring counts glances that fire as ordinary movement that fired', () => {
  const glance = { label: 'other' as const, samples: [...stream(sequence(lookSide({ deg: -35, turnMs: 150, holdMs: 100, backMs: 150 }), lookSide({ deg: 35, turnMs: 150, holdMs: 100, backMs: 150 })), { seed: 2 })] };
  const loose = sanitizeSettings({ ...base, shakeMaxPlateauMs: 5000, activityAware: false });
  assert.equal(scoreExamples([glance], base).otherFired.hit, 0);
  assert.ok(scoreExamples([glance], loose).otherFired.of === 1);
});

test('recorder: keeps examples, drops ones that are too short, ignores bad samples, caps the length', () => {
  const rec = new ExampleRecorder();
  rec.start('shake');
  rec.push({ x: 0, y: 0, z: 0, t: 0 });
  assert.equal(rec.stop(), false, 'too short');
  rec.start('other');
  for (const s of stream(talking(25_000, 1))) rec.push(s);
  rec.push({ x: NaN, y: 0, z: 0, t: 1 });
  assert.equal(rec.stop(), true);
  const kept = rec.examples[0].samples;
  assert.ok(kept.at(-1)!.t - kept[0].t <= 20_000, 'a forgotten stop does not record for ever');
  assert.equal(rec.count('other'), 1);
});

test('assistant: no gesture fires while an example is recorded, and nothing changes until accepted', async () => {
  const r = await new Rig().ready();
  const before = { ...r.a.settings };
  r.a.startExample('shake');
  r.play(shake());
  r.play(shake());
  assert.equal(r.a.state, 'HIDDEN');
  assert.ok(r.a.stopExample());
  assert.equal(r.a.snapshot().examples.shake, 1);
  const res = r.a.analysePersonal();
  assert.equal(res.ok, false, 'one example is not enough');
  assert.deepEqual(r.a.settings, before);
  r.play(still(1500));
  r.play(shake());
  assert.equal(r.a.state, 'VISIBLE', 'gestures work again after recording');
});
