// Client for the assistant backend (docs/API.md). Pure logic: fetch, storage,
// sleep and the clock are injected, so the same code runs in the WebView and in
// Node tests against a fake server.
//
// Rules this client keeps:
// - Results arrive only by long-poll, and only the Assistant decides what the
//   lens shows. Nothing here draws anything.
// - The cursor is saved after the events of a page have been handed over, so a
//   crash or reload re-fetches them, and duplicates are dropped by (jobId, seq).
// - Every request is short-lived and can be retried. No WebSocket.
// - Server data is untrusted: every field is checked and clipped.

export type EventStatus = 'received' | 'processing' | 'ready' | 'retake' | 'failed';
export type Label = 'CHECKED' | 'LIKELY' | 'UNSURE' | 'RETAKE';
export type DisplayMode = 'VISIBLE' | 'HIDDEN' | 'REMOVED' | 'UNKNOWN';
export type AckStage = 'received' | 'displayed';

export interface JobResult {
  short: string;
  detail: string[];
  label: Label;
  caveats: string[];
  pages: number;
  usedFrames: number;
  retakeReason?: string;
}

export interface JobEvent {
  jobId: string;
  seq: number;
  status: EventStatus;
  /** Photos the camera uploaded for this job. */
  photos?: number;
  pages?: number;
  /** This job added a page to an earlier question. */
  appendedTo?: string;
  result?: JobResult;
  error?: string;
  /** Server time the job was created, in ms since 1970. */
  createdAt?: number;
  /**
   * Set by the client: the event came from a catch-up from the start of the
   * stream (a lost cursor, a fresh install or a reset server) and the job is
   * older than HISTORY_AFTER_MS. It is history, not news: it must not draw a
   * camera status or a retake, and an answer is kept as already seen.
   */
  history?: boolean;
}

/** A catch-up event for a job older than this is history. */
export const HISTORY_AFTER_MS = 15 * 60_000;
/** A reply with no events that came back faster than this means the server did not hold the request. */
const FAST_EMPTY_MS = 1000;

// Camera settings as the backend stores them (backend/src/cameraConfig.ts).
export const RESOLUTIONS = ['1280x720', '1600x1200', '1920x1080', '2048x1536', '2592x1944'] as const;
export interface CameraConfig {
  version?: number;
  updatedAt?: string;
  defaultMode: 'burst' | 'single';
  burstFrames: number;
  uploadFrames: number;
  longPressMode: 'clip' | 'burst';
  clipSeconds?: number;
  resolution: (typeof RESOLUTIONS)[number];
  jpegQuality?: number;
  minUploadScore?: number;
  statusPollSeconds?: number;
}
export type CameraPatch = Partial<Pick<CameraConfig, 'defaultMode' | 'burstFrames' | 'uploadFrames' | 'longPressMode' | 'resolution'>>;

export interface SyncKV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface BackendSettings { serverUrl: string; token: string }

export type ConnState = 'off' | 'connecting' | 'online' | 'offline' | 'unauthorized';

export type FetchLike = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal; cache?: 'no-store' }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface ClientOptions {
  kv: SyncKV;
  fetch: FetchLike;
  /** Resolves after `ms`, or early when `signal` aborts. */
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  random?(): number;
  waitSeconds?: number;
  /** Extra time on top of the server wait before a hung request is aborted. */
  slackMs?: number;
  maxBackoffMs?: number;
  /** Hands one event to the app. The returned promise resolves once it is stored. */
  onEvent(e: JobEvent): Promise<void> | void;
  onState?(s: ConnState, detail?: string): void;
  log?(line: string): void;
  /** Wall clock, for the age of catch-up events and for spotting replies that came back at once. */
  now?(): number;
}

const SETTINGS_KEY = 'g2a.backend.v1';
export const STATE_KEY = 'g2a.client.v1';
const MAX_SEEN = 300;
const MAX_ACKS = 100;
const LIMITS = { short: 300, detailItems: 12, detailChars: 800, caveats: 6, caveatChars: 300, reason: 60, id: 80 };

