import { extractSwings } from './calibration.ts';
import { ImuAdapter, type RawSample } from './imuAdapter.ts';
import { countGestures } from './scenarios.ts';
import { sanitizeSettings, type Settings } from './settings.ts';

// Personal calibration. The wizard in calibration.ts finds the axes and the
// scale from one tilt and one shake. This step comes after it: the user records
// a few examples of each gesture the way they really do it, plus some ordinary
// head movement that must NOT count, and the thresholds are derived from those
// examples. The proposal is then replayed against the same examples, so the user
// sees how many of their own gestures it catches before accepting anything.

export type ExampleLabel = 'shake' | 'tiltUp' | 'tiltDown' | 'other';
export const EXAMPLE_LABELS: ExampleLabel[] = ['shake', 'tiltUp', 'tiltDown', 'other'];

export const EXAMPLE_TEXT: Record<ExampleLabel, string> = {
  shake: 'Shake your head as you would to hide the screen.',
  tiltUp: 'Tilt your head up as you would to scroll up, hold, then come back.',
  tiltDown: 'Tilt your head down as you would to scroll down, hold, then come back.',
  other: 'Move as you normally do: look left and right, nod, talk. None of this should count.',
};

export interface Example { label: ExampleLabel; samples: RawSample[] }

export const MIN_EXAMPLES: Record<ExampleLabel, number> = { shake: 3, tiltUp: 3, tiltDown: 3, other: 0 };
const MAX_EXAMPLE_MS = 20_000;
const MAX_EXAMPLES = 40;
const LEAD_IN_MS = 1500;
/**
 * Lowest minimum shake swing a proposal may set, in degree-equivalents from one
 * side to the other. Below it ordinary conversation fires shakes many times an
 * hour (synthetic talking: about 17 an hour at 14, over 80 at 10).
 */
export const PERSONAL_MIN_SHAKE_DEG = 14;

export class ExampleRecorder {
  private current: Example | null = null;
  private list: Example[] = [];

  get recording(): ExampleLabel | null { return this.current?.label ?? null; }
  get examples(): readonly Example[] { return this.list; }

  count(label: ExampleLabel): number {
    return this.list.filter((e) => e.label === label).length;
  }

  start(label: ExampleLabel): void {
    this.current = { label, samples: [] };
  }

  push(s: RawSample): void {
    const c = this.current;
    if (!c || ![s.x, s.y, s.z, s.t].every(Number.isFinite)) return;
    if (c.samples.length && s.t - c.samples[0].t > MAX_EXAMPLE_MS) return; // forgot to press stop
    c.samples.push(s);
  }

  /** Ends the current example. Returns false if it was too short to use. */
  stop(): boolean {
    const c = this.current;
    this.current = null;
    if (!c || c.samples.length < 8) return false;
    this.list.push(c);
    if (this.list.length > MAX_EXAMPLES) this.list.shift();
    return true;
  }

  cancel(): void { this.current = null; }

  clear(): void {
    this.current = null;
    this.list = [];
  }
}

export interface Score { hit: number; of: number }
export interface ExampleScore { shake: Score; tiltUp: Score; tiltDown: Score; /** Examples of ordinary motion where anything fired. */ otherFired: Score }

export interface PersonalResult {
  ok: boolean;
  proposal: Settings | null;
  before: ExampleScore;
  after: ExampleScore | null;
  warnings: string[];
  error?: string;
}

interface Trace { t: number[]; pitch: number[]; yaw: number[] }

// Angles in degree-equivalents using the axis mapping that is already set,
// relative to the first samples of the example.
function traceOf(samples: RawSample[], s: Settings): Trace {
  const a = new ImuAdapter(s);
  const out: Trace = { t: [], pitch: [], yaw: [] };
  for (const r of samples) {
    const sig = a.push(r);
    if (!sig) continue;
    out.t.push(sig.t);
    out.pitch.push(sig.pitch);
    out.yaw.push(sig.yaw);
  }
  const n = Math.max(1, Math.min(5, out.t.length));
  const p0 = out.pitch.slice(0, n).reduce((x, y) => x + y, 0) / n;
  const y0 = out.yaw.slice(0, n).reduce((x, y) => x + y, 0) / n;
  out.pitch = out.pitch.map((v) => v - p0);
  out.yaw = out.yaw.map((v) => v - y0);
  return out;
}

const median = (v: number[]): number => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const range = (v: number[]): number => (v.length ? Math.max(...v) - Math.min(...v) : 0);

interface ShakeShape { amp: number; rate: number; swingMs: number; pitchRange: number }

// The full swings of a shake. The first swing starts from rest, so its
// duration includes the pause before it, and the first and last are often half
// swings from and back to the centre. Only full-size swings after the first count.
function shakeShape(tr: Trace): ShakeShape | null {
  const r = range(tr.yaw);
  if (r <= 0) return null;
  const all = extractSwings(tr.t, tr.yaw, r * 0.2).filter((s) => s.durMs > 0);
  const biggest = Math.max(0, ...all.map((s) => s.amp));
  const swings = all.slice(1).filter((s) => s.amp >= biggest * 0.6);
  if (swings.length < 1 || all.length < 3) return null;
  const amp = median(swings.map((s) => s.amp));
  return {
    amp,
    rate: median(swings.map((s) => (s.amp / s.durMs) * 1000)),
    swingMs: median(swings.map((s) => s.durMs)),
    pitchRange: range(tr.pitch),
  };
}

