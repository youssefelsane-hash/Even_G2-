import { wrapDelta, type ImuSignal } from './imuAdapter.ts';
import { ShakeDetector } from './shakeDetector.ts';
import type { Settings } from './settings.ts';

export type Direction = 'up' | 'down';
export type TiltStopReason = 'neutral' | 'overshoot' | 'hold-limit' | 'shake' | 'gap' | 'reset';

export type GestureEvent =
  | { type: 'shake'; t: number }
  | { type: 'tiltStart'; t: number; direction: Direction }
  | { type: 'scroll'; t: number; direction: Direction; lines: number }
  | { type: 'tiltStop'; t: number; reason: TiltStopReason }
  | { type: 'neutral'; t: number; pitch: number };

export type TiltPhase = 'armed' | 'candidate' | 'active' | 'locked';

export interface EngineStatus {
  phase: TiltPhase;
  neutral: number | null;
  deviation: number | null;
  shakeSuspect: boolean;
}

// Turns pitch/yaw signals into gestures.
//
// Tilt is built to ignore ordinary looking down (risk 5). To scroll, the pitch
// must leave the dead zone, reach the threshold quickly, stay inside the
// allowed band for the minimum time and not coincide with yaw motion. A slow
// look down, a look far down, or a pose held past the hold limit locks tilt
// until the head has come back to neutral.
export class GestureEngine {
  private cfg: Settings;
  private shake: ShakeDetector;

  private smooth: number | null = null;
  private neutral: number | null = null;
  private stillStartT: number | null = null;
  private stillMin = 0;
  private stillMax = 0;
  private stillSum = 0;
  private stillCount = 0;
  private acquired = false;

  private phase: TiltPhase = 'locked';
  private direction: Direction = 'up';
  private enterT = 0;
  private crossT: number | null = null;
  private holdStartT = 0;
  private lines = 0;
  private cooldownUntil = -Infinity;
  private shakeCooldownUntil = -Infinity;
  private lastDev: number | null = null;
  private lastT = 0;

  constructor(cfg: Settings) {
    this.cfg = cfg;
    this.shake = new ShakeDetector(cfg);
    this.reacquireNeutral();
  }

  configure(cfg: Settings): void {
    this.cfg = cfg;
    this.shake.configure(cfg);
    this.reacquireNeutral();
  }

  /** Start over after a wear change or restart. Rate mode has no absolute angle to reuse. */
  reacquireNeutral(): void {
    const c = this.cfg;
    this.neutral = c.imuMode === 'orientation' ? c.neutralPitch : null;
    this.acquired = false;
    this.stillStartT = null;
    this.clearTransient();
  }

  private clearTransient(): void {
    this.smooth = null;
    this.phase = 'locked';
    this.crossT = null;
    this.lastDev = null;
    this.shake.reset();
  }

  /** Drops anything in progress. Returns a stop event if scrolling was active. */
  reset(reason: TiltStopReason = 'reset'): GestureEvent[] {
    const out: GestureEvent[] = this.phase === 'active' ? [{ type: 'tiltStop', t: this.lastT, reason }] : [];
    this.clearTransient();
    return out;
  }

  status(t: number): EngineStatus {
    return { phase: this.phase, neutral: this.neutral, deviation: this.lastDev, shakeSuspect: this.shake.suspect(t) };
  }

  // Angles from different sessions can sit on opposite sides of the wrap point.
  private fromNeutral(pitch: number, neutral: number): number {
    return this.cfg.imuMode === 'orientation' ? wrapDelta(pitch - neutral, this.cfg.wrapPeriod) : pitch - neutral;
  }

  private updateNeutral(s: ImuSignal, pitch: number, out: GestureEvent[]): void {
    const c = this.cfg;
    if (this.stillStartT === null) {
      this.stillStartT = s.t;
      this.stillMin = this.stillMax = pitch;
      this.stillSum = this.stillCount = 0;
    }
    this.stillMin = Math.min(this.stillMin, pitch);
    this.stillMax = Math.max(this.stillMax, pitch);
    this.stillSum += pitch;
    this.stillCount++;
    if (this.stillMax - this.stillMin > c.stillnessDeg) {
      this.stillStartT = null;
    } else if (!this.acquired && s.t - this.stillStartT >= c.neutralAcquireMs) {
      const mean = this.stillSum / this.stillCount;
      const stored = c.imuMode === 'orientation' ? c.neutralPitch : null;
      // A stored neutral survives a moment of looking down at boot.
      if (stored === null || Math.abs(this.fromNeutral(mean, stored)) <= c.neutralMaxShiftDeg) {
        this.neutral = mean;
        this.acquired = true;
        out.push({ type: 'neutral', t: s.t, pitch: mean });
      } else {
        this.stillStartT = null;
      }
    }
    // Slow posture change. Never while a tilt is forming or active.
    if (this.neutral !== null && (this.phase === 'armed' || this.phase === 'locked')) {
      const dev = this.fromNeutral(pitch, this.neutral);
      if (Math.abs(dev) < c.driftWindowDeg) this.neutral += dev * (1 - Math.exp(-s.dt / c.driftTauMs));
    }
  }

