// What the lens should show. `blank` is the only plan allowed in Hidden and Removed.
export type DisplayPlan = { kind: 'blank' } | { kind: 'text'; text: string };

export const BLANK: DisplayPlan = { kind: 'blank' };
// A text container cannot be empty, and a space lights no pixels.
export const BLANK_TEXT = ' ';

export interface DisplayTimings {
  blankMs: number | null;
  textMs: number | null;
}

export interface DisplayPort {
  /** Flicker-free text replacement. */
  setText(text: string, stillWanted: () => boolean): Promise<boolean>;
  /** Full redraw when the in-place update fails. */
  rebuild(text: string, stillWanted: () => boolean): Promise<boolean>;
}

// Sends one plan at a time. A blank must be accepted before new text can
// overwrite it. Other waiting updates collapse into the latest plan.
export class RenderQueue {
  private readonly port: DisplayPort;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private wanted: DisplayPlan = BLANK;
  private wantedAt: number | null = null;
  private blankPendingAt: number | null = null;
  private applied: DisplayTimings = { blankMs: null, textMs: null };
  // Unknown at start: after a WebView restart the old page can still be on the lens.
  private shown: string | null = null;
  private dirty = false;
  private forced = false;
  private running: Promise<void> | null = null;
  /** Called when the lens could not be blanked. */
  onBlankFailed: (() => void) | null = null;

  constructor(port: DisplayPort, timeoutMs = 3000, now: () => number = () => performance.now()) {
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.now = now;
  }

  get timings(): Readonly<DisplayTimings> { return this.applied; }

  get status(): string {
    if (this.running) return 'updating';
    if (this.shown === null) return 'unconfirmed';
    return this.shown === BLANK_TEXT ? 'blank accepted' : 'text accepted';
  }

  show(plan: DisplayPlan, force = false): Promise<void> {
    const same = plan.kind === 'blank' ? this.wanted.kind === 'blank'
      : this.wanted.kind === 'text' && this.wanted.text === plan.text;
    if (force || !same || this.wantedAt === null) {
      this.wantedAt = this.now();
      if (plan.kind === 'blank') this.blankPendingAt ??= this.wantedAt;
    }
    this.wanted = plan;
    if (force) this.forced = true;
    this.dirty = true;
    this.running ??= this.drain();
    return this.running;
  }

  private drain(): Promise<void> {
    return this.pump().finally(() => {
      this.running = null;
      // A plan can arrive after the pump's last check and before this runs.
      if (this.dirty) void this.show(this.wanted);
    });
  }

  // One flaky hop can hang for a long time, so every call gets a time limit.
  private call(send: (active: () => boolean) => Promise<boolean>): Promise<boolean> {
    return new Promise((resolve) => {
      let active = true;
      const finish = (ok: boolean): void => {
        if (!active) return;
        active = false;
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), this.timeoutMs);
      try {
        send(() => active).then(finish, () => finish(false));
      } catch {
        finish(false);
      }
    });
  }

  private async pump(): Promise<void> {
    while (this.dirty) {
      this.dirty = false;
      const blankAt = this.blankPendingAt;
      const plan = blankAt === null ? this.wanted : BLANK;
      const requestedAt = blankAt ?? this.wantedAt ?? this.now();
      const text = plan.kind === 'blank' ? BLANK_TEXT : plan.text;
      const forced = blankAt !== null || this.forced;
      this.blankPendingAt = null;
      this.forced = false;
      if (!forced && text === this.shown) continue;
      // The bridge may still be busy when wear changes. Check again before a
      // queued text update or rebuild reaches the glasses.
      const stillWanted = () => plan.kind === 'blank' ||
        (this.blankPendingAt === null && this.wanted.kind === 'text' && this.wanted.text === text);
      let ok = await this.call((active) => this.port.setText(text, () => active() && stillWanted()));
      if (!ok && stillWanted()) {
        ok = await this.call((active) => this.port.rebuild(text, () => active() && stillWanted()));
      }
      this.shown = ok ? text : null;
      if (ok) this.applied[plan.kind === 'blank' ? 'blankMs' : 'textMs'] = Math.round(this.now() - requestedAt);
      if (plan.kind === 'blank' && !ok) {
        // Keep the requirement to blank, but wait for the next refresh to retry.
        this.blankPendingAt = requestedAt;
        this.dirty = false;
        this.onBlankFailed?.();
        return;
      }
      if (blankAt !== null && this.wanted.kind === 'text') this.dirty = true;
    }
  }
}
