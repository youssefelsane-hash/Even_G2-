import { ActivityMonitor, type ActivityLevel } from './activity.ts';
import { wrapDelta, type ImuSignal } from './imuAdapter.ts';
import { ShakeDetector, type ShakeReject } from './shakeDetector.ts';
import type { Settings } from './settings.ts';

export type Direction = 'up' | 'down';
export type TiltStopReason = 'neutral' | 'overshoot' | 'hold-limit' | 'shake' | 'gap' | 'reset';

export type GestureEvent =
  /** `confidence` is 0 to 1: how clearly every limit was passed. */
  | { type: 'shake'; t: number; confidence: number }
  | { type: 'tiltStart'; t: number; direction: Direction; confidence: number }
  | { type: 'scroll'; t: number; direction: Direction; lines: number }
  | { type: 'tiltStop'; t: number; reason: TiltStopReason }
  | { type: 'neutral'; t: number; pitch: number };

export type TiltPhase = 'armed' | 'candidate' | 'active' | 'locked';

export interface EngineStatus {
  phase: TiltPhase;
  neutral: number | null;
  deviation: number | null;
  shakeSuspect: boolean;
  activity: ActivityLevel;
  /** Why the last shake-like motion did not count. */
  shakeReject: ShakeReject;
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
  private activity: ActivityMonitor;
  private peakDev = 0;

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
    this.activity = new ActivityMonitor(cfg);
    this.reacquireNeutral();
  }

  configure(cfg: Settings): void {
    this.cfg = cfg;
    this.shake.configure(cfg);
    this.activity.configure(cfg);
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
    this.activity.reset();
  }

  /** Drops anything in progress. Returns a stop event if scrolling was active. */
  reset(reason: TiltStopReason = 'reset'): GestureEvent[] {
    const out: GestureEvent[] = this.phase === 'active' ? [{ type: 'tiltStop', t: this.lastT, reason }] : [];
    this.clearTransient();
    return out;
  }

  status(t: number): EngineStatus {
    return {
      phase: this.phase,
      neutral: this.neutral,
      deviation: this.lastDev,
      shakeSuspect: this.shake.suspect(t),
      activity: this.activity.level(t),
      shakeReject: this.shake.rejected,
    };
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
    this.activity.exclude(this.enterT, t);
    this.phase = 'locked';
    this.cooldownUntil = t + this.cfg.tiltCooldownMs;
  }

  private stepTilt(s: ImuSignal, dev: number, out: GestureEvent[]): void {
    const c = this.cfg;
    const abs = Math.abs(dev);
    const dir: Direction = dev > 0 ? 'up' : 'down';
    // While walking or talking the head bobs, so a tilt must go further. The
    // raised threshold always stays below the upper limit.
    const boost = this.activity.level(s.t).tiltBoostDeg;
    const plain = this.direction === 'up' ? c.tiltUpDeg : c.tiltDownDeg;
    const threshold = Math.min(plain + boost, Math.max(plain, c.tiltMaxDeg - 2));
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
            this.peakDev = 0;
          }
        }
        return;
      case 'candidate': {
        if (abs <= c.deadZoneDeg || dir !== this.direction) { this.phase = 'armed'; return; }
        if (busy || abs > c.tiltMaxDeg) { this.phase = 'locked'; return; }
        this.peakDev = Math.max(this.peakDev, abs);
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
          out.push({ type: 'tiltStart', t: s.t, direction: this.direction, confidence: this.tiltConfidence(threshold) });
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

  // Margin over the threshold, room below the upper limit, and how fast the
  // threshold was reached compared with the allowed entry time.
  private tiltConfidence(threshold: number): number {
    const c = this.cfg;
    const over = (this.peakDev - threshold) / Math.max(1, threshold * 0.4);
    const room = (c.tiltMaxDeg - this.peakDev) / Math.max(1, (c.tiltMaxDeg - threshold) * 0.5);
    const speed = this.crossT === null ? 0 : 1 - (this.crossT - this.enterT) / c.tiltEntryMaxMs;
    const parts = [over, room, speed].map((v) => Math.min(1, Math.max(0, v)));
    const mean = parts.reduce((a, b) => a + b, 0) / parts.length;
    return Math.round((0.5 * mean + 0.5 * Math.min(...parts)) * 100) / 100;
  }

  /** Background activity right now, for the panel and the logger. */
  activityLevel(t: number): ActivityLevel {
    return this.activity.level(t);
  }

  push(s: ImuSignal): GestureEvent[] {
    const out: GestureEvent[] = [];
    const c = this.cfg;
    this.lastT = s.t;
    if (s.gap) {
      out.push(...this.reset('gap'));
      this.stillStartT = null;
      this.smooth = s.pitch;
      this.activity.interrupt();
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
    this.activity.push(s.t, s.yaw, pitch);

    // Shake is checked first and always wins over tilt.
    const inCooldown = s.t < this.shakeCooldownUntil;
    if (inCooldown) {
      this.shake.reset();
    } else {
      this.shake.setBoost(this.activity.level(s.t).shakeBoost);
      if (this.shake.push(s.t, s.yaw, pitch)) {
        if (this.phase === 'active') out.push({ type: 'tiltStop', t: s.t, reason: 'shake' });
        this.phase = 'locked';
        this.shakeCooldownUntil = s.t + c.shakeCooldownMs;
        this.activity.exclude(this.shake.chainStart - 200, s.t + c.shakeCooldownMs);
        out.push({ type: 'shake', t: s.t, confidence: this.shake.confidence });
        return out;
      }
    }

    if (this.neutral === null) return out;
    const dev = this.fromNeutral(pitch, this.neutral);
    this.lastDev = dev;
    this.stepTilt(s, dev, out);
    return out;
  }
}
