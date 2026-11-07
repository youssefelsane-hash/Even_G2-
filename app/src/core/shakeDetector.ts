import type { Settings } from './settings.ts';

export type ShakeConfig = Pick<Settings,
  'shakeSensitivity' | 'shakeSwings' | 'shakeMinAmpDeg' | 'shakeMaxAmpDeg' | 'shakeReversalDeg' |
  'shakeSuspectDeg' | 'shakeMinSwingMs' | 'shakeMaxSwingMs' | 'shakeMaxDwellMs' | 'shakeMaxTotalMs' |
  'shakeMinRateDps' | 'shakeMaxPitchRatio' | 'shakeAmpRatio' | 'shakeGuardMs'>;

export interface Swing { startT: number; endT: number; amp: number; dwellMs: number }

// Finds a deliberate left-right shake: a chain of alternating yaw swings, each
// with limited amplitude and timing. Works on turning points of the yaw angle,
// so it needs no fixed sample rate and no noisy derivative.
export class ShakeDetector {
  private cfg: ShakeConfig;
  private dir: 0 | 1 | -1 = 0;
  private anchorYaw = 0;
  private anchorT = 0;
  private swingStartT = 0;
  private extYaw = 0;
  private extT = 0;
  private nearExtT = 0;
  private swings: Swing[] = [];
  private pitchMin = Infinity;
  private pitchMax = -Infinity;
  private started = false;
  private busyUntil = -Infinity;

  constructor(cfg: ShakeConfig) {
    this.cfg = cfg;
  }

  configure(cfg: ShakeConfig): void {
    this.cfg = cfg;
    this.reset();
  }

  reset(): void {
    this.started = false;
    this.dir = 0;
    this.swings = [];
    this.pitchMin = Infinity;
    this.pitchMax = -Infinity;
    this.busyUntil = -Infinity;
  }

  /** True while the yaw motion could be the start of a shake. Tilt must wait. */
  suspect(t: number): boolean {
    return t < this.busyUntil;
  }

  private minAmp(): number { return this.cfg.shakeMinAmpDeg / this.cfg.shakeSensitivity; }
  private minRate(): number { return this.cfg.shakeMinRateDps / this.cfg.shakeSensitivity; }

  private swingOk(amp: number, durMs: number): boolean {
    const c = this.cfg;
    return amp >= this.minAmp() && amp <= c.shakeMaxAmpDeg &&
      durMs >= c.shakeMinSwingMs && durMs <= c.shakeMaxSwingMs &&
      durMs > 0 && (amp / durMs) * 1000 >= this.minRate();
  }

  private ratioOk(a: number, b: number): boolean {
    return Math.max(a, b) / Math.min(a, b) <= this.cfg.shakeAmpRatio;
  }

  private clearChain(pitch: number): void {
    this.swings = [];
    this.pitchMin = pitch;
    this.pitchMax = pitch;
  }

  private closeSwing(pitch: number): void {
    const c = this.cfg;
    const swing: Swing = {
      startT: this.swingStartT,
      endT: this.extT,
      amp: Math.abs(this.extYaw - this.anchorYaw),
      dwellMs: this.swingStartT - this.anchorT,
    };
    if (!this.swingOk(swing.amp, swing.endT - swing.startT)) {
      this.clearChain(pitch);
      return;
    }
    const prev = this.swings[this.swings.length - 1];
    if (prev && (swing.dwellMs > c.shakeMaxDwellMs || !this.ratioOk(prev.amp, swing.amp))) {
      this.clearChain(pitch);
    }
    this.swings.push(swing);
  }

  private shouldFire(t: number): boolean {
    const c = this.cfg;
    if (this.dir === 0 || this.swings.length < c.shakeSwings - 1) return false;
    const amp = Math.abs(this.extYaw - this.anchorYaw);
    if (!this.swingOk(amp, this.extT - this.swingStartT)) return false;
    const last = this.swings[this.swings.length - 1];
    if (this.swingStartT - this.anchorT > c.shakeMaxDwellMs || !this.ratioOk(last.amp, amp)) return false;
    if (t - this.swings[0].startT > c.shakeMaxTotalMs) return false;
    const amps = this.swings.reduce((sum, s) => sum + s.amp, amp);
    const meanAmp = amps / (this.swings.length + 1);
    return this.pitchMax - this.pitchMin <= c.shakeMaxPitchRatio * meanAmp;
  }

  /** Feed one sample. Returns true when a complete shake was just recognised. */
  push(t: number, yaw: number, pitch: number): boolean {
    const c = this.cfg;
    if (!this.started) {
      this.started = true;
      this.anchorYaw = yaw;
      this.anchorT = t;
      this.swingStartT = t;
      this.dir = 0;
      this.clearChain(pitch);
    }
    this.pitchMin = Math.min(this.pitchMin, pitch);
    this.pitchMax = Math.max(this.pitchMax, pitch);

    if (this.dir === 0) {
      const d = yaw - this.anchorYaw;
      if (Math.abs(d) >= c.shakeReversalDeg) {
        this.dir = d > 0 ? 1 : -1;
        this.extYaw = yaw;
        this.extT = t;
        this.nearExtT = t;
      } else {
        this.swingStartT = t;
        if (t - this.anchorT > c.shakeMaxDwellMs) {
          this.anchorYaw = yaw;
          this.anchorT = t;
          this.clearChain(pitch);
        }
      }
    } else if ((yaw - this.extYaw) * this.dir >= 0) {
      this.extYaw = yaw;
      this.extT = t;
      this.nearExtT = t;
    } else {
      const back = (this.extYaw - yaw) * this.dir;
      if (back < c.shakeReversalDeg / 2) this.nearExtT = t;
      if (back >= c.shakeReversalDeg) {
        this.closeSwing(pitch);
        this.anchorYaw = this.extYaw;
        this.anchorT = this.extT;
        this.swingStartT = this.nearExtT;
        this.dir = this.dir === 1 ? -1 : 1;
        this.extYaw = yaw;
        this.extT = t;
        this.nearExtT = t;
      }
    }

    if (this.dir !== 0) {
      const amp = Math.abs(this.extYaw - this.anchorYaw);
      const dur = this.extT - this.swingStartT;
      const fast = dur <= 0 || (amp / dur) * 1000 >= this.minRate() / 2;
      if (amp >= c.shakeSuspectDeg && dur <= c.shakeMaxSwingMs && fast) this.busyUntil = t + c.shakeGuardMs;
    }

    if (this.shouldFire(t)) {
      this.started = false;
      this.swings = [];
      return true;
    }
    return false;
  }
}
