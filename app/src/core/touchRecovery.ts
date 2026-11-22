// A double press counts as two, because the firmware reports it as one event.
export class PressCounter {
  private readonly needed: () => number;
  private readonly windowMs: () => number;
  private presses: number[] = [];

  constructor(needed: () => number, windowMs: () => number) {
    this.needed = needed;
    this.windowMs = windowMs;
  }

  /** Returns true when this press completes the pattern. */
  press(now: number, count = 1): boolean {
    for (let i = 0; i < count; i++) this.presses.push(now);
    if (this.count(now) < this.needed()) return false;
    this.clear();
    return true;
  }

  count(now: number): number {
    this.presses = this.presses.filter((t) => now - t <= this.windowMs());
    return this.presses.length;
  }

  clear(): void {
    this.presses = [];
  }
}
