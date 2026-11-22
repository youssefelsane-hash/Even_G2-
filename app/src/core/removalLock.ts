import type { RawSample } from './imuAdapter.ts';

// Locks the lens within about a second of the glasses coming off the head,
// from the raw G2 gravity vector alone. The host's wear report cannot do this:
// on 2026-11-22 a real G2 sent nothing when the glasses came off the head or went
// back on (only the case was reported), and after the case its isWearing stuck at
// false while worn. The firmware itself blanks the display ~1.2 s after
// removal, then restores the plug-in's last frame on re-wear. So the plug-in
// must already be locked by then.
//
// Gravity per axis, in g, from that log (10 Hz, worn and still: x +0.05,
// y -0.19, z +0.98):
// - Worn, any head pose seen (looking down, up ~40 degrees, shaking no): |y| <= 0.40, z >= 0.70.
// - Taken off by hand: the frame rolls on its side or tips over within a second
//   (y -0.76 / -0.91, z down to 0.03), or it is lifted and laid flat on a table
//   (x +0.04, y -0.05, z +1.00), perfectly still.
//
// Two rules, each firing only on a change, so a pose that persists (lying on
// one side in bed, and unlocking there) does not lock again and again:
// 1. Odd pose: rolled past |y| > 0.6 or tipped to z < 0.25, held 300 ms,
//    entered from a head pose within the last 3 s.
// 2. Flat and still: |x|, |y| < 0.10 and z > 0.98, with every axis inside a
//    0.03 band for 1.5 s. Worn glasses at rest hang about 0.2 g off flat.
// Both only lock, never unlock. Unlocking stays the user's tap sequence.
const ODD_ROLL_G = 0.6;
const ODD_TIP_Z_G = 0.25;
const ODD_HOLD_MS = 300;
const HEAD_RECENT_MS = 3000;
const FLAT_XY_G = 0.10;
const FLAT_Z_G = 0.98;
const STILL_BAND_G = 0.03;
const FLAT_STILL_MS = 1500;
const MAX_GAP_MS = 1000;

export type RemovalReason = 'odd-pose' | 'flat-still';

interface G { t: number; x: number; y: number; z: number }

export class RemovalLock {
  private lastHeadT = -Infinity;
  private oddSince: number | null = null;
  private oddFired = false;
  private flat: G[] = [];
  private flatFired = false;
  private lastT = -Infinity;

  reset(): void {
    this.lastHeadT = -Infinity;
    this.oddSince = null;
    this.oddFired = false;
    this.flat = [];
    this.flatFired = false;
    this.lastT = -Infinity;
  }

  /** Returns a reason when the glasses have just been taken off, otherwise null. */
  push(raw: RawSample): RemovalReason | null {
    const { t } = raw;
    if (!Number.isFinite(t) || ![raw.x, raw.y, raw.z].every(Number.isFinite)) return null;
    const m = Math.hypot(raw.x, raw.y, raw.z);
    // Not a gravity reading (free fall, a hard knock, or a different unit): skip it.
    if (m < 0.5 || m > 1.6) return null;
    if (t - this.lastT > MAX_GAP_MS) {
      // After a gap the history says nothing about now.
      this.oddSince = null;
      this.flat = [];
    }
    this.lastT = t;
    const g: G = { t, x: raw.x / m, y: raw.y / m, z: raw.z / m };

    const odd = Math.abs(g.y) > ODD_ROLL_G || g.z < ODD_TIP_Z_G;
    let reason: RemovalReason | null = null;
    if (odd) {
      if (this.oddSince === null) this.oddSince = t;
      const enteredFromHead = this.oddSince - this.lastHeadT <= HEAD_RECENT_MS;
      if (!this.oddFired && enteredFromHead && t - this.oddSince >= ODD_HOLD_MS) {
        this.oddFired = true;
        reason = 'odd-pose';
      }
    } else {
      this.oddSince = null;
      this.oddFired = false;
      const headLike = Math.abs(g.y) <= 0.45 && g.z >= 0.6;
      if (headLike) this.lastHeadT = t;
    }

    const flat = Math.abs(g.x) < FLAT_XY_G && Math.abs(g.y) < FLAT_XY_G && g.z > FLAT_Z_G;
    if (!flat) {
      this.flat = [];
      this.flatFired = false;
      return reason;
    }
    this.flat.push(g);
    while (this.flat.length > 0 && this.flat[0].t < t - FLAT_STILL_MS) this.flat.shift();
    if (!this.flatFired && this.flat.length > 1 && t - this.flat[0].t >= FLAT_STILL_MS - 150) {
      const band = (k: 'x' | 'y' | 'z') => Math.max(...this.flat.map((p) => p[k])) - Math.min(...this.flat.map((p) => p[k]));
      if (band('x') <= STILL_BAND_G && band('y') <= STILL_BAND_G && band('z') <= STILL_BAND_G) {
        this.flatFired = true;
        reason ??= 'flat-still';
      }
    }
    // Moving while flat (picked up, nudged) re-arms the rule.
    if (this.flatFired && this.flat.length > 1) {
      const last = this.flat[this.flat.length - 2];
      if (Math.abs(g.x - last.x) + Math.abs(g.y - last.y) + Math.abs(g.z - last.z) > STILL_BAND_G * 2) {
        this.flat = [g];
        this.flatFired = false;
      }
    }
    return reason;
  }
}
