import type { Assistant } from './core/assistant.ts';
import { stream, type Motion } from './core/synth.ts';
import { holdClock } from './devClock.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Plays synthetic motion into the app through the same entry point as real IMU
// data (the simulator delivers none). All samples go in at once with the app
// clock held at each sample's time; then it waits until the wall clock reaches
// the end before releasing the clock. Feeding on a timer broke when the WebView
// throttled timers: a late timer looked like a sensor gap mid-shake.
// App time never jumps backwards or runs ahead of the wall clock.
export async function playMotion(assistant: Assistant, motion: Motion, now: () => number, hz = 50): Promise<void> {
  const start = Math.max(now(), Date.now());
  let end = start;
  try {
    for (const s of stream(motion, { hz, jitterMs: 5, seed: Math.floor(start) % 100_000, settings: assistant.settings })) {
      end = start + s.t;
      holdClock(end);
      assistant.handleImu({ ...s, t: end });
    }
    await sleep(Math.max(0, end - Date.now()) + 5);
  } finally {
    holdClock(null);
  }
}
