import type { Assistant } from './core/assistant.ts';
import { stream, type Motion } from './core/synth.ts';

// Plays synthetic motion into the app in real time, through the same entry
// point as real IMU data. Used because the simulator delivers no IMU data.
export function playMotion(assistant: Assistant, motion: Motion, now: () => number, hz = 50): Promise<void> {
  const samples = [...stream(motion, { hz, jitterMs: 5, seed: Math.floor(now()) % 100_000, settings: assistant.settings })];
  const start = now();
  let i = 0;
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const elapsed = now() - start;
      while (i < samples.length && samples[i].t <= elapsed) {
        assistant.handleImu({ ...samples[i], t: start + samples[i].t });
        i++;
      }
      if (i >= samples.length) {
        clearInterval(timer);
        resolve();
      }
    }, 10);
  });
}