interface TiltShape { peak: number; entryMs: number }

function tiltShape(tr: Trace, sign: 1 | -1, fraction: number): TiltShape | null {
  const dev = tr.pitch.map((p) => p * sign);
  const peak = Math.max(...dev);
  // The main movement must be in the asked direction, and clearly above noise.
  if (!(peak > 3) || -Math.min(...dev) > peak) return null;
  const start = dev.findIndex((d) => d > peak * 0.2);
  const reach = dev.findIndex((d) => d >= peak * fraction);
  return { peak, entryMs: start >= 0 && reach >= start ? tr.t[reach] - tr.t[start] : 0 };
}

/** The example with a still lead-in, so the engine can learn neutral first, then a still tail. */
function padded(samples: RawSample[]): RawSample[] {
  const first = samples[0];
  const last = samples[samples.length - 1];
  const period = samples.length > 1 ? Math.max(5, (last.t - first.t) / (samples.length - 1)) : 20;
  const lead: RawSample[] = [];
  for (let t = first.t - LEAD_IN_MS; t < first.t; t += period) lead.push({ ...first, t });
  const tail: RawSample[] = [];
  for (let t = last.t + period; t <= last.t + 800; t += period) tail.push({ ...last, t });
  return [...lead, ...samples, ...tail];
}

/** How the given settings do on the recorded examples. */
export function scoreExamples(examples: readonly Example[], settings: Settings): ExampleScore {
  const score: ExampleScore = { shake: { hit: 0, of: 0 }, tiltUp: { hit: 0, of: 0 }, tiltDown: { hit: 0, of: 0 }, otherFired: { hit: 0, of: 0 } };
  for (const e of examples) {
    const c = countGestures(padded(e.samples), settings);
    switch (e.label) {
      case 'shake':
        score.shake.of++;
        if (c.shakes === 1) score.shake.hit++;
        break;
      case 'tiltUp':
        score.tiltUp.of++;
        if (c.upLines > 0 && c.downLines === 0 && c.shakes === 0) score.tiltUp.hit++;
        break;
      case 'tiltDown':
        score.tiltDown.of++;
        if (c.downLines > 0 && c.upLines === 0 && c.shakes === 0) score.tiltDown.hit++;
        break;
      case 'other':
        score.otherFired.of++;
        if (c.shakes > 0 || c.tiltStarts > 0) score.otherFired.hit++;
        break;
    }
  }
  return score;
}

