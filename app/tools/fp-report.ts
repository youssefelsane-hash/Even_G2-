// Prints false-positive and detection figures on synthetic motion, for the
// legacy gesture settings (before activity awareness and the glance rule) and
// for the current defaults, side by side.
// SYNTHETIC ONLY: these numbers say nothing about real G2 data.
import { LEGACY_SETTINGS, makePopulation, runPopulation, type PopulationSummary } from '../src/core/population.ts';
import { SCENARIOS, countGestures } from '../src/core/scenarios.ts';
import { DEFAULT_SETTINGS, sanitizeSettings, type Settings } from '../src/core/settings.ts';
import { lookSide, mulberry32, sequence, shake, still, stream, talking, tilt, together, walking } from '../src/core/synth.ts';

const NOW = sanitizeSettings(DEFAULT_SETTINGS);
const CONFIGS: [string, Settings][] = [['legacy', LEGACY_SETTINGS], ['now', NOW]];
const HOUR = 3_600_000;
const SEEDS = [11, 22, 33, 44, 55];
const pct = (n: number, of: number) => `${((n / of) * 100).toFixed(1)}%`;

console.log('SYNTHETIC RESULTS. Thresholds are NOT validated on hardware.');
console.log('"legacy" = the V0.3 defaults (no activity awareness, no rest limit). "now" = current defaults.\n');

console.log('1. False fires. 5 seeds x 1 hour each at 50 Hz, 8 ms jitter, 2% dropped samples.');
console.log('   intensity scales all background motion; 1.0 is the model used when choosing the defaults.\n');
console.log('activity  intensity  hours  shakes legacy  shakes now  tilts legacy  tilts now');
for (const [name, make] of [['walking', walking], ['talking', talking]] as const) {
  for (const intensity of [1, 1.25, 1.5, 2, 3]) {
    const tot = CONFIGS.map(() => ({ shakes: 0, tilts: 0 }));
    for (const seed of SEEDS) {
      const samples = [...stream(make(HOUR, seed, intensity), { hz: 50, jitterMs: 8, dropRate: 0.02, seed })];
      CONFIGS.forEach(([, s], i) => {
        const c = countGestures(samples, s);
        tot[i].shakes += c.shakes;
        tot[i].tilts += c.tiltStarts;
      });
    }
    console.log(`${name.padEnd(9)} ${intensity.toFixed(2).padStart(9)}  ${String(SEEDS.length).padStart(5)}  ${String(tot[0].shakes).padStart(13)}  ${String(tot[1].shakes).padStart(10)}  ${String(tot[0].tilts).padStart(12)}  ${String(tot[1].tilts).padStart(9)}`);
  }
}

console.log('\n2. Detection of intended gestures, standing still. 300 randomised trials per row.');
console.log('   Shake: amplitude 16-30 deg, 1.6-3 Hz, 2-3 cycles. Tilt: 20-32 deg, ramp 150-350 ms, hold 1-2 s.\n');
console.log('hz   jitter  drop  batch  shake legacy  shake now  tilt-up now  tilt-down now');
for (const [hz, jitterMs, dropRate, batch] of [[100, 0, 0, 1], [50, 0, 0, 1], [50, 10, 0.05, 1], [50, 10, 0.05, 4], [25, 10, 0.05, 1], [15, 10, 0, 1], [10, 0, 0, 1], [7, 0, 0, 1], [5, 0, 0, 1]]) {
  const rng = mulberry32(hz * 31 + jitterMs + batch);
  const trials = 300;
  const ok = { shakeL: 0, shakeN: 0, up: 0, down: 0 };
  for (let i = 0; i < trials; i++) {
    const o = { hz, jitterMs, dropRate, batch, seed: i + 1 };
    const sm = [...stream(sequence(still(1500), shake({ ampDeg: 16 + rng() * 14, hz: 1.6 + rng() * 1.4, cycles: 2 + Math.round(rng()), startSign: rng() < 0.5 ? 1 : -1 }), still(800)), o)];
    if (countGestures(sm, LEGACY_SETTINGS).shakes === 1) ok.shakeL++;
    if (countGestures(sm, NOW).shakes === 1) ok.shakeN++;
    const opts = { rampMs: 150 + rng() * 200, holdMs: 1000 + rng() * 1000 };
    const deg = 20 + rng() * 12;
    const up = countGestures(stream(sequence(still(1500), tilt(deg, opts), still(800)), o), NOW);
    if (up.upLines > 0 && up.downLines === 0 && up.shakes === 0) ok.up++;
    const down = countGestures(stream(sequence(still(1500), tilt(-deg, opts), still(800)), o), NOW);
    if (down.downLines > 0 && down.upLines === 0 && down.shakes === 0) ok.down++;
  }
  console.log(`${String(hz).padEnd(4)} ${String(jitterMs).padStart(6)}  ${dropRate.toFixed(2)}  ${String(batch).padStart(5)}  ${pct(ok.shakeL, trials).padStart(12)}  ${pct(ok.shakeN, trials).padStart(9)}  ${pct(ok.up, trials).padStart(11)}  ${pct(ok.down, trials).padStart(13)}`);
}

