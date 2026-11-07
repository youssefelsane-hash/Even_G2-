import type { RawSample } from './imuAdapter.ts';
import { sanitizeSettings, type Axis, type ImuMode, type Settings } from './settings.ts';

export type WizardStep = 'neutral' | 'tiltUp' | 'tiltDown' | 'shake' | 'review' | 'done' | 'cancelled';

export const STEP_TEXT: Record<WizardStep, string> = {
  neutral: 'Look straight ahead and hold still, then press Next.',
  tiltUp: 'Tilt your head up as you would to scroll, hold it there, then press Next while still holding.',
  tiltDown: 'Tilt your head down as you would to scroll, hold it there, then press Next while still holding.',
  shake: 'Shake your head left and right a few times, then press Next.',
  review: 'Check the proposed values, then accept or cancel.',
  done: 'Calibration saved.',
  cancelled: 'Calibration cancelled. Nothing was changed.',
};

const AXES: Axis[] = ['x', 'y', 'z'];
const MIN_SAMPLES = 5;
// The wizard defines the user's comfortable tilt as this many degree-equivalents.
// That makes the thresholds work whatever unit the IMU turns out to use.
const REFERENCE_TILT = 22;

export interface StepResult { ok: boolean; error?: string }
export interface Swing { amp: number; durMs: number }