interface Persisted {
  cursor: string;
  seen: [string, number][];
  acks: { jobId: string; stage: AckStage }[];
}

export function loadBackendSettings(kv: SyncKV): BackendSettings | null {
  try {
    const s = JSON.parse(kv.getItem(SETTINGS_KEY) ?? 'null') as Partial<BackendSettings> | null;
    if (s && typeof s.serverUrl === 'string' && typeof s.token === 'string' && s.serverUrl && s.token) return { serverUrl: s.serverUrl, token: s.token };
  } catch { /* corrupt: treat as not set */ }
  return null;
}

/** Returns an error message, or null when saved. The token never goes anywhere but this store. */
export function saveBackendSettings(kv: SyncKV, s: BackendSettings): string | null {
  const url = s.serverUrl.trim().replace(/\/+$/, '');
  let parsed: URL;
  try { parsed = new URL(url); } catch { return 'The server address is not a valid URL.'; }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) return 'The server address must start with https://.';
  if (parsed.pathname !== '/' && parsed.pathname !== '') return 'Give only the server origin, for example https://example.com.';
  const token = s.token.trim();
  if (token.length < 16) return 'The token looks too short.';
  try { kv.setItem(SETTINGS_KEY, JSON.stringify({ serverUrl: parsed.origin, token })); } catch { return 'Could not save on this phone.'; }
  return null;
}

export function clearBackendSettings(kv: SyncKV): void {
  try { kv.setItem(SETTINGS_KEY, 'null'); } catch { /* nothing to clear */ }
}

const str = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.slice(0, max) : null);
const int = (v: unknown, lo: number, hi: number): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : null);
const STATUSES: readonly EventStatus[] = ['received', 'processing', 'ready', 'retake', 'failed'];
const LABELS: readonly Label[] = ['CHECKED', 'LIKELY', 'UNSURE', 'RETAKE'];

function strings(v: unknown, items: number, chars: number): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, items).map((x) => x.slice(0, chars)) : [];
}

/** Checks one event from the server. Anything malformed is dropped, not guessed at. */
export function parseEvent(raw: unknown): JobEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const jobId = str(r.jobId, LIMITS.id);
  const seq = int(r.seq, 0, Number.MAX_SAFE_INTEGER);
  const status = STATUSES.find((s) => s === r.status);
  if (!jobId || seq === null || !status) return null;
  const e: JobEvent = { jobId, seq, status };
  const photos = int(r.photos, 0, 99);
  if (photos !== null) e.photos = photos;
  const pages = int(r.pages, 1, 99);
  if (pages !== null) e.pages = pages;
  const parent = str(r.appendedTo, LIMITS.id);
  if (parent) e.appendedTo = parent;
  if (typeof r.createdAt === 'string') {
    const at = Date.parse(r.createdAt);
    if (Number.isFinite(at)) e.createdAt = at;
  }
  const error = str(r.error, 200);
  if (error) e.error = error;
  if (r.result && typeof r.result === 'object') {
    const x = r.result as Record<string, unknown>;
    const short = str(x.short, LIMITS.short);
    if (short !== null) {
      e.result = {
        short,
        detail: strings(x.detail, LIMITS.detailItems, LIMITS.detailChars),
        label: LABELS.find((l) => l === x.label) ?? 'UNSURE',
        caveats: strings(x.caveats, LIMITS.caveats, LIMITS.caveatChars),
        pages: int(x.pages, 1, 99) ?? e.pages ?? 1,
        usedFrames: int(x.usedFrames, 0, 99) ?? 0,
      };
      const reason = str(x.retakeReason, LIMITS.reason);
      if (reason) e.result.retakeReason = reason;
    }
  }
  if (status === 'ready' && !e.result) return null; // a ready event must carry its answer
  return e;
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal.aborted) { resolve(); return; }
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

