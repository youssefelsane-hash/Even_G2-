import type { RawSample } from './imuAdapter.ts';
import { DEFAULT_SETTINGS, type Settings } from './settings.ts';

// Synthetic head motion for tests and the phone panel. The motion models are
// guesses at what heads do. Nothing here is measured from a real G2, so a pass
// on synthetic data shows the logic works, not that the thresholds are right.

export interface Pose { pitch: number; yaw: number }
export interface Motion { durMs: number; pose(t: number): Pose }

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rng: () => number): number {
  return Math.sqrt(-2 * Math.log(rng() || 1e-12)) * Math.cos(2 * Math.PI * rng());
}

const ease = (u: number): number => { const v = Math.min(1, Math.max(0, u)); return v * v * (3 - 2 * v); };
const TWO_PI = 2 * Math.PI;
const ZERO: Pose = { pitch: 0, yaw: 0 };

// ---- Building blocks ----

export const still = (durMs: number): Motion => ({ durMs, pose: () => ZERO });

export interface TiltOptions { rampMs?: number; holdMs?: number; backMs?: number }

/** Positive degrees look up, negative look down. */
export function tilt(deg: number, { rampMs = 200, holdMs = 1500, backMs = 250 }: TiltOptions = {}): Motion {
  return {
    durMs: rampMs + holdMs + backMs,
    pose: (t) => ({
      pitch: deg * (t < rampMs + holdMs ? ease(t / rampMs) : 1 - ease((t - rampMs - holdMs) / backMs)),
      yaw: 0,
    }),
  };
}

export interface ShakeOptions { ampDeg?: number; hz?: number; cycles?: number; startSign?: 1 | -1 }

export function shake({ ampDeg = 22, hz = 2, cycles = 2, startSign = 1 }: ShakeOptions = {}): Motion {
  return {
    durMs: (cycles / hz) * 1000,
    pose: (t) => ({ pitch: 0, yaw: startSign * ampDeg * Math.sin((TWO_PI * hz * t) / 1000) }),
  };
}

export function nod({ ampDeg = 12, hz = 1.5, cycles = 2 } = {}): Motion {
  return {
    durMs: (cycles / hz) * 1000,
    pose: (t) => ({ pitch: -ampDeg * Math.sin((TWO_PI * hz * t) / 1000), yaw: 0 }),
  };
}

export function lookSide({ deg = 45, turnMs = 350, holdMs = 800, backMs = 350 } = {}): Motion {
  return {
    durMs: turnMs + holdMs + backMs,
    pose: (t) => ({
      pitch: 0,
      yaw: deg * (t < turnMs + holdMs ? ease(t / turnMs) : 1 - ease((t - turnMs - holdMs) / backMs)),
    }),
  };
}

export function sequence(...parts: Motion[]): Motion {
  const starts: number[] = [];
  let total = 0;
  for (const p of parts) { starts.push(total); total += p.durMs; }
  return {
    durMs: total,
    pose: (t) => {
      let i = parts.length - 1;
      while (i > 0 && t < starts[i]) i--;
      return parts[i].pose(Math.min(parts[i].durMs, t - starts[i]));
    },
  };
}

/** Two motions at once, e.g. a shake during a tilt. `b` starts `offsetMs` into `a`. */
export function together(a: Motion, b: Motion, offsetMs = 0): Motion {
  return {
    durMs: Math.max(a.durMs, offsetMs + b.durMs),
    pose: (t) => {
      const pa = a.pose(Math.min(t, a.durMs));
      const pb = t >= offsetMs && t <= offsetMs + b.durMs ? b.pose(t - offsetMs) : ZERO;
      return { pitch: pa.pitch + pb.pitch, yaw: pa.yaw + pb.yaw };
    },
  };
}

// ---- Background activity ----

interface Burst { start: number; motion: Motion }

function overlay(durMs: number, base: (t: number) => Pose, bursts: Burst[]): Motion {
  let first = 0; // bursts are in time order, and samples are normally read in time order
  let last = 0;
  return {
    durMs,
    pose: (t) => {
      if (t < last) first = 0;
      last = t;
      const p = base(t);
      let pitch = p.pitch;
      let yaw = p.yaw;
      while (first < bursts.length && bursts[first].start + bursts[first].motion.durMs < t) first++;
      for (let i = first; i < bursts.length && bursts[i].start <= t; i++) {
        const b = bursts[i];
        const local = t - b.start;
        if (local > b.motion.durMs) continue;
        const q = b.motion.pose(local);
        pitch += q.pitch;
        yaw += q.yaw;
      }
      return { pitch, yaw };
    },
  };
}

