import { gravityAngle, type RawSample } from './imuAdapter.ts';
import { sanitizeSettings, type Axis, type ImuMode, type Settings } from './settings.ts';

export const CAPTURE_STEPS = ['neutral', 'tiltUp', 'tiltDown', 'shake'] as const;
type CaptureStep = typeof CAPTURE_STEPS[number];
export type WizardStep = CaptureStep | 'review' | 'done' | 'cancelled';

export const STEP_TEXT: Record<WizardStep, string> = {
  neutral: 'Hold your phone at eye level and look straight ahead. Keep your head still until recording ends.',
  tiltUp: 'Start facing forward. When recording starts, tilt your head up a little and hold it there until recording ends.',
  tiltDown: 'Return to facing forward. When recording starts, tilt your head down a little and hold it there until recording ends.',
  shake: 'Start facing forward. When recording starts, shake your head left and right three or four times, then relax.',
  review: 'All four steps passed. Press Save gestures now: tilt and shake stay off until you save or cancel.',
  done: 'Calibration saved.',
  cancelled: 'Calibration cancelled.',
};

export const CAPTURE_COUNTDOWN_MS = 3000;
export const CAPTURE_DURATION_MS: Record<CaptureStep, number> = { neutral: 4000, tiltUp: 4000, tiltDown: 4000, shake: 5000 };
const STEP_TITLES: Record<CaptureStep, string> = { neutral: 'Face forward', tiltUp: 'Tilt up', tiltDown: 'Tilt down', shake: 'Shake left and right' };
export function stepTitle(step: CaptureStep): string {
  return `${CAPTURE_STEPS.indexOf(step) + 1} / ${CAPTURE_STEPS.length} · ${STEP_TITLES[step]}`;
}

const AXES: Axis[] = ['x', 'y', 'z'];
const MIN_SAMPLES = 5;
// The wizard defines the user's comfortable tilt as this many degree-equivalents.
// That makes the thresholds work whatever unit the IMU turns out to use.
const REFERENCE_TILT = 22;

export interface StepResult { ok: boolean; error?: string; sensorIssue?: boolean }
export interface Swing { amp: number; durMs: number }
interface PitchCalibration { axis: Axis; up: number; down: number; mode: ImuMode }

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

// The real G2 sends accelerometer data: the length of x,y,z stays near 1 g
// while the head is still. Raw orientation or rate values do not.
function looksLikeGravity(samples: RawSample[]): boolean {
  const mags = samples.map((s) => Math.hypot(s.x, s.y, s.z));
  const m = mean(mags);
  return m > 0.8 && m < 1.25 && std(mags) < 0.08;
}