export class ResultClient {
  private readonly o: ClientOptions;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;
  private state: Persisted;
  private settings: BackendSettings | null = null;
  private running = false;
  private loopDone: Promise<void> | null = null;
  private poll: AbortController | null = null;
  private nap: AbortController | null = null;
  private failures = 0;
  private fastEmpty = 0;
  private presenceWanted: DisplayMode | null = null;
  private presenceSent: DisplayMode | null = null;
  private presenceBusy = false;
  connState: ConnState = 'off';
  lastError = '';
  polls = 0;

  constructor(o: ClientOptions) {
    this.o = o;
    this.sleep = o.sleep ?? defaultSleep;
    this.random = o.random ?? Math.random;
    this.now = o.now ?? Date.now;
    this.state = this.load();
  }

  private load(): Persisted {
    try {
      const p = JSON.parse(this.o.kv.getItem(STATE_KEY) ?? 'null') as Partial<Persisted> | null;
      if (p && typeof p.cursor === 'string' && /^\d{1,15}$/.test(p.cursor)) {
        return {
          cursor: p.cursor,
          seen: Array.isArray(p.seen) ? p.seen.filter((x) => Array.isArray(x) && typeof x[0] === 'string' && typeof x[1] === 'number').slice(-MAX_SEEN) : [],
          acks: Array.isArray(p.acks) ? p.acks.filter((a) => a && typeof a.jobId === 'string' && (a.stage === 'received' || a.stage === 'displayed')).slice(-MAX_ACKS) : [],
        };
      }
    } catch { /* corrupt: start from the beginning, duplicates are dropped by the app */ }
    return { cursor: '0', seen: [], acks: [] };
  }

  private persist(): void {
    try { this.o.kv.setItem(STATE_KEY, JSON.stringify(this.state)); } catch { /* storage full: the cursor is only an optimisation */ }
  }

  get cursor(): string { return this.state.cursor; }
  get pendingAcks(): number { return this.state.acks.length; }
  get configured(): boolean { return this.settings !== null; }

  private setState(s: ConnState, detail = ''): void {
    if (detail) this.lastError = detail;
    if (s === this.connState) return;
    this.connState = s;
    this.o.onState?.(s, detail);
  }

  start(settings: BackendSettings): void {
    this.settings = settings;
    if (this.running) { this.wake(); return; }
    this.running = true;
    this.loopDone = this.loop();
    void this.sendPresence();
  }

  /** Stops polling. Resolves when the loop has ended. */
  async stop(): Promise<void> {
    this.running = false;
    this.poll?.abort();
    this.nap?.abort();
    await this.loopDone;
    this.setState('off');
  }

  /** Poll now: the app came back to the foreground, or the network returned. */
  wake(): void {
    this.failures = 0;
    this.nap?.abort();
    this.poll?.abort();
  }

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = { Authorization: `Bearer ${this.settings?.token ?? ''}` };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  private url(path: string): string {
    return `${this.settings?.serverUrl ?? ''}${path}`;
  }

  private backoff(): number {
    const max = this.o.maxBackoffMs ?? 30_000;
    const base = Math.min(max, 1000 * 2 ** Math.min(this.failures, 10));
    return base / 2 + this.random() * (base / 2);
  }

  private async rest(ms: number): Promise<void> {
    const ac = new AbortController();
    this.nap = ac;
    await this.sleep(ms, ac.signal);
    this.nap = null;
  }

  private seenSeq(jobId: string): number {
    for (let i = this.state.seen.length - 1; i >= 0; i--) if (this.state.seen[i][0] === jobId) return this.state.seen[i][1];
    return -1;
  }

  private markSeen(jobId: string, seq: number): void {
    this.state.seen = this.state.seen.filter((x) => x[0] !== jobId);
    this.state.seen.push([jobId, seq]);
    if (this.state.seen.length > MAX_SEEN) this.state.seen.splice(0, this.state.seen.length - MAX_SEEN);
  }