function mean(v: number[]): number {
  return v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function std(v: number[]): number {
  const m = mean(v);
  return Math.sqrt(mean(v.map((x) => (x - m) ** 2)));
}

// A motion trace on one axis, relative to the neutral value. In rate mode the
// trace is the integral, so both modes yield an angle-like signal.
function trace(samples: RawSample[], axis: Axis, base: number, mode: ImuMode): number[] {
  if (mode === 'orientation') return samples.map((s) => s[axis] - base);
  const out: number[] = [];
  let angle = 0;
  for (let i = 0; i < samples.length; i++) {
    const dt = i ? (samples[i].t - samples[i - 1].t) / 1000 : 0;
    angle += (samples[i][axis] - base) * dt;
    out.push(angle);
  }
  return out;
}

function peak(v: number[]): number {
  return v.reduce((best, x) => (Math.abs(x) > Math.abs(best) ? x : best), 0);
}

/** Alternating swings of a trace, ignoring reversals smaller than `reversal`. */
export function extractSwings(t: number[], v: number[], reversal: number): Swing[] {
  const swings: Swing[] = [];
  if (v.length < 2) return swings;
  let dir = 0;
  let ext = v[0];
  let extT = t[0];
  let anchor = v[0];
  let anchorT = t[0];
  for (let i = 1; i < v.length; i++) {
    if (dir === 0) {
      if (Math.abs(v[i] - anchor) >= reversal) { dir = Math.sign(v[i] - anchor); ext = v[i]; extT = t[i]; }
    } else if ((v[i] - ext) * dir >= 0) {
      ext = v[i];
      extT = t[i];
    } else if ((ext - v[i]) * dir >= reversal) {
      swings.push({ amp: Math.abs(ext - anchor), durMs: extT - anchorT });
      anchor = ext;
      anchorT = extT;
      dir = -dir;
      ext = v[i];
      extT = t[i];
    }
  }
  if (dir !== 0) swings.push({ amp: Math.abs(ext - anchor), durMs: extT - anchorT });
  return swings;
}

// Works from raw samples, so it can find the axis mapping, sign and mode itself
// on real glasses, where none of them are documented. It only proposes values:
// nothing changes until the user accepts.
export class CalibrationWizard {
  private readonly base: Settings;
  private buffer: RawSample[] = [];
  private neutral: RawSample[] = [];
  private up: RawSample[] = [];
  private down: RawSample[] = [];
  private proposed: Settings | null = null;
  step: WizardStep = 'neutral';

  constructor(base: Settings) {
    this.base = base;
  }

  push(s: RawSample): void {
    if (![s.x, s.y, s.z, s.t].every(Number.isFinite)) return; // one NaN would turn every mean into NaN
    if (this.step === 'neutral' || this.step === 'tiltUp' || this.step === 'tiltDown' || this.step === 'shake') {
      this.buffer.push(s);
    }
  }

  cancel(): void {
    this.step = 'cancelled';
    this.proposed = null;
  }

  proposal(): Settings | null {
    return this.step === 'review' ? this.proposed : null;
  }

  /** Accepting is the only way the proposal leaves the wizard. */
  accept(): Settings | null {
    if (this.step !== 'review' || !this.proposed) return null;
    this.step = 'done';
    return this.proposed;
  }

  /** Close the current step and analyse it. On error the step restarts. */
  next(): StepResult {
    const samples = this.buffer;
    this.buffer = [];
    if (this.step === 'review' || this.step === 'done' || this.step === 'cancelled') return { ok: false, error: 'Nothing to capture in this step.' };
    if (samples.length < MIN_SAMPLES) return { ok: false, error: 'Too few IMU samples. Check that the glasses are sending data.' };
    switch (this.step) {
      case 'neutral':
        this.neutral = samples;
        this.step = 'tiltUp';
        return { ok: true };
      case 'tiltUp':
        this.up = samples;
        this.step = 'tiltDown';
        return { ok: true };
      case 'tiltDown':
        this.down = samples;
        this.step = 'shake';
        return { ok: true };
      case 'shake': {
        const result = this.solve(samples);
        if (result.ok) this.step = 'review';
        return result;
      }
    }
  }

  private solve(shake: RawSample[]): StepResult {
    const baseOf = (a: Axis) => mean(this.neutral.map((s) => s[a]));
    const noiseOf = (a: Axis) => std(this.neutral.map((s) => s[a]));

    // Mode: an orientation value stays away from neutral during the hold, a
    // rate value falls back towards zero once the head stops moving.
    const moved = AXES.map((a) => ({ a, p: Math.abs(peak(trace(this.up, a, baseOf(a), 'orientation'))) }))
      .sort((l, r) => r.p - l.p)[0];
    if (moved.p <= Math.max(noiseOf(moved.a) * 5, 1e-9)) return { ok: false, error: 'No head tilt was detected. Repeat the tilt steps.' };
    const tail = this.up.slice(Math.floor(this.up.length * 0.7)).map((s) => s[moved.a] - baseOf(moved.a));
    const mode: ImuMode = Math.abs(mean(tail)) >= 0.5 * moved.p ? 'orientation' : 'rate';

    // Pitch axis: the one that moved most across both tilts.
    const tilt = AXES.map((a) => {
      const u = peak(trace(this.up, a, baseOf(a), mode));
      const d = peak(trace(this.down, a, baseOf(a), mode));
      return { a, u, d, size: Math.abs(u) + Math.abs(d) };
    }).sort((l, r) => r.size - l.size)[0];
    if (Math.sign(tilt.u) === Math.sign(tilt.d)) return { ok: false, error: 'Up and down tilts looked the same. Repeat the tilt steps.' };

    // Yaw axis: the one that moved most during the shake, leaving out pitch.
    const others = AXES.filter((a) => a !== tilt.a);
    const yaw = others.map((a) => {
      const v = trace(shake, a, baseOf(a), mode);
      return { a, v, range: Math.max(...v) - Math.min(...v) };
    }).sort((l, r) => r.range - l.range)[0];
    if (yaw.range <= Math.max(noiseOf(yaw.a) * 5, 1e-9)) return { ok: false, error: 'No head shake was detected. Repeat the shake.' };
    const times = shake.map((s) => s.t);
    const swings = extractSwings(times, yaw.v, yaw.range * 0.25).filter((s) => s.amp >= yaw.range * 0.3 && s.durMs > 0);
    if (swings.length < 3) return { ok: false, error: 'Too few left-right swings. Shake a little longer.' };

    // Scale so the user's own tilt becomes the reference. All values below are
    // then in degree-equivalents, whatever the raw unit is.
    const upSize = Math.abs(tilt.u);
    const downSize = Math.abs(tilt.d);
    // The traces are raw values, so this factor is the whole scale. It must not
    // be multiplied by the old scale, or a second calibration compounds the first.
    const factor = REFERENCE_TILT / ((upSize + downSize) / 2);
    const imuScale = factor;
    const pitchSign: 1 | -1 = tilt.u > 0 ? 1 : -1;
    const up = upSize * factor;
    const down = downSize * factor;
    const noise = noiseOf(tilt.a) * factor;

    const amps = swings.map((s) => s.amp * factor);
    const rates = swings.map((s) => ((s.amp * factor) / s.durMs) * 1000);
    const minAmp = median(amps) * 0.5;
    const deadZoneDeg = Math.max(Math.min(up, down) * 0.3, noise * 4);

    this.proposed = sanitizeSettings({
      ...this.base,
      imuMode: mode,
      pitchAxis: tilt.a,
      yawAxis: yaw.a,
      pitchSign,
      yawSign: 1,
      imuScale,
      wrapPeriod: (this.base.wrapPeriod / this.base.imuScale) * factor, // the wrap period is stored scaled
      rateBiasPitch: mode === 'rate' ? baseOf(tilt.a) * pitchSign * imuScale : 0,
      rateBiasYaw: mode === 'rate' ? baseOf(yaw.a) * imuScale : 0,
      neutralPitch: mode === 'orientation' ? baseOf(tilt.a) * pitchSign * imuScale : null,
      deadZoneDeg,
      tiltUpDeg: up * 0.65,
      tiltDownDeg: down * 0.65,
      tiltHysteresisDeg: Math.min(up, down) * 0.15,
      tiltMaxDeg: Math.max(up, down) * 1.7,
      shakeMinAmpDeg: minAmp,
      shakeMaxAmpDeg: Math.max(...amps) * 2.5,
      shakeReversalDeg: minAmp * 0.3,
      shakeSuspectDeg: minAmp * 0.5,
      shakeMinRateDps: median(rates) * 0.4,
    });
    return { ok: true };
  }
}