// Derives thresholds from the user's own examples. Each limit sits between what
// the user does on purpose and what they do by accident, with a margin on the
// side of their real gestures. Nothing is applied here.
export function analyseExamples(examples: readonly Example[], base: Settings): PersonalResult {
  const before = scoreExamples(examples, base);
  const fail = (error: string): PersonalResult => ({ ok: false, proposal: null, before, after: null, warnings: [], error });
  for (const label of EXAMPLE_LABELS) {
    const have = examples.filter((e) => e.label === label).length;
    if (have < MIN_EXAMPLES[label]) return fail(`Record at least ${MIN_EXAMPLES[label]} examples of "${label}" (have ${have}).`);
  }
  const warnings: string[] = [];
  const traces = (label: ExampleLabel) => examples.filter((e) => e.label === label).map((e) => traceOf(e.samples, base));

  const shakes = traces('shake').map(shakeShape);
  if (shakes.some((s) => s === null)) return fail('One shake example has fewer than two clear swings. Record it again.');
  const sh = shakes as ShakeShape[];
  const minAmpSeen = Math.min(...sh.map((s) => s.amp));
  // A limit low enough for these shakes would fire on conversation, and the
  // shake also hides the screen while hidden, so refuse instead of guessing.
  if (minAmpSeen < PERSONAL_MIN_SHAKE_DEG / 0.8) {
    if (minAmpSeen < PERSONAL_MIN_SHAKE_DEG) return fail('Your shake examples are too small to tell apart from talking. Shake wider, about a hand width each side, and record them again.');
    warnings.push('Your shakes are small. The limit is set at the lowest safe value, so a few shakes may still be missed. Shake a little wider.');
  }
  // Small shakes get a tight margin, because a low limit lets conversation
  // through. Larger shakes keep the default limit, which they pass easily, so
  // shakes while walking are not made harder.
  const defaultMin = base.shakeMinAmpDeg / base.shakeSensitivity;
  const shakeMinAmp = Math.max(Math.min(PERSONAL_MIN_SHAKE_DEG, defaultMin), Math.min(defaultMin, minAmpSeen * 0.8));
  const sensitivity = base.shakeSensitivity;
  // Only ever loosened: a higher rate limit would mostly cost shakes while walking.
  const minRate = Math.min(base.shakeMinRateDps / sensitivity, Math.min(...sh.map((s) => s.rate)) * 0.5);
  const longestSwing = Math.max(...sh.map((s) => s.swingMs));
  const others = traces('other');
  // A slow shake rests longer at each side. Allow for the user's own speed.
  // A sine wave rests within 5 % of its swing for about 0.14 of a period at each side.
  const hz = 1000 / (2 * Math.max(...sh.map((s) => s.swingMs)));
  const plateau = Math.max(base.shakeMaxPlateauMs, (143 / hz) * 1.3);
  const pitchRatio = Math.max(base.shakeMaxPitchRatio, Math.max(...sh.map((s) => s.pitchRange / s.amp)) * 1.4);

  const tiltPart = (label: 'tiltUp' | 'tiltDown', sign: 1 | -1) => {
    const shapes = traces(label).map((tr) => tiltShape(tr, sign, 0.6));
    if (shapes.some((s) => s === null)) return null;
    const t = shapes as TiltShape[];
    return { minPeak: Math.min(...t.map((s) => s.peak)), maxPeak: Math.max(...t.map((s) => s.peak)), entry: Math.max(...t.map((s) => s.entryMs)) };
  };
  const up = tiltPart('tiltUp', 1);
  const down = tiltPart('tiltDown', -1);
  if (!up || !down) return fail('A tilt example moved the wrong way. Check the axis setup with the first wizard, then record again.');
  const otherPitch = others.length ? Math.max(...others.map((tr) => Math.max(...tr.pitch.map(Math.abs)))) : 0;
  if (otherPitch >= Math.min(up.minPeak, down.minPeak) * 0.6) warnings.push('Ordinary movement tilted your head as far as a scroll tilt. The entry speed rule still has to tell them apart.');

  const proposal = sanitizeSettings({
    ...base,
    shakeMinAmpDeg: shakeMinAmp * sensitivity,
    shakeMinRateDps: minRate * sensitivity,
    shakeMaxSwingMs: Math.max(base.shakeMaxSwingMs, longestSwing * 1.4),
    // The whole chain must fit too, or slow shakes pass every swing check and still never fire.
    shakeMaxTotalMs: Math.max(base.shakeMaxTotalMs, longestSwing * 1.4 * base.shakeSwings + base.shakeMaxDwellMs),
    shakeMaxAmpDeg: Math.max(base.shakeMaxAmpDeg, Math.max(...sh.map((s) => s.amp)) * 2),
    shakeMaxPlateauMs: plateau,
    shakeMaxPitchRatio: pitchRatio,
    tiltUpDeg: Math.min(base.tiltUpDeg, up.minPeak * 0.65),
    tiltDownDeg: Math.min(base.tiltDownDeg, down.minPeak * 0.65),
    tiltMaxDeg: Math.max(up.maxPeak, down.maxPeak) * 1.5,
    tiltEntryMaxMs: Math.min(800, Math.max(base.tiltEntryMaxMs, Math.max(up.entry, down.entry) * 1.6)),
  });
  // Replay the ordinary-motion examples. While any of them fires, raise the
  // limits step by step, never past what the user's own gestures need.
  let tuned = proposal;
  const otherOnly = examples.filter((e) => e.label === 'other');
  for (let step = 0; step < 12 && otherOnly.length && scoreExamples(otherOnly, tuned).otherFired.hit > 0; step++) {
    tuned = sanitizeSettings({
      ...tuned,
      shakeMinAmpDeg: Math.max(tuned.shakeMinAmpDeg, Math.min(tuned.shakeMinAmpDeg * 1.08, minAmpSeen * 0.9 * sensitivity)),
      tiltUpDeg: Math.min(tuned.tiltUpDeg * 1.05, up.minPeak * 0.8),
      tiltDownDeg: Math.min(tuned.tiltDownDeg * 1.05, down.minPeak * 0.8),
      shakeMaxPlateauMs: Math.max(base.shakeMaxPlateauMs, tuned.shakeMaxPlateauMs * 0.92),
    }, tuned);
  }
  if (otherOnly.length && scoreExamples(otherOnly, tuned).otherFired.hit > 0) {
    warnings.push('Some ordinary head movement still looks like a gesture. Make your shakes wider or your tilts quicker, or expect some accidental hides.');
  }
  const after = scoreExamples(examples, tuned);
  const caught = (s: ExampleScore) => s.shake.hit + s.tiltUp.hit + s.tiltDown.hit - s.otherFired.hit;
  for (const k of ['shake', 'tiltUp', 'tiltDown'] as const) {
    if (after[k].hit * 2 < after[k].of) warnings.push(`The proposal catches only ${after[k].hit} of your ${after[k].of} "${k}" examples.`);
  }
  if (caught(after) < caught(before)) warnings.push('The proposal does worse on your examples than the current settings. Keep the current settings.');
  return { ok: true, proposal: tuned, before, after, warnings };
}
