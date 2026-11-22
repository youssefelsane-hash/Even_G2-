import { Assistant, type AssistantDeps } from '../src/core/assistant.ts';
import { CAPTURE_COUNTDOWN_MS, CAPTURE_DURATION_MS, type CalibrationWizard } from '../src/core/calibration.ts';
import type { RawSample } from '../src/core/imuAdapter.ts';
import { BLANK_TEXT, type DisplayPlan } from '../src/core/renderQueue.ts';
import { MemoryStore, type KeyValueStore } from '../src/core/storage.ts';
import { sequence, still, stream, type Motion, type StreamOptions } from '../src/core/synth.ts';

export function recordCalibration(wizard: CalibrationWizard, motion: Motion, options: StreamOptions = {}, extraSamples: readonly RawSample[] = []) {
  const step = wizard.captureStep()!;
  const start = (options.startT ?? 0) + CAPTURE_COUNTDOWN_MS;
  const duration = CAPTURE_DURATION_MS[step];
  const held: Motion = { durMs: duration, pose: (t) => motion.pose(Math.min(t, motion.durMs - 1)) };
  wizard.beginCapture(start - CAPTURE_COUNTDOWN_MS);
  for (const sample of extraSamples) wizard.push({ ...sample, t: start + sample.t });
  for (const sample of stream(held, { ...options, startT: start })) wizard.push(sample);
  return wizard.finishCapture(start + duration)!;
}

// Runs the whole app logic on a fake clock, recording everything sent to the lens.
export class Rig {
  time = 0;
  plans: DisplayPlan[] = [];
  forced: boolean[] = [];
  exits = 0;
  store: KeyValueStore;
  a!: Assistant;
  displayed: string[] = [];
  presence: string[] = [];
  extra: Partial<AssistantDeps>;

  constructor(store: KeyValueStore = new MemoryStore(), extra: Partial<AssistantDeps> = {}) {
    this.store = store;
    this.extra = extra;
  }

  async start(): Promise<this> {
    const deps: AssistantDeps = {
      store: this.store,
      initialSettings: { unlockGesture: 'either', tiltEnabled: true, recoveryPresses: 4 },
      now: () => this.time,
      onPlan: (p, force) => { this.plans.push(p); this.forced.push(force); },
      onExitRequest: () => this.exits++,
      onDisplayed: (id) => this.displayed.push(id),
      onPresence: (m) => this.presence.push(m),
      ...this.extra,
    };
    this.a = await Assistant.create(deps);
    return this;
  }

  /** Connected and worn, past the settle time, with neutral learned. */
  async ready(): Promise<this> {
    await this.start();
    this.a.handleConnection(true);
    this.a.handleWear(true);
    this.wait(this.a.settings.wearSettleMs + 100);
    this.play(still(1500));
    return this;
  }

  wait(ms: number): void {
    this.time += ms;
  }

  feed(samples: Iterable<RawSample>): void {
    const start = this.time;
    for (const s of samples) {
      this.time = start + s.t;
      this.a.handleImu({ ...s, t: this.time });
    }
  }

  /** Plays motion, with a short still tail so the gesture completes. */
  play(m: Motion, seed = 5): void {
    this.feed(stream(sequence(m, still(100)), { seed, settings: this.a.settings }));
  }

  /** A plan that put anything on the lens. */
  lit(plan: DisplayPlan | undefined = this.plans.at(-1)): boolean {
    return plan !== undefined && plan.kind === 'text' && plan.text !== BLANK_TEXT;
  }

  text(): string {
    const p = this.a.plan();
    return p.kind === 'text' ? p.text : '';
  }

  markPlans(): number {
    return this.plans.length;
  }

  plansSince(mark: number): DisplayPlan[] {
    return this.plans.slice(mark);
  }
}
