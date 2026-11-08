import path from 'node:path';
import { atomicWrite, readJson } from './fsutil.ts';

export const DISPLAY_MODES = ['VISIBLE', 'HIDDEN', 'REMOVED', 'UNKNOWN'] as const;
export type DisplayMode = (typeof DISPLAY_MODES)[number];

// Two facts about the glasses app:
//  1. Is it listening right now (a long-poll open, or one closed a moment ago)?
//  2. What did it last report about the display?
//
// V1 has no notification path, so neither fact ever causes the server to show
// anything. They are kept so the camera can signal "glasses app not
// listening", and so a later fallback, if the owner ever adds one, starts from
// a safe default: anything other than VISIBLE, including no report at all,
// counts as hidden.
export class Presence {
  private openPolls = 0;
  private lastSeen = 0;
  private readonly graceMs: number;
  private state: { displayMode: DisplayMode; updatedAt: string } = { displayMode: 'UNKNOWN', updatedAt: new Date(0).toISOString() };
  private readonly file: string;

  constructor(dataDir: string, graceMs = 5_000) {
    this.graceMs = graceMs;
    this.file = path.join(dataDir, 'state', 'presence.json');
  }

  async load(): Promise<void> {
    const saved = await readJson<{ displayMode: DisplayMode; updatedAt: string }>(this.file);
    if (saved && (DISPLAY_MODES as readonly string[]).includes(saved.displayMode)) this.state = saved;
  }

  pollStarted(): void {
    this.openPolls++;
    this.lastSeen = Date.now();
  }

  pollEnded(): void {
    this.openPolls = Math.max(0, this.openPolls - 1);
    this.lastSeen = Date.now();
  }

  listening(now = Date.now()): boolean {
    return this.openPolls > 0 || now - this.lastSeen < this.graceMs;
  }

  display(): { displayMode: DisplayMode; hidden: boolean; updatedAt: string } {
    return { ...this.state, hidden: this.state.displayMode !== 'VISIBLE' };
  }

  async setDisplay(mode: DisplayMode): Promise<{ displayMode: DisplayMode; hidden: boolean; updatedAt: string }> {
    this.state = { displayMode: mode, updatedAt: new Date().toISOString() };
    await atomicWrite(this.file, JSON.stringify(this.state));
    return this.display();
  }
}
