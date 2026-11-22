import { isUnlockGesture, sanitizeSettings, type Settings } from './settings.ts';

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<boolean>;
}

export class MemoryStore implements KeyValueStore {
  readonly data = new Map<string, string>();
  async get(key: string): Promise<string | null> { return this.data.get(key) ?? null; }
  async set(key: string, value: string): Promise<boolean> { this.data.set(key, value); return true; }
}

export const SETTINGS_KEY = 'g2a.settings.v4';
/** Versions 2 and 3 carry tilt and calibration choices that survive the move to the current wear policy. */
export const PREVIOUS_SETTINGS_KEYS = ['g2a.settings.v3', 'g2a.settings.v2'] as const;
export const PREVIOUS_SETTINGS_KEY = PREVIOUS_SETTINGS_KEYS[1];
export const LEGACY_SETTINGS_KEY = 'g2a.settings.v1';
export const SESSION_KEY = 'g2a.session.v1';

// What survives a restart. The Visible/Hidden mode is deliberately not here.
export interface Session {
  docId: string;
  short: string;
  details: string;
  topLine: number;
  unseen: boolean;
  /** Backend label of the open answer, such as CHECKED. Absent for the welcome text and sample answers. */
  label?: string;
  pages?: number;
}

// What a real G2 needs (2026-11-22): it never reported the glasses coming off
// the head, and after the case its isWearing stuck at false while worn. So the
// user locks by hand: holding both temples closes the app (the firmware does
// this), and a double tap hides the text without leaving the app. Reopening
// needs four taps on the right temple; a pause over 1.5 s, or the wrong
// count, simply starts the count again. Only the case report is kept. The
// motion lock stays available in settings, off by default.
export const WEAR_POLICY = { unlockGesture: 'touch', recoveryPresses: 4, unlockTouchpad: 'right',
  recoveryGapMs: 1500, recoveryWindowMs: 6000, doublePressLocks: true,
  trustWearSensor: false, motionLock: false } as const satisfies Partial<Settings>;

export async function loadSettings(store: KeyValueStore): Promise<Settings> {
  for (const key of [SETTINGS_KEY, ...PREVIOUS_SETTINGS_KEYS, LEGACY_SETTINGS_KEY]) {
    try {
      const saved: unknown = JSON.parse(await store.get(key) ?? 'null');
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) continue;
      const settings = saved as Partial<Settings>;
      if (key === SETTINGS_KEY && isUnlockGesture(settings.unlockGesture)) return sanitizeSettings(settings);
      // Carry over calibration. Earlier controls move to the current wear
      // policy, because the host's wear report proved unusable on a real G2
      // (2026-11-22). Version 1 also drops tilt scrolling.
      if ((PREVIOUS_SETTINGS_KEYS as readonly string[]).includes(key) && isUnlockGesture(settings.unlockGesture)) {
        return sanitizeSettings({ ...settings, ...WEAR_POLICY });
      }
      return sanitizeSettings({ ...settings, ...WEAR_POLICY, tiltEnabled: false });
    } catch { /* invalid or unavailable storage: try the earlier settings */ }
  }
  return sanitizeSettings({ ...WEAR_POLICY, tiltEnabled: false });
}

export async function saveSettings(store: KeyValueStore, settings: Settings): Promise<boolean> {
  try {
    return await store.set(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    return false;
  }
}

export async function loadSession(store: KeyValueStore): Promise<Session | null> {
  try {
    const raw = await store.get(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<Session>;
    if (typeof s.docId !== 'string' || typeof s.short !== 'string' || typeof s.details !== 'string') return null;
    const out: Session = {
      docId: s.docId,
      short: s.short,
      details: s.details,
      topLine: typeof s.topLine === 'number' && Number.isFinite(s.topLine) ? s.topLine : 0,
      unseen: s.unseen === true,
    };
    if (typeof s.label === 'string') out.label = s.label.slice(0, 20);
    if (typeof s.pages === 'number' && Number.isFinite(s.pages)) out.pages = Math.min(99, Math.max(1, Math.round(s.pages)));
    return out;
  } catch {
    return null;
  }
}

// Storage shares the link to the host, so writes are coalesced: only the latest
// value is written, at most once per interval, one write at a time.
export class SessionWriter {
  private readonly store: KeyValueStore;
  private readonly minIntervalMs: number;
  private pending: Session | null = null;
  private lastWrite = -Infinity;
  private inFlight: Promise<void> | null = null;

  constructor(store: KeyValueStore, minIntervalMs = 1000) {
    this.store = store;
    this.minIntervalMs = minIntervalMs;
  }

  queue(session: Session): void {
    this.pending = session;
  }

  async tick(now: number): Promise<void> {
    if (this.pending && !this.inFlight && now - this.lastWrite >= this.minIntervalMs) await this.flush(now);
  }

  /** Waits for a write in progress first: the app may be suspended right after this. */
  async flush(now: number): Promise<void> {
    while (this.inFlight) await this.inFlight;
    if (!this.pending) return;
    const session = this.pending;
    this.pending = null;
    this.lastWrite = now;
    this.inFlight = this.write(session).finally(() => { this.inFlight = null; });
    await this.inFlight;
  }

  private async write(session: Session): Promise<void> {
    try {
      const ok = await this.store.set(SESSION_KEY, JSON.stringify(session));
      if (!ok && !this.pending) this.pending = session;
    } catch {
      if (!this.pending) this.pending = session;
    }
  }
}
