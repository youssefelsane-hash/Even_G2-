import type { Axis, Settings } from './settings.ts';

// One IMU report. `t` is the time the sample ARRIVED on the phone, in ms: the
// SDK gives no device timestamp, so jitter, gaps and batches must be expected.
export interface RawSample { x: number; y: number; z: number; t: number }

// Head motion in app terms. Positive pitch means head up.
export interface ImuSignal {
  t: number;
  dt: number;
  pitch: number;
  yaw: number;
  pitchRate: number;
  yawRate: number;
  /** A gap came before this sample: rates are zero and in-progress gestures must be dropped. */
  gap: boolean;
}

// Protobuf drops zero values and the SDK keeps a missing axis as undefined, so a
// missing axis means 0. A report with no axes at all is not a sample: a sudden
// all-zero reading would look like a huge jump in orientation mode.
export function toRawSample(data: { x?: number; y?: number; z?: number } | null | undefined, t: number): RawSample | null {
  if (!data || (data.x === undefined && data.y === undefined && data.z === undefined)) return null;
  return { x: data.x ?? 0, y: data.y ?? 0, z: data.z ?? 0, t };
}

export type AdapterConfig = Pick<Settings,
  'imuMode' | 'pitchAxis' | 'yawAxis' | 'pitchSign' | 'yawSign' | 'imuScale' |
  'rateBiasPitch' | 'rateBiasYaw' | 'wrapPeriod' | 'maxGapMs' | 'batchGapMs'>;

export interface AdapterStats { accepted: number; rejected: number; gaps: number; batched: number; hz: number | null }

const RATE_WINDOW = 33;
const MIN_RATE_SAMPLES = 8;
// Faster than any head. In rate mode one such glitch would shift the integrated
// angle for good; in orientation mode unwrapping already bounds a glitch.
const MAX_RATE_DPS = 5000;

/** A difference between two angles, folded into one wrap period. */
export function wrapDelta(delta: number, period: number): number {
  if (period <= 0) return delta;
  return ((((delta + period / 2) % period) + period) % period) - period / 2;
}

// Turns raw {x,y,z,t} into pitch/yaw signals. The meaning of x/y/z is not
// documented, so axis, sign, scale and mode are all configuration.
//   orientation: values are angles; rates come from differentiation.
//   rate:        values are angular rates; angles come from integration.
export class ImuAdapter {
  private cfg: AdapterConfig;
  private arrivals: number[] = [];
  private lastArrival: number | null = null;
  private lastOut = 0;
  private lastPitchRaw = 0;
  private lastYawRaw = 0;
  private pitch = 0;
  private yaw = 0;
  private counts = { accepted: 0, rejected: 0, gaps: 0, batched: 0 };

  constructor(cfg: AdapterConfig) {
    this.cfg = cfg;
  }

  configure(cfg: AdapterConfig): void {
    this.cfg = cfg;
    this.reset();
  }

  reset(): void {
    this.arrivals = [];
    this.lastArrival = null;
    this.pitch = 0;
    this.yaw = 0;
  }

  /** Mean sample period from arrival count over time, so batching cannot fool it. */
  private period(): number | null {
    const a = this.arrivals;
    if (a.length < MIN_RATE_SAMPLES) return null;
    const span = a[a.length - 1] - a[0];
    return span > 0 ? span / (a.length - 1) : null;
  }

  stats(): AdapterStats {
    const p = this.period();
    return { ...this.counts, hz: p === null ? null : 1000 / p };
  }

  private read(raw: RawSample, axis: Axis, sign: 1 | -1): number {
    return raw[axis] * sign * this.cfg.imuScale;
  }

  push(raw: RawSample): ImuSignal | null {
    if (![raw.x, raw.y, raw.z, raw.t].every(Number.isFinite)) {
      this.counts.rejected++;
      return null;
    }
    const c = this.cfg;
    const p = this.read(raw, c.pitchAxis, c.pitchSign);
    const y = this.read(raw, c.yawAxis, c.yawSign);
    // The raw values were finite, but scaling can still overflow.
    const absurd = c.imuMode === 'rate' && Math.max(Math.abs(p - c.rateBiasPitch), Math.abs(y - c.rateBiasYaw)) > MAX_RATE_DPS;
    if (!Number.isFinite(p) || !Number.isFinite(y) || absurd) {
      this.counts.rejected++;
      return null;
    }
    this.counts.accepted++;

    if (this.lastArrival === null) {
      this.lastArrival = raw.t;
      this.lastOut = raw.t;
      this.arrivals = [raw.t];
      this.lastPitchRaw = p;
      this.lastYawRaw = y;
      this.pitch = c.imuMode === 'orientation' ? p : 0;
      this.yaw = c.imuMode === 'orientation' ? y : 0;
      return { t: raw.t, dt: 0, pitch: this.pitch, yaw: this.yaw, pitchRate: 0, yawRate: 0, gap: true };
    }

    const arrival = Math.max(raw.t, this.lastArrival); // never let the clock run backwards
    const rawDt = arrival - this.lastArrival;
    this.lastArrival = arrival;
    const gap = rawDt > c.maxGapMs;

    let t: number;
    if (gap) {
      this.counts.gaps++;
      this.arrivals = [];
      t = Math.max(arrival, this.lastOut + 1);
    } else if (rawDt < c.batchGapMs || arrival <= this.lastOut) {
      // Part of a batch: the sample really happened earlier than it arrived.
      // Spread it out by the known period to keep rates sensible.
      this.counts.batched++;
      t = this.lastOut + (this.period() ?? Math.max(c.batchGapMs, 1));
    } else {
      t = arrival;
    }
    this.arrivals.push(arrival);
    if (this.arrivals.length > RATE_WINDOW) this.arrivals.shift();

    const dt = t - this.lastOut;
    this.lastOut = t;

    let pitchRate = 0;
    let yawRate = 0;
    if (c.imuMode === 'orientation') {
      const dp = wrapDelta(p - this.lastPitchRaw, c.wrapPeriod);
      const dy = wrapDelta(y - this.lastYawRaw, c.wrapPeriod);
      this.pitch += dp;
      this.yaw += dy;
      if (!gap) {
        pitchRate = (dp / dt) * 1000;
        yawRate = (dy / dt) * 1000;
      }
    } else if (!gap) {
      pitchRate = p - c.rateBiasPitch;
      yawRate = y - c.rateBiasYaw;
      this.pitch += (pitchRate * dt) / 1000;
      this.yaw += (yawRate * dt) / 1000;
    }
    this.lastPitchRaw = p;
    this.lastYawRaw = y;
    return { t, dt, pitch: this.pitch, yaw: this.yaw, pitchRate, yawRate, gap };
  }
}
