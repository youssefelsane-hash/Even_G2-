import { sanitizeSettings, type Settings } from './settings.ts';

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<boolean>;
}

export class MemoryStore implements KeyValueStore {
  readonly data = new Map<string, string>();
  async get(key: string): Promise<string | null> { return this.data.get(key) ?? null; }
  async set(key: string, value: string): Promise<boolean> { this.data.set(key, value); return true; }
}

export const SETTINGS_KEY = 'g2a.settings.v1';
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

export async function loadSettings(store: KeyValueStore): Promise<Settings> {
  try {
    const raw = await store.get(SETTINGS_KEY);
    return sanitizeSettings(raw ? JSON.parse(raw) : {});
  } catch {
    return sanitizeSettings({});
  }
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