console.log('\n3. Shake while walking, 300 trials at 50 Hz with 8 ms jitter (shake 18-30 deg, 1.8-3 Hz, 2 cycles):');
{
  const rng = mulberry32(99);
  const ok = [0, 0];
  const extra = [0, 0];
  for (let i = 0; i < 300; i++) {
    const m = together(walking(9000, i + 1), sequence(still(4000), shake({ ampDeg: 18 + rng() * 12, hz: 1.8 + rng() * 1.2, cycles: 2 }), still(2000)));
    const samples = [...stream(m, { hz: 50, jitterMs: 8, seed: i + 1 })];
    CONFIGS.forEach(([, s], k) => {
      const c = countGestures(samples, s);
      if (c.shakes >= 1) ok[k]++;
      if (c.shakes > 1) extra[k]++;
    });
  }
  console.log(`legacy detected ${ok[0]}/300 (more than one: ${extra[0]}); now detected ${ok[1]}/300 (more than one: ${extra[1]})`);
}

console.log('\n4. Quick left-right looks (look one way, rest, look the other way, rest). 12 cases per rest time:');
console.log('   25, 35, 45 deg x turn 150, 200, 300, 400 ms, at 50 Hz and at 15 Hz.\n');
console.log('rest ms  legacy 50Hz  now 50Hz  legacy 15Hz  now 15Hz');
for (const hold of [0, 50, 100, 150, 200, 300]) {
  const fired = [0, 0, 0, 0];
  for (const deg of [25, 35, 45]) {
    for (const turn of [150, 200, 300, 400]) {
      const m = sequence(still(1500), lookSide({ deg: -deg, turnMs: turn, holdMs: hold, backMs: turn }), lookSide({ deg, turnMs: turn, holdMs: hold, backMs: turn }), still(800));
      [50, 15].forEach((hz, h) => {
        const samples = [...stream(m, { hz, seed: deg + turn })];
        CONFIGS.forEach(([, s], k) => { if (countGestures(samples, s).shakes > 0) fired[h * 2 + k]++; });
      });
    }
  }
  console.log(`${String(hold).padStart(7)}  ${`${fired[0]}/12`.padStart(11)}  ${`${fired[1]}/12`.padStart(8)}  ${`${fired[2]}/12`.padStart(11)}  ${`${fired[3]}/12`.padStart(8)}`);
}

console.log('\n5. Synthetic population: 200 simulated people (shake 10-30 deg each way at 1.3-3.2 Hz, tilts 16-34 deg,');
console.log('   background 0.6-2.2x the walking and talking models, 15, 25 or 50 Hz). Per person: 4 shakes, 4 tilts each way,');
console.log('   1 shake while walking, and about 2 minutes of talking, walking and glances that must not fire.\n');
{
  const people = makePopulation(200, 1);
  const rows: [string, PopulationSummary][] = [
    ['legacy', runPopulation(people, LEGACY_SETTINGS)],
    ['now', runPopulation(people, NOW)],
    ['now + personal calibration', runPopulation(people, NOW, { personal: true })],
  ];
  console.log('settings                     shake  tilt-up  tilt-down  shake-walking  false shakes/h  false tilts/h  people with false shake  people mostly missed');
  for (const [name, s] of rows) {
    console.log(`${name.padEnd(27)} ${pct(s.shakeRate, 1).padStart(6)}  ${pct(s.upRate, 1).padStart(7)}  ${pct(s.downRate, 1).padStart(9)}  ${pct(s.walkShakeRate, 1).padStart(13)}  ${s.falseShakesPerHour.toFixed(2).padStart(14)}  ${s.falseTiltsPerHour.toFixed(2).padStart(13)}  ${String(s.peopleWithFalseShake).padStart(23)}  ${String(s.peopleMostlyMissed).padStart(20)}`);
  }
}

console.log('\n6. Scenario table at 50 Hz, seed 1, current defaults.\n');
for (const s of SCENARIOS) {
  const c = countGestures(stream(s.motion(1), { hz: 50, seed: 1 }), NOW);
  console.log(`${s.name.padEnd(26)} shakes=${c.shakes} up=${c.upLines} down=${c.downLines}  expected shakes=${s.expect.shakes} up=${s.expect.up} down=${s.expect.down}`);
}
