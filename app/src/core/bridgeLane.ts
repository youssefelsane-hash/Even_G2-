import type { KeyValueStore } from './storage.ts';

// The plugin guide warns that concurrent render and storage calls can crash the
// connection, and that one flaky hop can hang for about 30 s (everything-evenhub
// glasses-ui skill, Best Practices). So every call goes through this lane: one
// at a time, each with a time limit, and display calls ahead of anything waiting.
interface Job {
  send(): Promise<unknown>;
  resolve(value: unknown): void;
  reject(reason: unknown): void;
}

export class BridgeLane {
  private readonly timeoutMs: number;
  private urgent: Job[] = [];
  private normal: Job[] = [];
  private busy = false;

  constructor(timeoutMs = 2500) {
    this.timeoutMs = timeoutMs;
  }

  run<T>(send: () => Promise<T>, urgent = false): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      (urgent ? this.urgent : this.normal).push({ send, resolve: resolve as (v: unknown) => void, reject });
      this.next();
    });
  }

  private next(): void {
    if (this.busy) return;
    const job = this.urgent.shift() ?? this.normal.shift();
    if (!job) return;
    this.busy = true;
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return; // a call that timed out can still answer later
      settled = true;
      clearTimeout(timer);
      this.busy = false;
      settle();
      this.next();
    };
    const timer = setTimeout(() => finish(() => job.reject(new Error('bridge call timed out'))), this.timeoutMs);
    try {
      job.send().then((v) => finish(() => job.resolve(v)), (e) => finish(() => job.reject(e)));
    } catch (e) {
      finish(() => job.reject(e));
    }
  }
}

export interface StorageBridge {
  getLocalStorage(key: string): Promise<string>;
  setLocalStorage(key: string, value: string): Promise<boolean>;
}

export class BridgeStore implements KeyValueStore {
  private readonly bridge: StorageBridge;
  private readonly lane: BridgeLane;

  constructor(bridge: StorageBridge, lane: BridgeLane) {
    this.bridge = bridge;
    this.lane = lane;
  }

  async get(key: string): Promise<string | null> {
    return (await this.lane.run(() => this.bridge.getLocalStorage(key))) || null;
  }

  set(key: string, value: string): Promise<boolean> {
    return this.lane.run(() => this.bridge.setLocalStorage(key, value));
  }
}