  private stop(t: number, reason: TiltStopReason, out: GestureEvent[]): void {
    out.push({ type: 'tiltStop', t, reason });
    this.phase = 'locked';
    this.cooldownUntil = t + this.cfg.tiltCooldownMs;
  }

  private stepTilt(s: ImuSignal, dev: number, out: GestureEvent[]): void {
    const c = this.cfg;
    const abs = Math.abs(dev);
    const dir: Direction = dev > 0 ? 'up' : 'down';
    const threshold = this.direction === 'up' ? c.tiltUpDeg : c.tiltDownDeg;
    const busy = this.shake.suspect(s.t);

    switch (this.phase) {
      case 'locked':
        if (abs <= c.deadZoneDeg && s.t >= this.cooldownUntil && s.t >= this.shakeCooldownUntil) this.phase = 'armed';
        return;
      case 'armed':
        if (abs > c.deadZoneDeg) {
          if (!c.tiltEnabled || busy) {
            this.phase = 'locked';
          } else {
            this.phase = 'candidate';
            this.direction = dir;
            this.enterT = s.t;
            this.crossT = null;
          }
        }
        return;
      case 'candidate': {
        if (abs <= c.deadZoneDeg || dir !== this.direction) { this.phase = 'armed'; return; }
        if (busy || abs > c.tiltMaxDeg) { this.phase = 'locked'; return; }
        if (this.crossT === null) {
          if (abs >= threshold) this.crossT = s.t;
          else if (s.t - this.enterT > c.tiltEntryMaxMs) this.phase = 'locked';
          return;
        }
        if (abs < threshold - c.tiltHysteresisDeg) { this.phase = 'locked'; return; }
        if (s.t - this.crossT >= c.tiltMinDurationMs) {
          this.phase = 'active';
          this.holdStartT = s.t;
          this.lines = 0;
          out.push({ type: 'tiltStart', t: s.t, direction: this.direction });
          out.push({ type: 'scroll', t: s.t, direction: this.direction, lines: 1 });
        }
        return;
      }
      case 'active': {
        if (abs < threshold - c.tiltHysteresisDeg || dir !== this.direction) { this.stop(s.t, 'neutral', out); return; }
        if (abs > c.tiltMaxDeg) { this.stop(s.t, 'overshoot', out); return; }
        if (s.t - this.holdStartT >= c.tiltMaxHoldMs) { this.stop(s.t, 'hold-limit', out); return; }
        if (busy) return; // pause, do not move the text under a possible shake
        this.lines += (c.scrollLinesPerSec * Math.min(s.dt, 250)) / 1000;
        const whole = Math.floor(this.lines);
        if (whole > 0) {
          this.lines -= whole;
          out.push({ type: 'scroll', t: s.t, direction: this.direction, lines: whole });
        }
        return;
      }
    }
  }

  push(s: ImuSignal): GestureEvent[] {
    const out: GestureEvent[] = [];
    const c = this.cfg;
    this.lastT = s.t;
    if (s.gap) {
      out.push(...this.reset('gap'));
      this.stillStartT = null;
      this.smooth = s.pitch;
      if (c.imuMode === 'rate') {
        // Integration stopped during the gap, but the head did not.
        this.neutral = null;
        this.acquired = false;
      }
      return out;
    }
    const alpha = c.smoothingMs > 0 ? 1 - Math.exp(-s.dt / c.smoothingMs) : 1;
    this.smooth = this.smooth === null ? s.pitch : this.smooth + (s.pitch - this.smooth) * alpha;
    const pitch = this.smooth;
    this.updateNeutral(s, pitch, out);

    // Shake is checked first and always wins over tilt.
    const inCooldown = s.t < this.shakeCooldownUntil;
    if (inCooldown) {
      this.shake.reset();
    } else if (this.shake.push(s.t, s.yaw, pitch)) {
      if (this.phase === 'active') out.push({ type: 'tiltStop', t: s.t, reason: 'shake' });
      this.phase = 'locked';
      this.shakeCooldownUntil = s.t + c.shakeCooldownMs;
      out.push({ type: 'shake', t: s.t });
      return out;
    }

    if (this.neutral === null) return out;
    const dev = this.fromNeutral(pitch, this.neutral);
    this.lastDev = dev;
    this.stepTilt(s, dev, out);
    return out;
  }
}
