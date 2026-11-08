import type { Settings } from './settings.ts';

export type ShakeConfig = Pick<Settings,
  'shakeSensitivity' | 'shakeSwings' | 'shakeMinAmpDeg' | 'shakeMaxAmpDeg' | 'shakeReversalDeg' |
  'shakeSuspectDeg' | 'shakeMinSwingMs' | 'shakeMaxSwingMs' | 'shakeMaxDwellMs' | 'shakeMaxTotalMs' |
  'shakeMinRateDps' | 'shakeMaxPitchRatio' | 'shakeAmpRatio' | 'shakeGuardMs' |
  'shakeMaxPlateauMs' | 'shakePlateauFrac'>;

export interface Swing { startT: number; endT: number; amp: number; dwellMs: number; plateauMs: number }

/** Why the last candidate chain was dropped. For the phone panel and tests. */
export type ShakeReject = 'none' | 'swing' | 'dwell' | 'plateau' | 'ratio';

interface Point { t: number; y: number }

const MAX_HISTORY = 1000;
const PLATEAU_PER_SWING = 0.45;
// The swing-based limit grows to at most this many times shakeMaxPlateauMs, so long slow turns with a rest stay rejected.
const PLATEAU_GROWTH_MAX = 1.4;
const dur = (s: Swing): number => s.endT - s.startT;
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

