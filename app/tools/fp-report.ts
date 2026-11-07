// Prints false-positive and detection figures on synthetic motion.
// SYNTHETIC ONLY: these numbers say nothing about real G2 data.
import { SCENARIOS, countGestures } from '../src/core/scenarios.ts';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/core/settings.ts';
import { mulberry32, sequence, shake, still, stream, talking, tilt, together, walking } from '../src/core/synth.ts';

const settings = sanitizeSettings(DEFAULT_SETTINGS);
const HOUR = 3_600_000;
const SEEDS = [11, 22, 33, 44, 55];

console.log('SYNTHETIC RESULTS. Thresholds are NOT validated on hardware.\n');
console.log('False positives per run. 5 seeds x 1 hour each at 50 Hz, with 8 ms jitter and 2% dropped samples.');
console.log('intensity scales all background motion; 1.0 is the model used when choosing the defaults.\n');
console.log('activity  intensity  hours  shakes  tilts  scroll-lines');
for (const [name, make] of [['walking', walking], ['talking', talking]] as const) {
  for (const intensity of [1, 1.25, 1.5, 2, 3]) {
    let shakes = 0;
    let tilts = 0;
    let lines = 0;
    for (const seed of SEEDS) {
      const c = countGestures(stream(make(HOUR, seed, intensity), { hz: 50, jitterMs: 8, dropRate: 0.02, seed }), settings);
      shakes += c.shakes;
      tilts += c.tiltStarts;
      lines += c.upLines + c.downLines;
    }
    console.log(`${name.padEnd(9)} ${intensity.toFixed(2).padStart(9)}  ${String(SEEDS.length).padStart(5)}  ${String(shakes).padStart(6)}  ${String(tilts).padStart(5)}  ${String(lines).padStart(12)}`);
  }
}

console.log('\nDetection of intended gestures. 300 randomised trials per row.');
console.log('Shake: amplitude 16-30 deg, 1.6-3 Hz, 2-3 cycles. Tilt: 20-32 deg, ramp 150-350 ms, hold 1-2 s.\n');
console.log('hz   jitter  drop  batch  shake-ok  tilt-up-ok  tilt-down-ok');
for (const [hz, jitterMs, dropRate, batch] of [[100, 0, 0, 1], [50, 0, 0, 1], [50, 10, 0.05, 1], [50, 10, 0.05, 4], [25, 10, 0.05, 1], [15, 10, 0, 1], [10, 0, 0, 1], [7, 0, 0, 1], [5, 0, 0, 1]]) {
  const rng = mulberry32(hz * 31 + jitterMs + batch);
  const trials = 300;
  let okShake = 0;
  let okUp = 0;
  let okDown = 0;
  for (let i = 0; i < trials; i++) {
    const o = { hz, jitterMs, dropRate, batch, seed: i + 1 };
    const sm = sequence(still(1500), shake({ ampDeg: 16 + rng() * 14, hz: 1.6 + rng() * 1.4, cycles: 2 + Math.round(rng()), startSign: rng() < 0.5 ? 1 : -1 }), still(800));
    if (countGestures(stream(sm, o), settings).shakes === 1) okShake++;
    const opts = { rampMs: 150 + rng() * 200, holdMs: 1000 + rng() * 1000 };
    const deg = 20 + rng() * 12;
    const up = countGestures(stream(sequence(still(1500), tilt(deg, opts), still(800)), o), settings);
    if (up.upLines > 0 && up.downLines === 0 && up.shakes === 0) okUp++;
    const down = countGestures(stream(sequence(still(1500), tilt(-deg, opts), still(800)), o), settings);
    if (down.downLines > 0 && down.upLines === 0 && down.shakes === 0) okDown++;
  }
  const pct = (n: number) => `${((n / trials) * 100).toFixed(1)}%`;
  console.log(`${String(hz).padEnd(4)} ${String(jitterMs).padStart(6)}  ${dropRate.toFixed(2)}  ${String(batch).padStart(5)}  ${pct(okShake).padStart(8)}  ${pct(okUp).padStart(10)}  ${pct(okDown).padStart(12)}`);
}

console.log('\nShake detected while walking, 300 trials at 50 Hz with 8 ms jitter:');
{
  const rng = mulberry32(99);
  let ok = 0;
  let extra = 0;
  for (let i = 0; i < 300; i++) {
    const m = together(walking(9000, i + 1), sequence(still(4000), shake({ ampDeg: 18 + rng() * 12, hz: 1.8 + rng() * 1.2, cycles: 2 }), still(2000)));
    const c = countGestures(stream(m, { hz: 50, jitterMs: 8, seed: i + 1 }), settings);
    if (c.shakes >= 1) ok++;
    if (c.shakes > 1) extra++;
  }
  console.log(`detected ${ok}/300, more than one fired in ${extra}`);
}

console.log('\nScenario table at 50 Hz, seed 1.\n');
for (const s of SCENARIOS) {
  const c = countGestures(stream(s.motion(1), { hz: 50, seed: 1 }), settings);
  console.log(`${s.name.padEnd(26)} shakes=${c.shakes} up=${c.upLines} down=${c.downLines}  expected shakes=${s.expect.shakes} up=${s.expect.up} down=${s.expect.down}`);
}