  /** Queue an acknowledgement. Displayed implies received on the server. */
  ack(jobId: string, stage: AckStage): void {
    const acks = this.state.acks;
    if (acks.some((a) => a.jobId === jobId && (a.stage === stage || a.stage === 'displayed'))) return;
    if (stage === 'displayed') this.state.acks = acks.filter((a) => a.jobId !== jobId);
    this.state.acks.push({ jobId, stage });
    if (this.state.acks.length > MAX_ACKS) this.state.acks.splice(0, this.state.acks.length - MAX_ACKS);
    this.persist();
    if (this.running) void this.flushAcks();
  }

  private acking = false;
  private async flushAcks(): Promise<void> {
    if (this.acking || !this.settings) return;
    this.acking = true;
    try {
      while (this.state.acks.length && this.running) {
        const a = this.state.acks[0];
        const res = await this.o.fetch(this.url('/v1/acks'), { method: 'POST', headers: this.headers(true), body: JSON.stringify(a), cache: 'no-store' });
        // 404: the job has expired on the server. Nothing more to report.
        if (!res.ok && res.status !== 404 && res.status !== 400) break;
        this.state.acks.shift();
        this.persist();
      }
    } catch {
      /* offline: retried on the next poll */
    } finally {
      this.acking = false;
    }
  }

  /** Report what the lens may show. Only the newest value is sent. UNKNOWN is treated as hidden by the server. */
  setPresence(mode: DisplayMode): void {
    this.presenceWanted = mode;
    if (this.running) void this.sendPresence();
  }

  get presence(): DisplayMode | null { return this.presenceSent; }

  private async sendPresence(): Promise<void> {
    if (this.presenceBusy || !this.settings) return;
    this.presenceBusy = true;
    try {
      while (this.running && this.presenceWanted !== null && this.presenceWanted !== this.presenceSent) {
        const mode = this.presenceWanted;
        const res = await this.o.fetch(this.url('/v1/presence'), { method: 'POST', headers: this.headers(true), body: JSON.stringify({ displayMode: mode }), cache: 'no-store' });
        if (!res.ok) break;
        this.presenceSent = mode;
      }
    } catch {
      /* retried after the next successful poll */
    } finally {
      this.presenceBusy = false;
    }
  }

