import { mulberry32 } from '../src/core/synth.ts';
import { lookSide, nod, sequence, shake, still, talking, tilt, walking, type Motion } from '../src/core/synth.ts';

// A small property-based testing helper with no dependencies. Cases come from a
// seeded generator, so every failure can be replayed exactly: the error names
// the seed. Set PROP_SEED to replay, PROP_RUNS to run more cases. List-shaped
// cases are shrunk by dropping items while the property still fails.

export class Rng {
  private readonly r: () => number;
  constructor(seed: number) { this.r = mulberry32(seed); }
  next(): number { return this.r(); }
  float(lo: number, hi: number): number { return lo + this.r() * (hi - lo); }
  int(lo: number, hi: number): number { return Math.floor(this.float(lo, hi + 1)); }
  bool(p = 0.5): boolean { return this.r() < p; }
  pick<T>(items: readonly T[]): T { return items[Math.floor(this.r() * items.length)]; }
  list<T>(min: number, max: number, item: (r: Rng) => T): T[] {
    return Array.from({ length: this.int(min, max) }, () => item(this));
  }
}

export interface PropOptions { runs?: number; seed?: number }

const envNumber = (name: string): number | undefined => {
  const v = globalThis.process?.env?.[name];
  return v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined;
};

async function fails<T>(prop: (v: T) => unknown, v: T): Promise<unknown> {
  try { await prop(v); return null; } catch (e) { return e ?? new Error('failed'); }
}

/** Runs `prop` on `runs` generated cases. Throws with the seed of the first failing case. */
export async function forAll<T>(gen: (r: Rng) => T, prop: (v: T) => unknown, o: PropOptions = {}): Promise<void> {
  const runs = envNumber('PROP_RUNS') ?? o.runs ?? 50;
  const fixed = envNumber('PROP_SEED');
  const first = o.seed ?? 1;
  for (let i = 0; i < (fixed !== undefined ? 1 : runs); i++) {
    const seed = fixed ?? first + i;
    const value = gen(new Rng(seed));
    let err = await fails(prop, value);
    if (!err) continue;
    let smallest = value;
    if (Array.isArray(value)) {
      let cur = value as unknown[];
      for (let chunk = Math.ceil(cur.length / 2); chunk >= 1; chunk = Math.floor(chunk / 2)) {
        for (let at = 0; at + chunk <= cur.length;) {
          const cand = [...cur.slice(0, at), ...cur.slice(at + chunk)];
          const e = await fails(prop, cand as T);
          if (e) { cur = cand; err = e; } else at += chunk;
        }
      }
      smallest = cur as T;
    }
    const msg = err instanceof Error ? err.message : String(err);
    const shown = JSON.stringify(smallest, (_k, v) => (typeof v === 'function' ? '[fn]' : v));
    throw new Error(`property failed for seed ${seed} (replay with PROP_SEED=${seed}): ${msg}\nsmallest case: ${shown?.slice(0, 1500)}`);
  }
}

/** A random piece of head motion, from the building blocks in synth.ts. */
export function randomMotion(r: Rng): Motion & { label: string } {
  const kind = r.pick(['still', 'tilt', 'shake', 'look', 'nod', 'walk', 'talk'] as const);
  const side = r.bool() ? 1 : -1;
  let m: Motion;
  switch (kind) {
    case 'still': m = still(r.int(100, 2500)); break;
    case 'tilt': m = tilt(side * r.float(5, 55), { rampMs: r.int(80, 1500), holdMs: r.int(0, 7000), backMs: r.int(80, 800) }); break;
    case 'shake': m = shake({ ampDeg: r.float(3, 40), hz: r.float(0.8, 4), cycles: r.float(0.5, 4), startSign: side }); break;
    case 'look': m = lookSide({ deg: side * r.float(5, 70), turnMs: r.int(80, 700), holdMs: r.int(0, 1500), backMs: r.int(80, 700) }); break;
    case 'nod': m = nod({ ampDeg: r.float(2, 25), hz: r.float(0.5, 3), cycles: r.float(0.5, 3) }); break;
    case 'walk': m = walking(r.int(1000, 8000), r.int(1, 1e6), r.float(0.3, 3)); break;
    case 'talk': m = talking(r.int(1000, 8000), r.int(1, 1e6), r.float(0.3, 3)); break;
  }
  return Object.assign(m, { label: kind });
}

export function randomMotionSeq(r: Rng, min = 1, max = 6): Motion {
  return sequence(still(1500), ...r.list(min, max, randomMotion), still(500));
}
