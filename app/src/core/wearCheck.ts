export interface WearReport {
  connected: boolean;
  wearing: boolean | undefined;
  inCase: boolean | undefined;
}

export type WearCheckPhase = 'idle' | 'baseline' | 'remove' | 'wear' | 'complete' | 'failed';
export type WearCheckFailure = 'no-removal-report' | 'no-wear-report' | 'case-reported' | 'disconnected' | 'backgrounded';

export interface WearCheckStatus {
  phase: WearCheckPhase;
  completed: number;
  required: number;
  failure: WearCheckFailure | null;
  secondsLeft: number;
  latest: WearReport | null;
}

// Counts only removal and wear reports supplied by the device bridge. Closing
// the arms or putting the glasses in the case cannot complete a removal round.
export class WearCheck {
  private phase: WearCheckPhase = 'idle';
  private completed = 0;
  private failure: WearCheckFailure | null = null;
  private deadline = 0;
  private latest: WearReport | null = null;
  readonly required = 6;

  get active(): boolean {
    return this.phase === 'baseline' || this.phase === 'remove' || this.phase === 'wear';
  }

  start(now: number): void {
    this.phase = 'baseline';
    this.completed = 0;
    this.failure = null;
    this.deadline = now + 30_000;
  }

  cancel(): void {
    this.phase = 'idle';
    this.failure = null;
    this.completed = 0;
  }

  observe(report: WearReport, now: number): void {
    this.latest = { ...report };
    this.tick(now);
    if (!this.active) return;
    if (!report.connected) { this.fail('disconnected'); return; }
    if (report.inCase === true) { this.fail('case-reported'); return; }
    if (report.inCase !== false) return;
    if (this.phase === 'remove' && report.wearing === false) {
      this.phase = 'wear';
      this.deadline = now + 30_000;
    } else if (report.wearing === true) {
      if (this.phase === 'wear') this.completed++;
      if (this.phase === 'baseline' || this.phase === 'wear') {
        this.phase = this.completed === this.required ? 'complete' : 'remove';
        this.deadline = now + 15_000;
      }
    }
  }

  tick(now: number): void {
    if (this.active && now >= this.deadline) {
      this.fail(this.phase === 'remove' ? 'no-removal-report' : 'no-wear-report');
    }
  }

  fail(reason: WearCheckFailure): void {
    if (!this.active) return;
    this.phase = 'failed';
    this.failure = reason;
  }

  snapshot(now: number): WearCheckStatus {
    return {
      phase: this.phase, completed: this.completed, required: this.required, failure: this.failure,
      secondsLeft: this.active ? Math.max(0, Math.ceil((this.deadline - now) / 1000)) : 0,
      latest: this.latest ? { ...this.latest } : null,
    };
  }
}
