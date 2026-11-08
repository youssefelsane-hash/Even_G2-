// The app clock: the wall clock, unless the development e2e driver holds it.
// The driver holds it while it feeds a synthetic motion in one go, so the app
// sees the samples at their own times even when the simulator throttles timers
// (a late timer would otherwise look like a sensor gap in the middle of a shake).
// Nothing in a production build calls holdClock.
let heldAt: number | null = null;

export function appNow(): number {
  return heldAt ?? Date.now();
}

/** `null` releases the hold. */
export function holdClock(at: number | null): void {
  heldAt = at;
}
