import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Config } from './config.ts';
import { CaptureError, type JobStore } from './store.ts';
import { bearer, type AuthRegistry } from './auth.ts';
import { DISPLAY_MODES, type DisplayMode, type Presence } from './presence.ts';
import { validatePatch, type CameraConfigStore } from './cameraConfig.ts';
import { FailureBlocker, RateLimiter } from './ratelimit.ts';
import { parseCapture, RequestError } from './captureRequest.ts';
import type { Log } from './worker.ts';

const IDEM_RE = /^[A-Za-z0-9_-]{8,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const JSON_LIMIT = 8 * 1024;
const MULTIPART_OVERHEAD = 256 * 1024;

class HttpError extends Error {
  readonly status: number;
  readonly headers: Record<string, string>;
  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > limit) return reject(new HttpError(413, 'request too large'));
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (c: Buffer) => {
      if (failed) return;
      size += c.length;
      if (size > limit) { failed = true; chunks.length = 0; reject(new HttpError(413, 'request too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
    req.on('error', (e) => { if (!failed) { failed = true; reject(e); } });
    req.on('aborted', () => { if (!failed) { failed = true; reject(new HttpError(400, 'request aborted')); } });
  });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const body = await readBody(req, JSON_LIMIT);
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'body must be JSON');
  }
}

export interface ServerDeps {
  cfg: Config;
  store: JobStore;
  auth: AuthRegistry;
  presence: Presence;
  camera: CameraConfigStore;
  log?: Log;
}