/** Stride bob and sway, plus glances around and down at the path. */
export function walking(durMs: number, seed = 1, intensity = 1): Motion {
  const rng = mulberry32(seed);
  const stepHz = 1.7 + rng() * 0.5;
  const phase = rng() * TWO_PI;
  const bursts: Burst[] = [];
  for (let t = 2000 + rng() * 4000; t < durMs; t += 3000 + rng() * 9000) {
    const side = rng() < 0.5 ? -1 : 1;
    const kind = rng();
    let motion: Motion;
    if (kind < 0.6) {
      motion = lookSide({ deg: side * (10 + rng() * 35) * intensity, turnMs: 300 + rng() * 450, holdMs: 300 + rng() * 1200, backMs: 300 + rng() * 450 });
    } else if (kind < 0.85) {
      motion = tilt(-(5 + rng() * 12) * intensity, { rampMs: 400 + rng() * 500, holdMs: 500 + rng() * 2000, backMs: 400 + rng() * 500 });
    } else {
      motion = sequence(
        lookSide({ deg: -(25 + rng() * 25) * intensity, turnMs: 400, holdMs: 400, backMs: 400 }),
        lookSide({ deg: (25 + rng() * 25) * intensity, turnMs: 400, holdMs: 400, backMs: 400 }),
      );
    }
    bursts.push({ start: t, motion });
  }
  const base = (t: number): Pose => {
    const w = (TWO_PI * stepHz * t) / 1000;
    return {
      pitch: intensity * (2.5 * Math.sin(w + phase) + 0.8 * Math.sin(2 * w)),
      yaw: intensity * 3 * Math.sin(w / 2 + phase),
    };
  };
  return overlay(durMs, base, bursts);
}

/** Small restless motion, emphasis nods, small side shakes and glances. */
export function talking(durMs: number, seed = 2, intensity = 1): Motion {
  const rng = mulberry32(seed);
  const f = [0.7 + rng(), 1.8 + rng(), 2.9 + rng()];
  const bursts: Burst[] = [];
  for (let t = 1000 + rng() * 2000; t < durMs; t += 800 + rng() * 3500) {
    const kind = rng();
    let motion: Motion;
    if (kind < 0.45) {
      motion = nod({ ampDeg: (4 + rng() * 7) * intensity, hz: 1.5 + rng() * 1.5, cycles: 1 + Math.floor(rng() * 3) });
    } else if (kind < 0.8) {
      motion = shake({ ampDeg: (3 + rng() * 5) * intensity, hz: 1.5 + rng() * 1.5, cycles: 1 + Math.floor(rng() * 3), startSign: rng() < 0.5 ? 1 : -1 });
    } else {
      motion = lookSide({ deg: (rng() < 0.5 ? -1 : 1) * (10 + rng() * 25) * intensity, turnMs: 300 + rng() * 300, holdMs: 200 + rng() * 900, backMs: 300 + rng() * 300 });
    }
    bursts.push({ start: t, motion });
  }
  const base = (t: number): Pose => {
    const s = t / 1000;
    return {
      pitch: intensity * (1.2 * Math.sin(TWO_PI * f[0] * s) + 0.8 * Math.sin(TWO_PI * f[1] * s)),
      yaw: intensity * (1.5 * Math.sin(TWO_PI * f[0] * 0.8 * s + 1) + 0.7 * Math.sin(TWO_PI * f[2] * s)),
    };
  };
  return overlay(durMs, base, bursts);
}

// ---- Turning motion into raw samples ----

export interface StreamOptions {
  hz?: number;
  /** Extra arrival delay, uniform between 0 and this. */
  jitterMs?: number;
  /** Chance of losing each sample. */
  dropRate?: number;
  /** Deliver this many samples at once, with the same arrival time. */
  batch?: number;
  /** Sensor noise, as a standard deviation in degrees. */
  noiseDeg?: number;
  /** Bias on the rate axes, in degrees per second. */
  rateBias?: number;
  seed?: number;
  startT?: number;
  settings?: Settings;
}

/** Produces what the SDK would deliver, for the axis mapping in `settings`. */
export function* stream(motion: Motion, o: StreamOptions = {}): Generator<RawSample> {
  const { hz = 50, jitterMs = 0, dropRate = 0, batch = 1, noiseDeg = 0.15, rateBias = 0, seed = 7, startT = 0, settings = DEFAULT_SETTINGS } = o;
  const rng = mulberry32(seed);
  const period = 1000 / hz;
  const n = Math.floor(motion.durMs / period);
  const c = settings;
  const unused = (['x', 'y', 'z'] as const).find((a) => a !== c.pitchAxis && a !== c.yawAxis)!;
  let lastArrival = startT;
  let prev = motion.pose(0);
  let pending: RawSample[] = [];

  for (let k = 0; k < n; k++) {
    const t = k * period;
    const p = motion.pose(t);
    const pitch = p.pitch + gauss(rng) * noiseDeg;
    const yaw = p.yaw + gauss(rng) * noiseDeg;
    const pv = c.imuMode === 'orientation' ? pitch : ((p.pitch - prev.pitch) / period) * 1000 + gauss(rng) * noiseDeg * 5 + rateBias;
    const yv = c.imuMode === 'orientation' ? yaw : ((p.yaw - prev.yaw) / period) * 1000 + gauss(rng) * noiseDeg * 5 + rateBias;
    prev = p;
    if (rng() < dropRate) continue;

    const raw: RawSample = { x: 0, y: 0, z: 0, t: 0 };
    raw[c.pitchAxis] = pv / (c.pitchSign * c.imuScale);
    raw[c.yawAxis] = yv / (c.yawSign * c.imuScale);
    raw[unused] = gauss(rng) * noiseDeg;
    pending.push(raw);
    if (pending.length < batch) continue;

    const arrival = Math.max(lastArrival, startT + t + rng() * jitterMs);
    lastArrival = arrival;
    for (const s of pending) { s.t = arrival; yield s; }
    pending = [];
  }
}
