import { wrapDelta, type ImuSignal } from './imuAdapter.ts';
import type { Settings } from './settings.ts';

export type MotionWearState = 'worn' | 'removed';

// Tells from head motion whether the glasses are worn, for glasses whose wear
// report is wrong (seen on a real G2, 2026-11-14: "removed" while on the head).
// Used only when the user has turned "Trust the wear sensor" off.
//
// Off the head: either the glasses lie at an angle no head holds (folded, flat
// on a table) and stay still for 10 s, or they stay perfectly still for
// a long time. On the head there is always some motion. Picking them up again
// moves them, which counts as worn; the lens still stays hidden until a shake.
// All thresholds are guesses until real logs confirm them (EXPERIMENT NEEDED).
// Far past looking down at a desk (about 30 to 45 degrees), and still for
// longer than a reading pause. Only used with a calibrated neutral.
const ODD_ANGLE_DEG = 65;
const ODD_ANGLE_STILL_MS = 10_000;
const WAKE_WINDOW_MS = 1500;

interface Point { t: number; pitch: number; yaw: number }

const KEYS = ['imuMode', 'wrapPeriod', 'neutralPitch', 'sensorNoiseDeg', 'motionWearOffMs', 'motionWearStillDeg'] as const;

export class MotionWear {
  private cfg: Settings;
  private points: Point[] = [];
  private neutral: number | null = null;
  state: MotionWearState = 'worn';

  constructor(cfg: Settings) {
    this.cfg = cfg;
    this.reset();
  }

  /** Keeps the current state; only a change that alters the measurement restarts it. */
  configure(cfg: Settings): void {
    const changed = KEYS.some((k) => cfg[k] !== this.cfg[k]);
    this.cfg = cfg;
    if (changed) {
      this.points = [];
      this.neutral = this.calibratedNeutral();
    }
  }

  reset(): void {
    this.points = [];
    this.state = 'worn';
    this.neutral = this.calibratedNeutral();
  }

  /** Samples stopped reaching this detector (calibration, recording): the quiet time is not stillness. */
  interrupt(): void {
    this.points = [];
  }

  // Only a calibrated neutral: one learned on the fly could be the table pose.
  private calibratedNeutral(): number | null {
    return this.cfg.imuMode === 'orientation' ? this.cfg.neutralPitch : null;
  }

  private stillDeg(): number {
    return Math.max(this.cfg.motionWearStillDeg, this.cfg.sensorNoiseDeg * 8);
  }

  private delta(a: number, b: number): number {
    return this.cfg.imuMode === 'orientation' ? wrapDelta(a - b, this.cfg.wrapPeriod) : a - b;
  }

  /** Range of pitch and yaw over the samples since `from`, as the larger of the two. */
  private range(from: number): number {
    let pMin = Infinity, pMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    const ref = this.points.at(-1)!;
    for (let i = this.points.length - 1; i >= 0 && this.points[i].t >= from; i--) {
      const p = this.delta(this.points[i].pitch, ref.pitch);
      const y = this.delta(this.points[i].yaw, ref.yaw);
      pMin = Math.min(pMin, p); pMax = Math.max(pMax, p);
      yMin = Math.min(yMin, y); yMax = Math.max(yMax, y);
    }
    return Math.max(pMax - pMin, yMax - yMin);
  }

  /** Returns the new state when it changes, otherwise null. */
  push(s: ImuSignal): MotionWearState | null {
    if (s.gap) this.points = [];
    // Rate mode angles drift with any leftover bias, so stillness is judged on the rates.
    const rate = this.cfg.imuMode === 'rate';
    this.points.push({ t: s.t, pitch: rate ? s.pitchRate : s.pitch, yaw: rate ? s.yawRate : s.yaw });
    const keep = s.t - this.cfg.motionWearOffMs - 1000;
    while (this.points.length > 0 && this.points[0].t < keep) this.points.shift();
    const first = this.points[0].t;
    const still = this.stillDeg();

    if (this.state === 'removed') {
      if (s.t - first >= WAKE_WINDOW_MS / 2 && this.range(s.t - WAKE_WINDOW_MS) > Math.max(still * 3, 4)) {
        this.state = 'worn';
        this.points = this.points.slice(-1);
        return 'worn';
      }
      return null;
    }

    const odd = !rate && this.neutral !== null && Math.abs(this.delta(s.pitch, this.neutral)) > ODD_ANGLE_DEG;
    const offAfter = odd ? ODD_ANGLE_STILL_MS : this.cfg.motionWearOffMs;
    if (s.t - first >= offAfter && this.range(s.t - offAfter) <= still) {
      this.state = 'removed';
      return 'removed';
    }
    return null;
  }
}