export function buildServer(deps: ServerDeps): Server {
  const { cfg, store, auth, presence, camera } = deps;
  const log = deps.log ?? (() => {});
  const captureLimiter = new RateLimiter(cfg.capturesPerMinute);
  const statusLimiter = new RateLimiter(cfg.statusPollsPerMinute);
  const blocker = new FailureBlocker(cfg.authFailuresPerMinute, cfg.authBlockMs);
  const maxCaptureBody = cfg.maxFramesPerCapture * cfg.maxFrameBytes + MULTIPART_OVERHEAD;

  const clientIp = (req: IncomingMessage): string => {
    if (cfg.trustProxy) {
      // The trusted proxy appends the address it saw. Earlier entries are whatever
      // the client sent, so using the first one would let it reset the blocker.
      const hops = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (hops.length) return hops[hops.length - 1];
    }
    return req.socket.remoteAddress ?? 'unknown';
  };

  const guard = (req: IncomingMessage) => {
    const wait = blocker.blocked(clientIp(req));
    if (wait > 0) throw new HttpError(429, 'too many failed logins', { 'Retry-After': String(wait) });
  };

  const requireDevice = (req: IncomingMessage): string => {
    guard(req);
    const id = auth.device(bearer(req));
    if (!id) { blocker.fail(clientIp(req)); throw new HttpError(401, 'unauthorized'); }
    const claimed = req.headers['x-device-id'];
    if (claimed !== undefined && claimed !== id) throw new HttpError(403, 'X-Device-Id does not match this token');
    return id;
  };

  const requireClient = (req: IncomingMessage): void => {
    guard(req);
    if (!auth.client(bearer(req))) { blocker.fail(clientIp(req)); throw new HttpError(401, 'unauthorized'); }
  };

  // Either role may read camera settings.
  const requireAny = (req: IncomingMessage): 'device' | 'client' => {
    guard(req);
    const t = bearer(req);
    if (auth.device(t)) return 'device';
    if (auth.client(t)) return 'client';
    blocker.fail(clientIp(req));
    throw new HttpError(401, 'unauthorized');
  };

  const waitForEvents = (cursor: number, waitMs: number, req: IncomingMessage): Promise<void> => {
    if (waitMs <= 0 || store.hasEventsAfter(cursor)) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        store.off('event', onEvent);
        req.off('close', finish);
        resolve();
      };
      const onEvent = () => finish();
      const timer = setTimeout(finish, waitMs);
      store.on('event', onEvent);
      req.on('close', finish);
    });
  };

  const handleCapture = async (req: IncomingMessage, res: ServerResponse) => {
    const deviceId = requireDevice(req);
    const key = String(req.headers['idempotency-key'] ?? '');
    if (!IDEM_RE.test(key)) throw new HttpError(400, 'missing or invalid Idempotency-Key');
    // A retry of a capture that already has a job: answer at once, do not count it.
    const existing = store.findByKey(deviceId, key);
    if (existing) {
      req.resume();
      return send(res, 202, { jobId: existing.id, status: existing.status, duplicate: true, glassesListening: presence.listening() });
    }
    const wait = captureLimiter.take(deviceId);
    if (wait > 0) throw new HttpError(429, 'too many captures', { 'Retry-After': String(wait) });
    const body = await readBody(req, maxCaptureBody);
    const { meta, frames } = parseCapture(body, req.headers['content-type'], cfg);
    const reply = await store.capture({ deviceId, key, meta, frames });
    log('capture', { id: reply.jobId, device: deviceId, mode: meta.mode, frames: frames.length, accepted: frames.filter((f) => f.accepted).length, duplicate: reply.duplicate });
    return send(res, 202, {
      jobId: reply.jobId,
      status: reply.status,
      ...(reply.duplicate ? { duplicate: true } : {}),
      glassesListening: presence.listening(),
    });
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const p = url.pathname;
    if (cfg.corsOrigin) {
      res.setHeader('Access-Control-Allow-Origin', cfg.corsOrigin);
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key, X-Device-Id');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

    if (p === '/v1/healthz' && req.method === 'GET') return send(res, 200, { ok: true });

    if (p === '/v1/captures') {
      if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
      return handleCapture(req, res);
    }

    const cm = /^\/v1\/captures\/([^/]+)$/.exec(p);
    if (cm) {
      if (req.method !== 'GET') throw new HttpError(405, 'method not allowed');
      const deviceId = requireDevice(req);
      const wait = statusLimiter.take(deviceId);
      if (wait > 0) throw new HttpError(429, 'too many status requests', { 'Retry-After': String(wait) });
      const job = UUID_RE.test(cm[1]) ? store.get(cm[1]) : undefined;
      // Another device's job looks the same as a missing one.
      if (!job || job.deviceId !== deviceId) throw new HttpError(404, 'job not found');
      return send(res, 200, { status: job.status, ...(job.result?.retakeReason ? { retakeReason: job.result.retakeReason } : {}) });
    }

    if (p === '/v1/results') {
      if (req.method !== 'GET') throw new HttpError(405, 'method not allowed');
      requireClient(req);
      const rawCursor = url.searchParams.get('cursor') ?? '0';
      if (!/^\d{1,15}$/.test(rawCursor)) throw new HttpError(400, 'cursor must be a non-negative integer');
      const cursor = Number(rawCursor);
      const rawWait = url.searchParams.get('wait') ?? '0';
      if (!/^\d{1,3}$/.test(rawWait)) throw new HttpError(400, 'wait must be 0..30 seconds');
      const wait = Math.min(30, Number(rawWait));
      if (wait > 0) presence.pollStarted();
      try {
        await waitForEvents(cursor, wait * 1000, req);
      } finally {
        if (wait > 0) presence.pollEnded();
      }
      if (res.destroyed) return;
      const page = store.eventsSince(cursor);
      return send(res, 200, { cursor: String(page.cursor), events: page.events, more: page.more });
    }

    if (p === '/v1/acks') {
      if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
      requireClient(req);
      const b = await readJsonBody(req) as { jobId?: unknown; stage?: unknown };
      if (typeof b?.jobId !== 'string' || !UUID_RE.test(b.jobId)) throw new HttpError(400, 'jobId is required');
      if (b.stage !== 'received' && b.stage !== 'displayed') throw new HttpError(400, 'stage must be received or displayed');
      const job = store.get(b.jobId);
      if (!job) throw new HttpError(404, 'job not found');
      const now = Date.now();
      const patch: { receivedAt?: number; displayedAt?: number } = {};
      // Displayed implies received. Each timestamp is set once.
      if (!job.receivedAt) patch.receivedAt = now;
      if (b.stage === 'displayed' && !job.displayedAt) patch.displayedAt = now;
      const updated = Object.keys(patch).length ? await store.update(job.id, patch, { event: false }) : job;
      return send(res, 200, {
        jobId: updated.id,
        receivedAt: updated.receivedAt ? new Date(updated.receivedAt).toISOString() : null,
        displayedAt: updated.displayedAt ? new Date(updated.displayedAt).toISOString() : null,
      });
    }

    if (p === '/v1/presence') {
      if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
      requireClient(req);
      const b = await readJsonBody(req) as { displayMode?: unknown };
      if (!(DISPLAY_MODES as readonly unknown[]).includes(b?.displayMode)) throw new HttpError(400, `displayMode must be one of ${DISPLAY_MODES.join(', ')}`);
      return send(res, 200, await presence.setDisplay(b.displayMode as DisplayMode));
    }

    if (p === '/v1/camera/config') {
      if (req.method === 'GET') {
        requireAny(req);
        return send(res, 200, camera.get());
      }
      if (req.method === 'PUT') {
        requireClient(req);
        const v = validatePatch(await readJsonBody(req));
        if (!v.ok) throw new HttpError(400, v.error);
        return send(res, 200, await camera.update(v.patch));
      }
      throw new HttpError(405, 'method not allowed');
    }

    throw new HttpError(404, 'not found');
  };

  // When a request is refused before its body was read, read and discard the
  // rest if it is of a sane size, so the client sees the status code instead
  // of a connection reset. Anything bigger gets the answer and a closed socket.
  const drain = (req: IncomingMessage): Promise<boolean> => {
    if (req.complete) return Promise.resolve(true);
    const declared = Number(req.headers['content-length'] ?? NaN);
    if (!(declared <= maxCaptureBody)) return Promise.resolve(false);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 10_000);
      req.on('end', () => { clearTimeout(t); resolve(true); });
      req.on('error', () => { clearTimeout(t); resolve(false); });
      req.resume();
    });
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(async (err) => {
      let status = 500;
      let headers: Record<string, string> = {};
      if (err instanceof HttpError) { status = err.status; headers = err.headers; }
      else if (err instanceof RequestError || err instanceof CaptureError) status = err.status;
      if (status === 500) log('http.error', { error: (err as Error)?.message, path: req.url?.split('?')[0] });
      if (res.headersSent || res.destroyed) return;
      const drained = await drain(req);
      if (!drained) headers.Connection = 'close';
      if (res.destroyed) return;
      send(res, status, { error: status === 500 ? 'internal error' : (err as Error).message }, headers);
      if (!drained) req.resume();
    });
  });
  // Long-polls hold a request for up to 30 s, so keep idle sockets a bit longer.
  server.keepAliveTimeout = 35_000;
  server.headersTimeout = 40_000;
  server.requestTimeout = 120_000;
  return server;
}