function toAngles(s: RawSample): RawSample {
  return { t: s.t, x: gravityAngle(s, 'x'), y: gravityAngle(s, 'y'), z: gravityAngle(s, 'z') };
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
  private capture: { start: number; end: number; samples: RawSample[] } | null = null;
  private neutral: RawSample[] = [];
  private up: RawSample[] = [];
  private pitch: PitchCalibration | null = null;
  /** The data is gravity (decided from the first step): every step is analysed as true angles in degrees. */
  private gravity = false;
  private proposed: Partial<Settings> | null = null;
  step: WizardStep = 'neutral';

  constructor(base: Settings) {
    this.base = base;
  }

  push(s: RawSample): void {
    const capture = this.capture;
    if (!capture || s.t < capture.start || s.t >= capture.end || ![s.x, s.y, s.z, s.t].every(Number.isFinite)) return;
    capture.samples.push(s);
  }

  captureStep(): CaptureStep | null {
    const step = this.step;
    return step === 'review' || step === 'done' || step === 'cancelled' ? null : step;
  }

  beginCapture(now: number): void {
    const step = this.captureStep();
    if (!step || this.capture) return;
    const start = now + CAPTURE_COUNTDOWN_MS;
    this.capture = { start, end: start + CAPTURE_DURATION_MS[step], samples: [] };
  }

  retryTiltUp(): void {
    if (this.step === 'tiltDown' && !this.capture) this.step = 'tiltUp';
  }

  interruptCapture(): boolean {
    if (!this.capture) return false;
    this.capture = null;
    return true;
  }

  captureProgress(now: number): { phase: 'countdown' | 'recording'; seconds: number } | null {
    if (!this.capture) return null;
    const { start, end } = this.capture;
    return now < start
      ? { phase: 'countdown', seconds: Math.ceil((start - now) / 1000) }
      : { phase: 'recording', seconds: Math.max(0, Math.ceil((end - now) / 1000)) };
  }

  cancel(): void {
    this.step = 'cancelled';
    this.capture = null;
    this.proposed = null;
  }

  proposal(base = this.base): Settings | null {
    return this.step === 'review' && this.proposed ? sanitizeSettings(this.proposed, base) : null;
  }

  /** Accepting is the only way the proposal leaves the wizard. */
  accept(): Settings | null {
    const proposal = this.proposal();
    if (!proposal) return null;
    this.step = 'done';
    return proposal;
  }

  /** Analyse only this recording. A rejected recording leaves its step ready to retry. */
  finishCapture(now: number): StepResult | null {
    const capture = this.capture;
    if (!capture || now < capture.end) return null;
    this.capture = null;
    const { samples, start, end } = capture;
    const maxGap = Math.max(this.base.maxGapMs, this.base.imuPace * 2 + 100);
    if (samples.length < MIN_SAMPLES || samples[0].t - start > maxGap || end - samples.at(-1)!.t > maxGap ||
      samples.some((sample, i) => i > 0 && sample.t - samples[i - 1].t > maxGap)) {
      return { ok: false, sensorIssue: true, error: 'Motion data was missing or interrupted. Keep the glasses connected and the app open, then try again.' };
    }
    if (this.step === 'neutral') this.gravity = looksLikeGravity(samples);
    const data = this.gravity ? samples.map(toAngles) : samples;
    switch (this.step) {
      case 'neutral':
        this.neutral = data;
        this.step = 'tiltUp';
        return { ok: true };
      case 'tiltUp':
        if (!this.hasTilt(data)) return { ok: false, error: 'No upward tilt was detected. Wait for “Recording”, then tilt up and hold.' };
        this.up = data;
        this.step = 'tiltDown';
        return { ok: true };
      case 'tiltDown': {
        if (!this.hasTilt(data)) return { ok: false, error: 'No downward tilt was detected. Face forward, then tilt down and hold during recording.' };
        this.pitch = this.solvePitch(data);
        if (!this.pitch) return { ok: false, error: 'The tilt did not move opposite to the previous step. Face forward, then tilt down and hold.' };
        this.step = 'shake';
        return { ok: true };
      }
      case 'shake': {
        const result = this.solve(data, this.pitch!);
        if (result.ok) this.step = 'review';
        return result;
      }
      default: return null;
    }
  }

  private sampleGap(): number {
    const t = this.neutral.map((s) => s.t);
    return t.length > 1 ? (t.at(-1)! - t[0]) / (t.length - 1) : 0;
  }

  private neutralMean(axis: Axis): number { return mean(this.neutral.map((s) => s[axis])); }
  private noise(axis: Axis): number { return std(this.neutral.map((s) => s[axis])); }

  private hasTilt(samples: RawSample[]): boolean {
    return AXES.some((axis) => {
      const neutral = this.neutralMean(axis);
      const threshold = Math.max(this.noise(axis) * 5, 1e-9);
      return samples.filter((s) => Math.abs(s[axis] - neutral) > threshold).length >= 2;
    });
  }

  private solvePitch(down: RawSample[]): PitchCalibration | null {
    const baseOf = (axis: Axis) => this.neutralMean(axis);

    // Mode: an orientation value stays away from neutral during the hold, a
    // rate value falls back towards zero once the head stops moving.
    const moved = AXES.map((a) => ({ a, p: Math.abs(peak(trace(this.up, a, baseOf(a), 'orientation'))) }))
      .sort((l, r) => r.p - l.p)[0];
    const tail = this.up.slice(Math.floor(this.up.length * 0.7)).map((s) => s[moved.a] - baseOf(moved.a));
    const mode: ImuMode = Math.abs(mean(tail)) >= 0.5 * moved.p ? 'orientation' : 'rate';

    // Pitch axis: the one that moved most across both tilts.
    const tilt = AXES.map((a) => {
      const u = peak(trace(this.up, a, baseOf(a), mode));
      const d = peak(trace(down, a, baseOf(a), mode));
      return { a, u, d, size: Math.abs(u) + Math.abs(d) };
    }).sort((l, r) => r.size - l.size)[0];
    const smaller = Math.min(Math.abs(tilt.u), Math.abs(tilt.d));
    if (tilt.u * tilt.d >= 0 || smaller < tilt.size * 0.15) return null;
    return { axis: tilt.a, up: tilt.u, down: tilt.d, mode };
  }

  private solve(shake: RawSample[], tilt: PitchCalibration): StepResult {
    const { axis, mode } = tilt;
    const baseOf = (a: Axis) => this.neutralMean(a);

    // Yaw axis: the one that moved most during the shake, leaving out pitch.
    // With gravity, the axis that carries gravity at rest (near +-90 degrees)
    // follows pitch and roll together, not the side-to-side motion.
    const others = AXES.filter((a) => a !== axis && !(this.gravity && Math.abs(baseOf(a)) > 45));
    const yaw = others.map((a) => {
      const v = trace(shake, a, baseOf(a), mode);
      return { a, v, range: Math.max(...v) - Math.min(...v) };
    }).sort((l, r) => r.range - l.range)[0];
    const noiseFloor = Math.max(this.noise(yaw.a) * 5, 1e-9);
    if (yaw.v.filter((value) => Math.abs(value) > noiseFloor).length < 2) {
      return { ok: false, error: 'No side-to-side motion was detected. Try only the shake again.' };
    }
    const times = shake.map((s) => s.t);
    // The first swing may include the user's reaction time. Measure between extrema.
    const swings = extractSwings(times, yaw.v, yaw.range * 0.25).slice(1)
      .filter((s) => s.amp >= Math.max(yaw.range * 0.3, noiseFloor) && s.durMs >= this.base.shakeMinSwingMs && s.durMs <= this.base.shakeMaxSwingMs);
    if (swings.length < 3) return { ok: false, error: 'Try three or four clear left-right shakes in a row.' };

    // Scale so the user's own tilt becomes the reference. All values below are
    // then in degree-equivalents, whatever the raw unit is.
    const upSize = Math.abs(tilt.up);
    const downSize = Math.abs(tilt.down);
    // The traces are raw values, so this factor is the whole scale. It must not
    // be multiplied by the old scale, or a second calibration compounds the first.
    // Gravity data is already in true degrees, so the thresholds stay real angles.
    const factor = this.gravity ? 1 : REFERENCE_TILT / ((upSize + downSize) / 2);
    const imuScale = factor;
    const pitchSign: 1 | -1 = tilt.up > 0 ? 1 : -1;
    const up = upSize * factor;
    const down = downSize * factor;
    const noise = this.noise(axis) * factor;

    const amps = swings.map((s) => s.amp * factor);
    const rates = swings.map((s) => ((s.amp * factor) / s.durMs) * 1000);
    const minAmp = median(amps) * 0.5;
    // Rate mode: noise is a rate, not an angle, so it must not set angle bands.
    const angleNoise = mode === 'orientation' ? noise : 0;
    // Noise may widen the dead zone, but never past the point where the tilt the
    // user just showed could no longer reach the threshold.
    const deadZoneDeg = Math.min(Math.max(Math.min(up, down) * 0.3, angleNoise * 4), Math.min(up, down) * 0.35);

    this.proposed = {
      imuMode: mode,
      pitchAxis: axis,
      yawAxis: yaw.a,
      pitchSign,
      yawSign: 1,
      imuScale,
      gravityAngles: this.gravity,
      // True degrees: the calibrated neutral is taken facing forward, but the
      // real resting pose sits 10 to 25 degrees lower (G2 logs, 2026-11-14).
      neutralMaxShiftDeg: this.gravity ? Math.max(this.base.neutralMaxShiftDeg, 30) : this.base.neutralMaxShiftDeg,
      // The wrap period is stored scaled. Gravity angles never wrap inside +-90 degrees.
      wrapPeriod: this.gravity ? 360 : (this.base.wrapPeriod / this.base.imuScale) * factor,
      rateBiasPitch: mode === 'rate' ? baseOf(axis) * pitchSign * imuScale : 0,
      rateBiasYaw: mode === 'rate' ? baseOf(yaw.a) * imuScale : 0,
      neutralPitch: mode === 'orientation' ? baseOf(axis) * pitchSign * imuScale : null,
      deadZoneDeg,
      tiltUpDeg: up * 0.65,
      tiltDownDeg: down * 0.65,
      tiltHysteresisDeg: Math.min(up, down) * 0.15,
      // Measured noise sets what counts as holding still, so a noisy sensor can
      // still learn neutral and settle into a tilt.
      sensorNoiseDeg: Math.min(angleNoise, Math.min(up, down) * 0.05),
      stillnessDeg: Math.min(Math.max(this.base.stillnessDeg, angleNoise * 6), Math.min(up, down) * 0.3),
      // Many samples apart at a slow rate: smooth a little more to steady the reading.
      smoothingMs: Math.max(this.base.smoothingMs, Math.min(150, this.sampleGap() * 1.2)),
      tiltMaxDeg: Math.max(up, down) * 1.7,
      shakeMinAmpDeg: minAmp,
      shakeMaxAmpDeg: Math.max(...amps) * 2.5,
      shakeReversalDeg: minAmp * 0.3,
      shakeSuspectDeg: minAmp * 0.5,
      shakeMinRateDps: median(rates) * 0.4,
    };
    // The saved thresholds must sit inside the tilts the user just made, or tilt
    // could never fire. sanitizeSettings can raise them, so check after it.
    const p = sanitizeSettings(this.proposed, this.base);
    if (p.tiltUpDeg > up * 0.9 || p.tiltDownDeg > down * 0.9) {
      this.proposed = null;
      this.step = 'neutral';
      return { ok: false, error: 'The sensor was too unsteady for these tilts. Start again: hold very still in step 1, then tilt a little further.' };
    }
    return { ok: true };
  }
}