// Finds a deliberate left-right shake: a chain of alternating yaw swings, each
// with limited amplitude and timing. Works on turning points of the yaw angle,
// so it needs no fixed sample rate and no noisy derivative.
//
// Quick left-right looks are the known false fire: turn, rest a moment, turn
// back. A shake reverses at once. So the time spent resting near each turning
// point (the plateau) is measured, with interpolated crossing times so it does
// not depend on where the highest sample happened to fall, and a chain with a
// long plateau is not a shake.
export class ShakeDetector {
  private cfg: ShakeConfig;
  private dir: 0 | 1 | -1 = 0;
  private anchorYaw = 0;
  private anchorT = 0;
  private anchorPlateau = Infinity;
  private swingStartT = 0;
  private extYaw = 0;
  private extT = 0;
  private nearExtT = 0;
  private swings: Swing[] = [];
  private pitchMin = Infinity;
  private pitchMax = -Infinity;
  private started = false;
  private busyUntil = -Infinity;
  private hist: Point[] = [];
  private boost = 1;
  private lastConfidence = 0;
  private lastChainStart = 0;
  rejected: ShakeReject = 'none';

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
    this.hist = [];
    this.anchorPlateau = Infinity;
    this.pitchMin = Infinity;
    this.pitchMax = -Infinity;
    this.busyUntil = -Infinity;
  }

  /** Multiplies the minimum swing. The engine raises it while the head is busy. */
  setBoost(boost: number): void {
    this.boost = Number.isFinite(boost) && boost >= 1 ? boost : 1;
  }

  /** True while the yaw motion could be the start of a shake. Tilt must wait. */
  suspect(t: number): boolean {
    return t < this.busyUntil;
  }

  /** 0 to 1: how clearly the last recognised shake passed every limit. */
  get confidence(): number { return this.lastConfidence; }

  /** Start time of the first swing of the last recognised shake. */
  get chainStart(): number { return this.lastChainStart; }

  // The boost never lifts the minimum past 80 % of the maximum swing, or a busy
  // head could not shake at all, and the lens could not be hidden or shown.
  private minAmp(): number {
    const plain = this.cfg.shakeMinAmpDeg / this.cfg.shakeSensitivity;
    return Math.min(plain * this.boost, Math.max(plain, this.cfg.shakeMaxAmpDeg * 0.8));
  }
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

  // Below about 12 samples a second a crossing cannot be placed better than one
  // sample period, so one period of slack is allowed there. Faster data needs
  // none: interpolation is accurate enough, and slack would let glances through.
  //
  // A slow shake also rests longer at each side: a sine spends about 0.29 of a
  // swing within 5 % of its turning point. So the limit grows with the swing
  // that led into the turning point. A glance rests on top of its own turn, so
  // it still stands out.
  private plateauLimit(swingInMs = 0): number {
    const h = this.hist;
    const period = h.length > 1 ? (h[h.length - 1].t - h[0].t) / (h.length - 1) : 0;
    const own = Math.min(PLATEAU_PER_SWING * swingInMs, this.cfg.shakeMaxPlateauMs * PLATEAU_GROWTH_MAX);
    return Math.max(this.cfg.shakeMaxPlateauMs, own) + (period >= 80 ? period : 0);
  }

  private clearChain(pitch: number, why: ShakeReject): void {
    if (this.swings.length) this.rejected = why;
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
      plateauMs: this.anchorPlateau,
    };
    if (!this.swingOk(swing.amp, swing.endT - swing.startT)) {
      this.clearChain(pitch, 'swing');
      return;
    }
    const prev = this.swings[this.swings.length - 1];
    if (prev) {
      if (swing.dwellMs > c.shakeMaxDwellMs) this.clearChain(pitch, 'dwell');
      else if (swing.plateauMs > this.plateauLimit(dur(prev))) this.clearChain(pitch, 'plateau');
      else if (!this.ratioOk(prev.amp, swing.amp)) this.clearChain(pitch, 'ratio');
    }
    this.swings.push(swing);
  }

  // Time spent within a small band of the turning point `ext`, reached by a
  // swing in direction `into` with amplitude `amp`. Crossing times are
  // interpolated between samples.
  private plateauAt(ext: number, extT: number, into: 1 | -1, amp: number): number {
    const h = this.hist;
    const band = this.cfg.shakePlateauFrac * amp;
    const level = ext - into * band;
    const inside = (p: Point): boolean => (ext - p.y) * into <= band;
    const cross = (a: Point, b: Point): number => {
      const d = b.y - a.y;
      return d === 0 ? b.t : a.t + ((level - a.y) / d) * (b.t - a.t);
    };
    let entry: number | null = null;
    let exit: number | null = null;
    for (let i = 0; i < h.length; i++) {
      const p = h[i];
      if (entry === null) {
        if (inside(p)) entry = i > 0 ? cross(h[i - 1], p) : p.t;
      } else if (p.t > extT && !inside(p)) {
        exit = cross(h[i - 1], p);
        break;
      }
    }
    if (entry === null) return 0;
    return Math.max(0, (exit ?? h[h.length - 1].t) - entry);
  }

  private shouldFire(t: number): boolean {
    const c = this.cfg;
    if (this.dir === 0 || this.swings.length < c.shakeSwings - 1) return false;
    const amp = Math.abs(this.extYaw - this.anchorYaw);
    if (!this.swingOk(amp, this.extT - this.swingStartT)) return false;
    const last = this.swings[this.swings.length - 1];
    if (this.swingStartT - this.anchorT > c.shakeMaxDwellMs || !this.ratioOk(last.amp, amp)) return false;
    if (this.anchorPlateau > this.plateauLimit(dur(last))) return false;
    if (t - this.swings[0].startT > c.shakeMaxTotalMs) return false;
    const amps = this.swings.reduce((sum, s) => sum + s.amp, amp);
    const meanAmp = amps / (this.swings.length + 1);
    if (this.pitchMax - this.pitchMin > c.shakeMaxPitchRatio * meanAmp) return false;
    this.lastConfidence = this.score(meanAmp, amp);
    this.lastChainStart = this.swings[0].startT;
    return true;
  }

  // Each part is 0 at its limit and 1 with a comfortable margin. The weakest
  // part counts most, because one limit nearly failing is what makes a gesture doubtful.
  private score(meanAmp: number, lastAmp: number): number {
    const c = this.cfg;
    const all = [...this.swings.map((s) => s.amp), lastAmp];
    const rates = this.swings.map((s) => (s.amp / Math.max(1, s.endT - s.startT)) * 1000);
    // Each plateau as a fraction of its own limit.
    const plateaus = [...this.swings.slice(1).map((s, i) => s.plateauMs / this.plateauLimit(dur(this.swings[i]))), this.anchorPlateau / this.plateauLimit(dur(this.swings[this.swings.length - 1]))].filter(Number.isFinite);
    const worstRatio = all.slice(1).reduce((w, a, i) => Math.max(w, Math.max(a, all[i]) / Math.min(a, all[i])), 1);
    const parts = [
      clamp01((meanAmp / this.minAmp() - 1) / 0.6),
      clamp01((Math.min(...rates) / this.minRate() - 1) / 1.5),
      clamp01(1 - (this.pitchMax - this.pitchMin) / (c.shakeMaxPitchRatio * meanAmp)),
      plateaus.length ? clamp01(1 - Math.max(...plateaus)) : 1,
      c.shakeAmpRatio > 1 ? clamp01(1 - (worstRatio - 1) / (c.shakeAmpRatio - 1)) : 1,
    ];
    const mean = parts.reduce((a, b) => a + b, 0) / parts.length;
    return Math.round((0.5 * mean + 0.5 * Math.min(...parts)) * 100) / 100;
  }

  private remember(t: number, yaw: number): void {
    this.hist.push({ t, y: yaw });
    if (this.hist.length > MAX_HISTORY) this.hist.splice(0, this.hist.length - MAX_HISTORY);
  }

  private trimHistory(from: number): void {
    let i = 0;
    while (i < this.hist.length - 1 && this.hist[i].t < from) i++;
    if (i) this.hist.splice(0, i);
  }

  /** Feed one sample. Returns true when a complete shake was just recognised. */
  push(t: number, yaw: number, pitch: number): boolean {
    const c = this.cfg;
    if (!this.started) {
      this.started = true;
      this.anchorYaw = yaw;
      this.anchorT = t;
      this.anchorPlateau = Infinity;
      this.swingStartT = t;
      this.dir = 0;
      this.hist = [];
      this.clearChain(pitch, 'none');
    }
    this.remember(t, yaw);
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
          this.anchorPlateau = Infinity;
          this.trimHistory(t);
          this.clearChain(pitch, 'none');
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
        const into = this.dir;
        const plateau = this.plateauAt(this.extYaw, this.extT, into, Math.abs(this.extYaw - this.anchorYaw));
        this.anchorYaw = this.extYaw;
        this.anchorT = this.extT;
        this.anchorPlateau = plateau;
        this.trimHistory(this.extT);
        this.swingStartT = this.nearExtT;
        this.dir = into === 1 ? -1 : 1;
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
      this.rejected = 'none';
      return true;
    }
    return false;
  }
}