  private async loop(): Promise<void> {
    while (this.running) {
      await this.flushAcks();
      if (!this.running) break;
      if (this.connState !== 'online') this.setState('connecting');
      const ac = new AbortController();
      this.poll = ac;
      const wait = this.o.waitSeconds ?? 25;
      const limit = setTimeout(() => ac.abort(), wait * 1000 + (this.o.slackMs ?? 10_000));
      let more = false;
      const asked = this.state.cursor;
      const sentAt = this.now();
      try {
        this.polls++;
        const res = await this.o.fetch(this.url(`/v1/results?cursor=${encodeURIComponent(this.state.cursor)}&wait=${wait}`), { headers: this.headers(), signal: ac.signal, cache: 'no-store' });
        if (res.status === 401 || res.status === 403) {
          this.setState('unauthorized', 'The server rejected the token. Check it in Settings.');
          this.failures = 10;
          await this.rest(this.o.maxBackoffMs ?? 30_000);
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { cursor?: unknown; events?: unknown; more?: unknown };
        const cursor = typeof body.cursor === 'string' && /^\d{1,15}$/.test(body.cursor) ? body.cursor
          : typeof body.cursor === 'number' && Number.isSafeInteger(body.cursor) && body.cursor >= 0 ? String(body.cursor) : null;
        if (cursor === null || !Array.isArray(body.events)) throw new Error('bad reply');
        const events = body.events.map(parseEvent).filter((e): e is JobEvent => e !== null).sort((a, b) => a.seq - b.seq);
        // From the start of the stream, or the server went back below our cursor (it was reset).
        const catchUp = asked === '0' || events.some((e) => e.seq <= Number(asked));
        const now = this.now();
        for (const e of events) {
          if (e.seq <= this.seenSeq(e.jobId)) continue; // already handed over
          delete e.history; // only this client sets it, never the server
          if (catchUp && e.createdAt !== undefined && now - e.createdAt > HISTORY_AFTER_MS) e.history = true;
          await this.o.onEvent(e);
          this.markSeen(e.jobId, e.seq);
          if (e.status === 'ready' || e.status === 'retake' || e.status === 'failed') this.ack(e.jobId, 'received');
        }
        // Only after every event is stored: a reload before this point fetches them again.
        this.state.cursor = cursor;
        this.persist();
        // "more" with nothing in the page would mean polling again at once for ever.
        more = body.more === true && events.length > 0;
        this.failures = 0;
        this.setState('online');
        void this.sendPresence();
        // A server (or proxy) that ignores `wait` and answers at once with nothing
        // would turn the long-poll into a busy loop. Pause, longer each time.
        if (!events.length && this.now() - sentAt < FAST_EMPTY_MS) {
          this.fastEmpty++;
          await this.rest(Math.min(this.o.maxBackoffMs ?? 30_000, 1000 * 2 ** Math.min(this.fastEmpty - 1, 5)));
        } else {
          this.fastEmpty = 0;
        }
      } catch (err) {
        if (!this.running) break;
        if (ac.signal.aborted && this.failures === 0) {
          // Woken on purpose, or the request hung past its limit: poll again at once.
          continue;
        }
        this.failures++;
        this.setState('offline', err instanceof Error ? err.message : String(err));
        await this.rest(this.backoff());
        continue;
      } finally {
        clearTimeout(limit);
        this.poll = null;
      }
      if (more) continue;
    }
  }

  // ---- Camera settings, changed from the phone panel ----

  async getCameraConfig(): Promise<CameraConfig> {
    if (!this.settings) throw new Error('Backend not set up');
    const res = await this.o.fetch(this.url('/v1/camera/config'), { headers: this.headers(), cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as CameraConfig;
  }

  async putCameraConfig(patch: CameraPatch): Promise<CameraConfig> {
    if (!this.settings) throw new Error('Backend not set up');
    const res = await this.o.fetch(this.url('/v1/camera/config'), { method: 'PUT', headers: this.headers(true), body: JSON.stringify(cleanCameraPatch(patch)), cache: 'no-store' });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const b = (await res.json()) as { error?: unknown }; if (typeof b.error === 'string') msg = b.error; } catch { /* no body */ }
      throw new Error(msg);
    }
    return (await res.json()) as CameraConfig;
  }
}

/** Keeps only the fields the panel may change, in their allowed ranges. The server checks again. */
export function cleanCameraPatch(p: CameraPatch): CameraPatch {
  const out: CameraPatch = {};
  if (p.defaultMode === 'burst' || p.defaultMode === 'single') out.defaultMode = p.defaultMode;
  if (p.longPressMode === 'clip' || p.longPressMode === 'burst') out.longPressMode = p.longPressMode;
  if (typeof p.burstFrames === 'number' && Number.isFinite(p.burstFrames)) out.burstFrames = Math.min(8, Math.max(1, Math.round(p.burstFrames)));
  if (typeof p.uploadFrames === 'number' && Number.isFinite(p.uploadFrames)) out.uploadFrames = Math.min(3, Math.max(1, Math.round(p.uploadFrames)));
  if (out.burstFrames !== undefined && out.uploadFrames !== undefined) out.uploadFrames = Math.min(out.uploadFrames, out.burstFrames);
  if ((RESOLUTIONS as readonly unknown[]).includes(p.resolution)) out.resolution = p.resolution;
  return out;
}
