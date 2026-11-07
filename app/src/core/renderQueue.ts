// What the lens should show. `blank` is the only plan allowed in Hidden and Removed.
export type DisplayPlan = { kind: 'blank' } | { kind: 'text'; text: string };

export const BLANK: DisplayPlan = { kind: 'blank' };
// A text container cannot be empty, and a space lights no pixels.
export const BLANK_TEXT = ' ';

export interface DisplayPort {
  /** Flicker-free text replacement. */
  setText(text: string): Promise<boolean>;
  /** Full redraw, used when the fast path fails to blank the lens. */
  rebuild(text: string): Promise<boolean>;
}

// Sends plans to the glasses one at a time. Only the newest waiting plan is
// kept, so a hide never queues behind a burst of scroll updates.
export class RenderQueue {
  private readonly port: DisplayPort;
  private readonly timeoutMs: number;
  private wanted: DisplayPlan = BLANK;
  // Unknown at start: after a WebView restart the old page can still be on the lens.
  private shown: string | null = null;
  private dirty = false;
  private forced = false;
  private running: Promise<void> | null = null;
  /** Called when the lens could not be blanked. */
  onBlankFailed: (() => void) | null = null;

  constructor(port: DisplayPort, timeoutMs = 3000) {
    this.port = port;
    this.timeoutMs = timeoutMs;
  }

  show(plan: DisplayPlan, force = false): Promise<void> {
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
  private call(send: () => Promise<boolean>): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), this.timeoutMs);
      const finish = (ok: boolean): void => {
        clearTimeout(timer);
        resolve(ok);
      };
      try {
        send().then(finish, () => finish(false));
      } catch {
        finish(false);
      }
    });
  }

  private async pump(): Promise<void> {
    while (this.dirty) {
      this.dirty = false;
      const plan = this.wanted;
      const text = plan.kind === 'blank' ? BLANK_TEXT : plan.text;
      const forced = this.forced;
      this.forced = false;
      if (!forced && text === this.shown) continue;
      let ok = await this.call(() => this.port.setText(text));
      if (!ok && plan.kind === 'blank') {
        ok = await this.call(() => this.port.rebuild(BLANK_TEXT));
        if (!ok) this.onBlankFailed?.();
      }
      this.shown = ok ? text : null;
    }
  }
}
