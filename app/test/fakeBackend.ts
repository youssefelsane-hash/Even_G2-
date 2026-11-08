import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CameraConfig, FetchLike, JobEvent, SyncKV } from '../src/core/backend.ts';

// A fake of the assistant backend, following docs/API.md: long-poll results with
// a cursor, acks, presence and camera settings. No test needs the real backend.
// `fetch` serves it in memory; `listen()` serves the same logic over real HTTP.

export const TOKEN = 'test-client-token-0123456789';

export class MemoryKV implements SyncKV {
  readonly data = new Map<string, string>();
  getItem(k: string): string | null { return this.data.get(k) ?? null; }
  setItem(k: string, v: string): void { this.data.set(k, v); }
}

interface Reply { status: number; body: unknown }

export class FakeBackend {
  private jobs = new Map<string, JobEvent>();
  private seq = 0;
  private waiters: (() => void)[] = [];
  acks: { jobId: string; stage: string }[] = [];
  presence: string[] = [];
  polls: string[] = [];
  camera: CameraConfig = { version: 1, defaultMode: 'burst', burstFrames: 4, uploadFrames: 3, longPressMode: 'clip', clipSeconds: 2, resolution: '2048x1536', jpegQuality: 85, minUploadScore: 0.15, statusPollSeconds: 30 };
  /** The longest a results request is held, in real ms. The client asks for 25 s; tests do not wait that long. */
  holdMs = 30;
  /** Fail the next N requests of any kind with this status (0 means a network error). */
  failNext: { count: number; status: number } = { count: 0, status: 500 };
  /** Extra events added to the next results page as-is, to test bad or repeated data. */
  inject: unknown[] = [];
  pageSize = 50;

  /** Adds or updates a job and returns its event. Every change gets a new sequence number. */
  push(e: Omit<JobEvent, 'seq'>): JobEvent {
    const ev = { ...e, seq: ++this.seq } as JobEvent;
    this.jobs.set(e.jobId, ev);
    for (const w of this.waiters.splice(0)) w();
    return ev;
  }

  /** The usual life of one capture: received, processing, then a final event. */
  ready(jobId: string, short: string, extra: Partial<JobEvent> = {}): JobEvent {
    return this.push({ jobId, status: 'ready', photos: 3, pages: 1, result: { short, detail: [`${short} detail one.`, `${short} detail two.`], label: 'LIKELY', caveats: [], pages: 1, usedFrames: 2 }, ...extra });
  }

  private eventsAfter(cursor: number): JobEvent[] {
    const after = cursor > this.seq ? 0 : cursor; // a reset server starts over
    return [...this.jobs.values()].filter((j) => j.seq > after).sort((a, b) => a.seq - b.seq);
  }

  async handle(method: string, url: URL, auth: string | undefined, body: string | undefined): Promise<Reply> {
    if (this.failNext.count > 0) {
      this.failNext.count--;
      if (this.failNext.status === 0) throw new TypeError('fetch failed');
      return { status: this.failNext.status, body: { error: 'injected' } };
    }
    if (auth !== `Bearer ${TOKEN}`) return { status: 401, body: { error: 'unauthorized' } };
    const p = url.pathname;
    if (p === '/v1/results' && method === 'GET') {
      const raw = url.searchParams.get('cursor') ?? '0';
      if (!/^\d{1,15}$/.test(raw)) return { status: 400, body: { error: 'bad cursor' } };
      this.polls.push(raw);
      const cursor = Number(raw);
      if (!this.eventsAfter(cursor).length && !this.inject.length && Number(url.searchParams.get('wait') ?? 0) > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, this.holdMs);
          function done() { clearTimeout(timer); resolve(); }
          this.waiters.push(done);
        });
      }
      const all = this.eventsAfter(cursor);
      const page = all.slice(0, this.pageSize);
      const events: unknown[] = [...page, ...this.inject.splice(0)];
      const next = page.length ? page[page.length - 1].seq : Math.min(cursor, this.seq);
      return { status: 200, body: { cursor: String(next), events, more: all.length > page.length } };
    }
    if (p === '/v1/acks' && method === 'POST') {
      const b = JSON.parse(body ?? '{}') as { jobId?: string; stage?: string };
      if (typeof b.jobId !== 'string' || (b.stage !== 'received' && b.stage !== 'displayed')) return { status: 400, body: { error: 'bad ack' } };
      if (!this.jobs.has(b.jobId)) return { status: 404, body: { error: 'job not found' } };
      this.acks.push({ jobId: b.jobId, stage: b.stage });
      return { status: 200, body: { jobId: b.jobId } };
    }
    if (p === '/v1/presence' && method === 'POST') {
      const b = JSON.parse(body ?? '{}') as { displayMode?: string };
      if (!['VISIBLE', 'HIDDEN', 'REMOVED', 'UNKNOWN'].includes(b.displayMode ?? '')) return { status: 400, body: { error: 'bad mode' } };
      this.presence.push(b.displayMode!);
      return { status: 200, body: { displayMode: b.displayMode } };
    }
    if (p === '/v1/camera/config') {
      if (method === 'GET') return { status: 200, body: this.camera };
      if (method === 'PUT') {
        const b = JSON.parse(body ?? '{}') as Record<string, unknown>;
        const allowed = ['defaultMode', 'burstFrames', 'uploadFrames', 'longPressMode', 'resolution', 'clipSeconds', 'jpegQuality', 'minUploadScore', 'statusPollSeconds'];
        const bad = Object.keys(b).find((k) => !allowed.includes(k));
        if (bad) return { status: 400, body: { error: `unknown field ${bad}` } };
        this.camera = { ...this.camera, ...b, version: (this.camera.version ?? 0) + 1 } as CameraConfig;
        return { status: 200, body: this.camera };
      }
    }
    return { status: 404, body: { error: 'not found' } };
  }

  /** A fetch that talks to this fake in memory. Honours AbortSignal like the real one. */
  readonly fetch: FetchLike = async (url, init) => {
    const signal = init.signal;
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const work = this.handle(init.method ?? 'GET', new URL(url), init.headers?.Authorization, init.body);
    const reply = await (signal
      ? Promise.race([work, new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }))])
      : work);
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => JSON.parse(JSON.stringify(reply.body)) };
  };

  /** Serves the same logic over real HTTP on 127.0.0.1. Close the server when done. */
  async listen(): Promise<{ server: Server; origin: string }> {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        this.handle(req.method ?? 'GET', url, req.headers.authorization, Buffer.concat(chunks).toString('utf8')).then(
          (r) => { res.writeHead(r.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r.body)); },
          () => { res.destroy(); },
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { server, origin: `http://127.0.0.1:${port}` };
  }
}

/** Waits until `cond` holds, polling the event loop. Fails after `ms`. */
export async function until(cond: () => boolean, ms = 2000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}
