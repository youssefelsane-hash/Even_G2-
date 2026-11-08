import { Assistant, type AssistantDeps } from '../src/core/assistant.ts';
import type { RawSample } from '../src/core/imuAdapter.ts';
import { BLANK_TEXT, type DisplayPlan } from '../src/core/renderQueue.ts';
import { MemoryStore, type KeyValueStore } from '../src/core/storage.ts';
import { sequence, still, stream, type Motion } from '../src/core/synth.ts';

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
