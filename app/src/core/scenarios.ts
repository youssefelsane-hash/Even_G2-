import { GestureEngine, type GestureEvent } from './gestureEngine.ts';
import { ImuAdapter, type RawSample } from './imuAdapter.ts';
import type { Settings } from './settings.ts';
import { lookSide, nod, sequence, shake, still, talking, tilt, together, walking, type Motion } from './synth.ts';

export interface GestureCounts {
  shakes: number;
  tiltStarts: number;
  upLines: number;
  downLines: number;
  events: GestureEvent[];
}

/** Runs the adapter and gesture engine alone, with no app state around them. */
export function countGestures(samples: Iterable<RawSample>, settings: Settings, keepEvents = false): GestureCounts {
  const adapter = new ImuAdapter(settings);
  const engine = new GestureEngine(settings);
  const c: GestureCounts = { shakes: 0, tiltStarts: 0, upLines: 0, downLines: 0, events: [] };
  for (const raw of samples) {
    const s = adapter.push(raw);
    if (!s) continue;
    for (const e of engine.push(s)) {
      if (keepEvents) c.events.push(e);
      if (e.type === 'shake') c.shakes++;
      else if (e.type === 'tiltStart') c.tiltStarts++;
      else if (e.type === 'scroll') {
        if (e.direction === 'up') c.upLines += e.lines;
        else c.downLines += e.lines;
      }
    }
  }
  return c;
}

export interface Scenario {
  name: string;
  /** Short label for the phone panel. */
  label: string;
  motion(seed: number): Motion;
  expect: { shakes: number; up: boolean; down: boolean };
}

const settle = (...parts: Motion[]): Motion => sequence(still(1500), ...parts, still(800));
const none = { shakes: 0, up: false, down: false };

export const SCENARIOS: Scenario[] = [
  { name: 'tilt-up', label: 'Tilt up', motion: () => settle(tilt(24)), expect: { shakes: 0, up: true, down: false } },
  { name: 'tilt-down', label: 'Tilt down', motion: () => settle(tilt(-26)), expect: { shakes: 0, up: false, down: true } },
  { name: 'shake', label: 'Shake', motion: () => settle(shake()), expect: { shakes: 1, up: false, down: false } },
  { name: 'shake-left-first', label: 'Shake (left first)', motion: () => settle(shake({ startSign: -1 })), expect: { shakes: 1, up: false, down: false } },
  { name: 'looking-sideways', label: 'Look sideways', motion: () => settle(lookSide(), still(600), lookSide({ deg: -50 })), expect: none },
  { name: 'quick-glance', label: 'Quick glance', motion: () => settle(lookSide({ deg: 35, turnMs: 220, holdMs: 200, backMs: 220 })), expect: none },
  { name: 'check-both-ways', label: 'Check both ways', motion: () => settle(lookSide({ deg: -50, turnMs: 380, holdMs: 350, backMs: 380 }), lookSide({ deg: 50, turnMs: 380, holdMs: 350, backMs: 380 })), expect: none },
  { name: 'quick-looks-with-pauses', label: 'Quick looks with pauses', motion: () => settle(lookSide({ deg: -30, turnMs: 180, holdMs: 400, backMs: 180 }), lookSide({ deg: 30, turnMs: 180, holdMs: 400, backMs: 180 }), lookSide({ deg: -30, turnMs: 180, holdMs: 400, backMs: 180 })), expect: none },
  { name: 'diagonal-glance', label: 'Glance down and sideways', motion: () => settle(together(lookSide({ deg: 40, turnMs: 250, holdMs: 1200, backMs: 300 }), tilt(-24, { rampMs: 250, holdMs: 1200, backMs: 300 }))), expect: none },
  { name: 'nodding', label: 'Nodding', motion: () => settle(nod(), still(500), nod({ ampDeg: 18, hz: 2, cycles: 3 })), expect: none },
  { name: 'reading-slow-look-down', label: 'Slow look down to read', motion: () => settle(tilt(-30, { rampMs: 1500, holdMs: 10_000, backMs: 1200 })), expect: none },
  { name: 'look-far-down', label: 'Look far down', motion: () => settle(tilt(-50, { rampMs: 450, holdMs: 6000, backMs: 500 })), expect: none },
  { name: 'small-no', label: 'Small "no" while talking', motion: () => settle(shake({ ampDeg: 8, hz: 2.5, cycles: 3 })), expect: none },
  { name: 'shake-during-tilt', label: 'Shake while tilted', motion: () => settle(together(tilt(-24, { holdMs: 3000 }), shake(), 1200)), expect: { shakes: 1, up: false, down: true } },
  { name: 'tilt-during-shake', label: 'Tilt starts during shake', motion: () => settle(together(shake({ cycles: 3 }), tilt(-20, { rampMs: 150, holdMs: 900, backMs: 150 }), 150)), expect: { shakes: 1, up: false, down: false } },
  { name: 'shake-while-walking', label: 'Shake while walking', motion: (seed) => together(walking(9000, seed), settle(still(2500), shake({ ampDeg: 24 }))), expect: { shakes: 1, up: false, down: false } },
  { name: 'walking', label: 'Walking 30 s', motion: (seed) => walking(30_000, seed), expect: none },
  { name: 'talking', label: 'Talking 30 s', motion: (seed) => talking(30_000, seed), expect: none },
];

export function scenario(name: string): Scenario {
  const s = SCENARIOS.find((x) => x.name === name);
  if (!s) throw new Error(`no scenario ${name}`);
  return s;
}
