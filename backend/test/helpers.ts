import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../src/config.ts';
import { createApp, type App } from '../src/app.ts';
import { sha256Hex } from '../src/auth.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { makeTestJpeg } from '../src/testing/jpeg.ts';
import type { FrameMeta, FusionProvider } from '../src/types.ts';

export const DEVICE = 'device-secret-token-cam1';
export const DEVICE2 = 'device-secret-token-cam2';
export const CLIENT = 'client-secret-token';
export const VENV_PYTHON = path.resolve(import.meta.dirname, '../.venv/bin/python');
export const HAVE_SYMPY = existsSync(VENV_PYTHON);

export function testEnv(dataDir: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    DEVICE_TOKENS: `cam1:${sha256Hex(DEVICE)},cam2:${sha256Hex(DEVICE2)}`,
    CLIENT_TOKEN_SHA256: sha256Hex(CLIENT),
    DATA_DIR: dataDir,
    RETRY_BASE_MS: '20',
    AI_TIMEOUT_MS: '3000',
    VERIFY_MATH: 'false',
    PYTHON_BIN: VENV_PYTHON,
    APPEND_WINDOW_MS: '60000',
    SWEEP_INTERVAL_MS: '3600000',
    POLL_GRACE_MS: '200',
    ...extra,
  };
}

export interface FrameSpec {
  jpeg?: Buffer;
  comment?: string;
  meta?: Partial<FrameMeta>;
  width?: number;
  height?: number;
  bytes?: number;
}

export interface CaptureOptions {
  key?: string;
  token?: string;
  mode?: 'single' | 'burst' | 'clip';
  appendTo?: string;
  frames?: FrameSpec[];
  headers?: Record<string, string>;
  metaOverride?: Record<string, unknown>;
}

export function multipart(parts: Array<{ name: string; type: string; data: Buffer | string }>, boundary = `----evtest${randomBytes(6).toString('hex')}`) {
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const file = p.type === 'image/jpeg' ? `; filename="${p.name}.jpg"` : '';
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"${file}\r\nContent-Type: ${p.type}\r\n\r\n`));
    chunks.push(typeof p.data === 'string' ? Buffer.from(p.data) : p.data);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

export function captureBody(opts: CaptureOptions = {}) {
  const specs = opts.frames ?? [{}, {}, {}];
  const metas: FrameMeta[] = [];
  const parts: Array<{ name: string; type: string; data: Buffer }> = [];
  specs.forEach((s, i) => {
    const width = s.width ?? 1600;
    const height = s.height ?? 1200;
    const jpeg = s.jpeg ?? makeTestJpeg({ width, height, comment: s.comment, bytes: s.bytes });
    metas.push({ name: `f${i}`, score: Math.round((0.8 - i * 0.1) * 100) / 100, width, height, ...s.meta });
    parts.push({ name: `frame${i}`, type: 'image/jpeg', data: jpeg });
  });
  const meta = {
    mode: opts.mode ?? (specs.length === 1 ? 'single' : 'burst'),
    capturedAt: new Date().toISOString(),
    battery: 80,
    frames: metas,
    ...(opts.appendTo ? { appendTo: opts.appendTo } : {}),
    ...opts.metaOverride,
  };
  return multipart([{ name: 'meta', type: 'application/json', data: Buffer.from(JSON.stringify(meta)) }, ...parts]);
}

export type TestApp = Awaited<ReturnType<typeof startApp>>;

export async function startApp(opts: { provider?: FusionProvider; env?: Record<string, string>; dataDir?: string } = {}) {
  const dataDir = opts.dataDir ?? await mkdtemp(path.join(tmpdir(), 'g2-backend-'));
  const cfg = loadConfig(testEnv(dataDir, opts.env));
  const provider = opts.provider ?? new MockProvider();
  const app: App = await createApp(cfg, provider);
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  let closed = false;
  return {
    ...app, base, dataDir, provider,
    async close(removeData = !opts.dataDir) {
      if (!closed) { closed = true; await app.close(); }
      if (removeData) await rm(dataDir, { recursive: true, force: true });
    },
    capture(o: CaptureOptions = {}) {
      const { body, contentType } = captureBody(o);
      return this.rawCapture(body, contentType, o);
    },
    rawCapture(body: Buffer, contentType: string, o: CaptureOptions = {}) {
      return fetch(`${base}/v1/captures`, {
        method: 'POST', body: new Uint8Array(body),
        headers: {
          Authorization: `Bearer ${o.token ?? DEVICE}`,
          'Idempotency-Key': o.key ?? `cap-${randomBytes(6).toString('hex')}`,
          'Content-Type': contentType,
          ...o.headers,
        },
      });
    },
    get(p: string, token = CLIENT) {
      return fetch(`${base}${p}`, { headers: { Authorization: `Bearer ${token}` } });
    },
    send(method: string, p: string, body: unknown, token = CLIENT) {
      return fetch(`${base}${p}`, {
        method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
    },
    async events(cursor = '0', wait = 0) {
      const r = await fetch(`${base}/v1/results?cursor=${cursor}&wait=${wait}`, { headers: { Authorization: `Bearer ${CLIENT}` } });
      return r.json() as Promise<{ cursor: string; more: boolean; events: Array<Record<string, any>> }>;
    },
    // Waits until the job reaches one of the given statuses.
    async waitFor(jobId: string, statuses: string[] = ['ready', 'retake', 'failed'], timeoutMs = 4000) {
      return until(() => { const j = app.store.get(jobId); return j && statuses.includes(j.status) ? j : undefined; }, timeoutMs);
    },
  };
}

export async function until<T>(fn: () => T | undefined | false | null, timeoutMs = 3000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condition not met in time');
}
