import type { RawSample } from './imuAdapter.ts';
import { analyseExamples, type Example } from './personal.ts';
import { countGestures } from './scenarios.ts';
import { DEFAULT_SETTINGS, sanitizeSettings, type Settings } from './settings.ts';
import { lookSide, mulberry32, nod, sequence, shake, still, stream, talking, tilt, together, walking, type Motion } from './synth.ts';

// A synthetic population: many simulated people whose heads move with different
// ranges and speeds. SYNTHETIC ONLY. The ranges below are guesses, not
// measurements, so the rates say how robust the logic is to variation, not how
// it will do on real people.

export interface Person {
  id: number;
  /** Peak yaw each way of a deliberate shake, in degrees. */
  shakeAmp: number;
  shakeHz: number;
  shakeCycles: number;
  tiltUp: number;
  tiltDown: number;
  tiltRampMs: number;
  tiltHoldMs: number;
  /** Background motion relative to the walking and talking models. */
  busy: number;
  /** How long this person rests at each side when glancing left and right. */
  glanceHoldMs: number;
  glanceDeg: number;
  sampleHz: number;
  noiseDeg: number;
}

const between = (rng: () => number, lo: number, hi: number): number => lo + rng() * (hi - lo);

export function makePopulation(n: number, seed = 1): Person[] {
  const rng = mulberry32(seed);
  const people: Person[] = [];
  for (let id = 0; id < n; id++) {
    people.push({
      id,
      shakeAmp: between(rng, 10, 30),
      shakeHz: between(rng, 1.3, 3.2),
      shakeCycles: between(rng, 1.5, 3),
      tiltUp: between(rng, 16, 34),
      tiltDown: between(rng, 18, 34),
      tiltRampMs: between(rng, 120, 320),
      tiltHoldMs: between(rng, 800, 2000),
      busy: between(rng, 0.6, 2.2),
      glanceHoldMs: between(rng, 60, 400),
      glanceDeg: between(rng, 20, 45),
      sampleHz: [15, 25, 50, 50, 50][Math.floor(rng() * 5)],
      noiseDeg: between(rng, 0.1, 0.4),
    });
  }
  return people;
}

export interface PersonResult {
  shake: number; shakeOf: number;
  up: number; upOf: number;
  down: number; downOf: number;
  walkShake: number; walkShakeOf: number;
  falseShakes: number; falseTilts: number; backgroundMin: number;
}

export interface PopulationOptions {
  trials?: number;
  backgroundMs?: number;
  /** Derive personal thresholds from recorded examples first. */
  personal?: boolean;
}

// One trial of each gesture varies a little around the person's own style.
function shakeMotion(p: Person, rng: () => number): Motion {
  return shake({ ampDeg: p.shakeAmp * between(rng, 0.85, 1.15), hz: p.shakeHz * between(rng, 0.9, 1.1), cycles: Math.max(1.5, p.shakeCycles + between(rng, -0.25, 0.25)), startSign: rng() < 0.5 ? 1 : -1 });
}

function tiltMotion(p: Person, rng: () => number, dir: 1 | -1): Motion {
  const deg = (dir > 0 ? p.tiltUp : p.tiltDown) * between(rng, 0.9, 1.1);
  return tilt(dir * deg, { rampMs: p.tiltRampMs * between(rng, 0.85, 1.15), holdMs: p.tiltHoldMs });
}

function glances(p: Person, rng: () => number): Motion {
  const g = (sign: number) => lookSide({ deg: sign * p.glanceDeg * between(rng, 0.8, 1.2), turnMs: between(rng, 150, 350), holdMs: p.glanceHoldMs * between(rng, 0.8, 1.2), backMs: between(rng, 150, 350) });
  return sequence(g(-1), g(1), still(1500), g(1), g(-1), still(1500), g(-1), still(600), g(1));
}

function background(p: Person, ms: number, seed: number): Motion {
  return sequence(talking(ms / 2, seed, p.busy), walking(ms / 2, seed + 1, p.busy));
}

function samples(m: Motion, p: Person, seed: number, s: Settings = DEFAULT_SETTINGS): RawSample[] {
  return [...stream(m, { hz: p.sampleHz, jitterMs: 6, dropRate: 0.02, noiseDeg: p.noiseDeg, seed, settings: s })];
}

