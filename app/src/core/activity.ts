import type { Settings } from './settings.ts';

// Measures how much the head is moving in the background (walking, talking),
// so the gesture engine can ask for a bigger, clearer gesture while the head is
// busy. It looks at short time buckets: the range of yaw and pitch inside each
// 500 ms bucket. A range does not depend on the sample rate, unlike a sum of
// sample-to-sample steps, which grows with sensor noise at high rates.
//
// Two rules keep a deliberate gesture from raising its own bar:
// - Only buckets that ended at least `activityDelayMs` ago count, so a shake in
//   progress is not part of the measurement.
// - Buckets that overlap a recognised gesture are left out, so a shake to hide
//   does not make the shake to show harder.
// A high percentile (not the mean) is used, so one failed attempt does not move
// the level much, while talking, which moves the head about half the time, does.

export type ActivityConfig = Pick<Settings,
  'activityAware' | 'activityWindowMs' | 'activityDelayMs' | 'activityQuietDeg' | 'activityFullDeg' |
  'activityShakeBoost' | 'activityTiltBoostDeg'>;

export type ActivityLabel = 'still' | 'moving' | 'busy';

export interface ActivityLevel {
  /** Typical yaw range per bucket, in degree-equivalents. */
  yaw: number;
  /** Typical pitch range per bucket. */
  pitch: number;
  /** Multiplier for the minimum shake swing, 1 or more. */
  shakeBoost: number;
  /** Degrees added to the tilt thresholds, 0 or more. */
  tiltBoostDeg: number;
  label: ActivityLabel;
  /** Buckets the level is based on. Below MIN_BUCKETS no boost is applied. */
  buckets: number;
}

interface Bucket { start: number; end: number; yawMin: number; yawMax: number; pitchMin: number; pitchMax: number; yaw0: number; yaw1: number; pitch0: number; pitch1: number; excluded: boolean }

// Range inside each bucket minus a steady drift. A gyro bias in rate mode moves
// the integrated angle the same way in every bucket without any back and forth,
// which is not background motion. Only a drift that every bucket shares counts
// as one (the smallest of their slopes); real movement such as talking turns
// both ways, so nothing is taken off it.
function wobble(use: Bucket[], axis: 'yaw' | 'pitch'): number[] {
  const slopes = use.map((b) => {
    const d = b.end - b.start;
    return d > 0 ? ((axis === 'yaw' ? b.yaw1 - b.yaw0 : b.pitch1 - b.pitch0) / d) : 0;
  });
  const shared = slopes.every((v) => v > 0) || slopes.every((v) => v < 0);
  const slope = shared ? Math.min(...slopes.map(Math.abs)) : 0;
  return use.map((b) => Math.max(0, (axis === 'yaw' ? b.yawMax - b.yawMin : b.pitchMax - b.pitchMin) - slope * (b.end - b.start)));
}

export const BUCKET_MS = 500;
const MIN_BUCKETS = 4;
const PERCENTILE = 0.6;
// Pitch moves less than yaw in both activity models, and a tilt needs less help.
const PITCH_WEIGHT = 1.5;

const NONE: ActivityLevel = { yaw: 0, pitch: 0, shakeBoost: 1, tiltBoostDeg: 0, label: 'still', buckets: 0 };

function percentile(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

export class ActivityMonitor {
  private cfg: ActivityConfig;
  private buckets: Bucket[] = [];
  private cur: Bucket | null = null;
  private exclusions: [number, number][] = [];
  private cache: { t: number; level: ActivityLevel } | null = null;

  constructor(cfg: ActivityConfig) {
    this.cfg = cfg;
  }

  configure(cfg: ActivityConfig): void {
    this.cfg = cfg;
    this.cache = null;
  }

  reset(): void {
    this.buckets = [];
    this.cur = null;
    this.exclusions = [];
    this.cache = null;
  }

  /** Drop the current bucket only, for example after a gap in the data. */
  interrupt(): void {
    this.cur = null;
  }

  push(t: number, yaw: number, pitch: number): void {
    let b = this.cur;
    if (b && t >= b.start + BUCKET_MS) {
      b.end = t;
      this.close(b);
      b = null;
    }
    if (!b) {
      b = { start: t, end: t, yawMin: yaw, yawMax: yaw, pitchMin: pitch, pitchMax: pitch, yaw0: yaw, yaw1: yaw, pitch0: pitch, pitch1: pitch, excluded: false };
      this.cur = b;
    }
    b.end = t;
    b.yaw1 = yaw;
    b.pitch1 = pitch;
    if (yaw < b.yawMin) b.yawMin = yaw;
    if (yaw > b.yawMax) b.yawMax = yaw;
    if (pitch < b.pitchMin) b.pitchMin = pitch;
    if (pitch > b.pitchMax) b.pitchMax = pitch;
  }

  private close(b: Bucket): void {
    b.excluded = this.exclusions.some(([s, e]) => b.start <= e && b.end >= s);
    this.buckets.push(b);
    const keepFrom = b.end - this.cfg.activityWindowMs - this.cfg.activityDelayMs - BUCKET_MS;
    while (this.buckets.length && this.buckets[0].end < keepFrom) this.buckets.shift();
    this.exclusions = this.exclusions.filter(([, e]) => e >= keepFrom);
    this.cache = null;
  }

  /** A recognised gesture ran from `start` to `end`. Its buckets are not background. */
  exclude(start: number, end: number): void {
    this.exclusions.push([start, end]);
    for (const b of this.buckets) if (b.start <= end && b.end >= start) b.excluded = true;
    if (this.cur && this.cur.start <= end) this.cur.excluded = true;
    this.cache = null;
  }

  level(t: number): ActivityLevel {
    const c = this.cfg;
    if (!c.activityAware) return NONE;
    // The level only changes as buckets close or slide out, so a quarter-second
    // resolution is plenty and keeps the cost per sample small.
    const key = Math.floor(t / 250);
    if (this.cache && this.cache.t === key) return this.cache.level;
    const from = t - c.activityDelayMs - c.activityWindowMs;
    const to = t - c.activityDelayMs;
    const use = this.buckets.filter((b) => !b.excluded && b.start >= from && b.end <= to);
    let level = NONE;
    if (use.length >= MIN_BUCKETS) {
      const yaw = percentile(wobble(use, 'yaw'), PERCENTILE);
      const pitch = percentile(wobble(use, 'pitch'), PERCENTILE);
      const span = Math.max(c.activityFullDeg - c.activityQuietDeg, 1e-6);
      const ys = clamp01((yaw - c.activityQuietDeg) / span);
      const ps = clamp01((pitch * PITCH_WEIGHT - c.activityQuietDeg) / span);
      const score = Math.max(ys, ps);
      level = {
        yaw,
        pitch,
        shakeBoost: 1 + (c.activityShakeBoost - 1) * ys,
        tiltBoostDeg: c.activityTiltBoostDeg * ps,
        label: score <= 0 ? 'still' : score < 0.5 ? 'moving' : 'busy',
        buckets: use.length,
      };
    }
    this.cache = { t: key, level };
    return level;
  }
}
