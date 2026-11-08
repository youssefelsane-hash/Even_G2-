import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LEGACY_SETTINGS, makePopulation, runPerson, runPopulation } from '../src/core/population.ts';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/core/settings.ts';

// A synthetic population: simulated people with different head ranges, speeds,
// background motion and sample rates. SYNTHETIC ONLY: the ranges are guesses.
// The test pins the trade-offs, so a change that quietly makes them worse fails.

const base = sanitizeSettings(DEFAULT_SETTINGS);
const people = makePopulation(60, 1);
const legacy = runPopulation(people, LEGACY_SETTINGS);
const now = runPopulation(people, base);
const personal = runPopulation(people, base, { personal: true });
console.log(`# population legacy ${JSON.stringify(legacy)}`);
console.log(`# population now ${JSON.stringify(now)}`);
console.log(`# population personal ${JSON.stringify(personal)}`);

test('population: the people are really different', () => {
  const amps = people.map((p) => p.shakeAmp);
  assert.ok(Math.max(...amps) / Math.min(...amps) > 2.5);
  assert.ok(new Set(people.map((p) => p.sampleHz)).size >= 3);
});

test('population: false shakes in ordinary motion fall by more than half against the legacy settings', () => {
  assert.ok(now.falseShakesPerHour * 2 <= legacy.falseShakesPerHour, `${now.falseShakesPerHour} vs ${legacy.falseShakesPerHour}`);
  assert.ok(now.peopleWithFalseShake < legacy.peopleWithFalseShake);
  assert.ok(now.falseTiltsPerHour <= legacy.falseTiltsPerHour);
});

test('population: standing still, detection stays close to before', () => {
  // The rest limit that stops quick glances also refuses some very slow shakes
  // (about 1.3 Hz) at 15 Hz sampling. Personal calibration widens it for them.
  assert.ok(now.shakeRate >= legacy.shakeRate - 0.04, `${now.shakeRate} vs ${legacy.shakeRate}`);
  assert.ok(now.upRate >= legacy.upRate - 0.01 && now.downRate >= legacy.downRate - 0.01);
  assert.ok(now.shakeRate >= 0.75 && now.upRate >= 0.9 && now.downRate >= 0.85);
});

test('population: the known cost, shakes while walking, stays within a set bound', () => {
  // Asking for a bigger shake while the head is busy is the price of fewer
  // false fires. This pins how much it may cost on this synthetic population.
  assert.ok(now.walkShakeRate >= legacy.walkShakeRate - 0.2, `${now.walkShakeRate} vs ${legacy.walkShakeRate}`);
});

test('population: personal calibration helps people the defaults miss', () => {
  assert.ok(personal.shakeRate > now.shakeRate + 0.05, `${personal.shakeRate} vs ${now.shakeRate}`);
  assert.ok(personal.peopleMostlyMissed < now.peopleMostlyMissed);
  assert.ok(personal.upRate >= now.upRate && personal.downRate >= now.downRate);
});

test('population: one run is reproducible', () => {
  const p = people[7];
  assert.deepEqual(runPerson(p, base), runPerson(p, base));
});