/** The examples a person would record in the personal calibration step. */
export function recordExamples(p: Person, seed = 1): Example[] {
  const rng = mulberry32(seed * 7919 + p.id);
  const out: Example[] = [];
  const add = (label: Example['label'], m: Motion) => out.push({ label, samples: samples(sequence(still(400), m, still(400)), p, Math.floor(rng() * 1e9)) });
  for (let i = 0; i < 3; i++) add('shake', shakeMotion(p, rng));
  for (let i = 0; i < 3; i++) add('tiltUp', tiltMotion(p, rng, 1));
  for (let i = 0; i < 3; i++) add('tiltDown', tiltMotion(p, rng, -1));
  add('other', glances(p, rng));
  add('other', sequence(talking(14_000, Math.floor(rng() * 1e6), p.busy), nod({ ampDeg: 10, cycles: 2 })));
  add('other', walking(14_000, Math.floor(rng() * 1e6), p.busy));
  return out;
}

export function settingsFor(p: Person, base: Settings, personal: boolean): Settings {
  if (!personal) return base;
  const r = analyseExamples(recordExamples(p), base);
  return r.ok && r.proposal ? r.proposal : base;
}

export function runPerson(p: Person, base: Settings, o: PopulationOptions = {}): PersonResult {
  const { trials = 4, backgroundMs = 120_000, personal = false } = o;
  const s = settingsFor(p, base, personal);
  const rng = mulberry32(p.id * 104729 + 17);
  const r: PersonResult = { shake: 0, shakeOf: 0, up: 0, upOf: 0, down: 0, downOf: 0, walkShake: 0, walkShakeOf: 0, falseShakes: 0, falseTilts: 0, backgroundMin: 0 };
  const run = (m: Motion) => countGestures(samples(sequence(still(1500), m, still(800)), p, Math.floor(rng() * 1e9)), s);
  for (let i = 0; i < trials; i++) {
    r.shakeOf++;
    if (run(shakeMotion(p, rng)).shakes === 1) r.shake++;
    r.upOf++;
    const u = run(tiltMotion(p, rng, 1));
    if (u.upLines > 0 && u.downLines === 0 && u.shakes === 0) r.up++;
    r.downOf++;
    const d = run(tiltMotion(p, rng, -1));
    if (d.downLines > 0 && d.upLines === 0 && d.shakes === 0) r.down++;
  }
  // A shake in the middle of walking at this person's own level of motion.
  r.walkShakeOf++;
  const w = countGestures(samples(together(walking(9000, p.id + 1, p.busy), sequence(still(4000), shakeMotion(p, rng), still(2000))), p, p.id + 3), s);
  if (w.shakes >= 1) r.walkShake++;
  // Ordinary motion that must not fire.
  const bg = countGestures(samples(sequence(still(1500), background(p, backgroundMs, p.id + 11), glances(p, rng), still(800)), p, p.id + 5), s);
  r.falseShakes = bg.shakes;
  r.falseTilts = bg.tiltStarts;
  r.backgroundMin = (1500 + backgroundMs + 800) / 60_000;
  return r;
}

export interface PopulationSummary {
  people: number;
  shakeRate: number;
  upRate: number;
  downRate: number;
  walkShakeRate: number;
  falseShakesPerHour: number;
  falseTiltsPerHour: number;
  /** People with at least one false shake. */
  peopleWithFalseShake: number;
  /** People who missed more than half of their shakes. */
  peopleMostlyMissed: number;
}

export function summarize(results: PersonResult[]): PopulationSummary {
  const sum = (k: keyof PersonResult) => results.reduce((a, r) => a + r[k], 0);
  const hours = sum('backgroundMin') / 60;
  return {
    people: results.length,
    shakeRate: sum('shake') / Math.max(1, sum('shakeOf')),
    upRate: sum('up') / Math.max(1, sum('upOf')),
    downRate: sum('down') / Math.max(1, sum('downOf')),
    walkShakeRate: sum('walkShake') / Math.max(1, sum('walkShakeOf')),
    falseShakesPerHour: sum('falseShakes') / Math.max(1e-9, hours),
    falseTiltsPerHour: sum('falseTilts') / Math.max(1e-9, hours),
    peopleWithFalseShake: results.filter((r) => r.falseShakes > 0).length,
    peopleMostlyMissed: results.filter((r) => r.shake * 2 < r.shakeOf).length,
  };
}

export function runPopulation(people: Person[], base: Settings, o: PopulationOptions = {}): PopulationSummary {
  return summarize(people.map((p) => runPerson(p, base, o)));
}

/** The settings before this change: no activity awareness and no plateau limit. */
export const LEGACY_SETTINGS: Readonly<Settings> = Object.freeze(sanitizeSettings({ ...DEFAULT_SETTINGS, activityAware: false, shakeMaxPlateauMs: 5000, undoHideMs: 0 }));
