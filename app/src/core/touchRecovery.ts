// The way out when the IMU fails: a run of presses inside a short window. One
// press or an accidental brush while adjusting the glasses is not enough. A
// double press counts as two, because the firmware reports it as one event.
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
    this.presses = this.presses.filter((t) => now - t <= this.windowMs());
    if (this.presses.length < this.needed()) return false;
    this.presses = [];
    return true;
  }

  clear(): void {
    this.presses = [];
  }
}
