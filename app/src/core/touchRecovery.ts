// A double press counts as two, because the firmware reports it as one event.
// A pause longer than `gapMs` (0 = no limit) starts the count again, so a
// wrong number of taps simply expires and the user taps the pattern afresh.
export class PressCounter {
  private readonly needed: () => number;
  private readonly windowMs: () => number;
  private readonly gapMs: () => number;
  private presses: number[] = [];

  constructor(needed: () => number, windowMs: () => number, gapMs: () => number = () => 0) {
    this.needed = needed;
    this.windowMs = windowMs;
    this.gapMs = gapMs;
  }

  /** Returns true when this press completes the pattern. */
  press(now: number, count = 1): boolean {
    this.count(now);
    for (let i = 0; i < count; i++) this.presses.push(now);
    if (this.count(now) < this.needed()) return false;
    this.clear();
    return true;
  }

  count(now: number): number {
    const gap = this.gapMs();
    const last = this.presses.at(-1);
    if (gap > 0 && last !== undefined && now - last > gap) this.presses = [];
    this.presses = this.presses.filter((t) => now - t <= this.windowMs());
    return this.presses.length;
  }

  clear(): void {
    this.presses = [];
  }
}
