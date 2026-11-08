import type { Config } from './config.ts';
import { readJpeg, JpegError } from './jpeg.ts';
import { boundaryFrom, MultipartError, parseMultipart } from './multipart.ts';
import { checkFrame } from './quality.ts';
import type { IncomingFrame } from './store.ts';
import { CAMERA_ISSUES, type CaptureMeta, type FrameMeta } from './types.ts';

export class RequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME_RE = /^[A-Za-z0-9_.-]{1,32}$/;
const FRAME_PART_RE = /^frame([0-2])$/;

const bad = (msg: string) => new RequestError(400, msg);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function validateMeta(raw: unknown, maxFrames: number): CaptureMeta {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('meta must be a JSON object');
  const m = raw as Record<string, unknown>;
  if (m.mode !== 'single' && m.mode !== 'burst' && m.mode !== 'clip') throw bad('meta.mode must be single, burst or clip');
  if (typeof m.capturedAt !== 'string' || m.capturedAt.length > 40 || !Number.isFinite(Date.parse(m.capturedAt))) throw bad('meta.capturedAt must be an ISO 8601 time');
  if (m.battery !== undefined && !(isNum(m.battery) && m.battery >= 0 && m.battery <= 100)) throw bad('meta.battery must be 0..100');
  if (m.appendTo !== undefined && m.appendTo !== 'previous' && !(typeof m.appendTo === 'string' && UUID_RE.test(m.appendTo))) throw bad('meta.appendTo must be a jobId or "previous"');
  if (!Array.isArray(m.frames) || m.frames.length < 1 || m.frames.length > maxFrames) throw bad(`meta.frames must list 1..${maxFrames} frames`);
  if (m.mode === 'single' && m.frames.length !== 1) throw bad('mode single sends exactly one frame');
  const names = new Set<string>();
  const frames: FrameMeta[] = m.frames.map((f: unknown, i: number) => {
    if (!f || typeof f !== 'object') throw bad(`meta.frames[${i}] must be an object`);
    const o = f as Record<string, unknown>;
    if (typeof o.name !== 'string' || !NAME_RE.test(o.name)) throw bad(`meta.frames[${i}].name is invalid`);
    if (names.has(o.name)) throw bad(`meta.frames[${i}].name is duplicated`);
    names.add(o.name);
    if (!(isNum(o.score) && o.score >= 0 && o.score <= 1)) throw bad(`meta.frames[${i}].score must be 0..1`);
    for (const k of ['width', 'height'] as const) {
      const v = o[k];
      if (!(isNum(v) && Number.isInteger(v) && v >= 1 && v <= 10000)) throw bad(`meta.frames[${i}].${k} must be an integer 1..10000`);
    }
    if (o.sharpness !== undefined && !(isNum(o.sharpness) && o.sharpness >= 0)) throw bad(`meta.frames[${i}].sharpness must be >= 0`);
    if (o.brightness !== undefined && !(isNum(o.brightness) && o.brightness >= 0 && o.brightness <= 255)) throw bad(`meta.frames[${i}].brightness must be 0..255`);
    if (o.clipped !== undefined && !(isNum(o.clipped) && o.clipped >= 0 && o.clipped <= 1)) throw bad(`meta.frames[${i}].clipped must be 0..1`);
    if (o.issues !== undefined && !(Array.isArray(o.issues) && o.issues.length <= 8 && o.issues.every((x) => typeof x === 'string' && x.length <= 40))) throw bad(`meta.frames[${i}].issues must be a list of short strings`);
    const out: FrameMeta = { name: o.name, score: o.score, width: o.width as number, height: o.height as number };
    // Unknown issue names are ignored, so a newer camera does not break an older server.
    const issues = Array.isArray(o.issues) ? CAMERA_ISSUES.filter((k) => (o.issues as unknown[]).includes(k)) : [];
    if (issues.length) out.issues = issues;
    if (o.sharpness !== undefined) out.sharpness = o.sharpness as number;
    if (o.brightness !== undefined) out.brightness = o.brightness as number;
    if (o.clipped !== undefined) out.clipped = o.clipped as number;
    return out;
  });
  return {
    mode: m.mode, capturedAt: m.capturedAt, frames,
    ...(m.battery !== undefined ? { battery: m.battery as number } : {}),
    ...(m.appendTo !== undefined ? { appendTo: m.appendTo as string } : {}),
  };
}

type ParseConfig = Pick<Config, 'maxFrameBytes' | 'maxFramesPerCapture' | 'minFrameWidth' | 'minFrameHeight' | 'minFrameScore' | 'minBytesPerPixel'>;

// Parses and validates a POST /v1/captures body. Throws RequestError with
// 400 (malformed), 413 (a frame too large) or 415 (not a JPEG).
export function parseCapture(body: Buffer, contentType: string | undefined, cfg: ParseConfig): { meta: CaptureMeta; frames: IncomingFrame[] } {
  let parts;
  try {
    parts = parseMultipart(body, boundaryFrom(contentType));
  } catch (err) {
    if (err instanceof MultipartError) throw bad(err.message);
    throw err;
  }
  let metaRaw: unknown;
  let haveMeta = false;
  const frameParts = new Map<number, Buffer>();
  for (const p of parts) {
    if (p.name === 'meta') {
      if (haveMeta) throw bad('duplicate meta part');
      haveMeta = true;
      try {
        metaRaw = JSON.parse(p.data.toString('utf8'));
      } catch {
        throw bad('meta is not valid JSON');
      }
      continue;
    }
    const m = FRAME_PART_RE.exec(p.name);
    if (!m) throw bad(`unexpected part "${p.name.slice(0, 20)}"`);
    const i = Number(m[1]);
    if (frameParts.has(i)) throw bad(`duplicate part ${p.name}`);
    if (p.contentType !== 'image/jpeg') throw new RequestError(415, `${p.name} must be image/jpeg`);
    if (p.data.length > cfg.maxFrameBytes) throw new RequestError(413, `${p.name} is larger than ${cfg.maxFrameBytes} bytes`);
    frameParts.set(i, p.data);
  }
  if (!haveMeta) throw bad('missing meta part');
  const meta = validateMeta(metaRaw, cfg.maxFramesPerCapture);
  if (frameParts.size !== meta.frames.length) throw bad(`meta lists ${meta.frames.length} frames but ${frameParts.size} were sent`);
  const frames: IncomingFrame[] = meta.frames.map((fm, i) => {
    const data = frameParts.get(i);
    if (!data) throw bad(`missing part frame${i}`);
    let info;
    try {
      info = readJpeg(data);
    } catch (err) {
      if (err instanceof JpegError) throw new RequestError(415, `frame${i}: ${err.message}`);
      throw err;
    }
    if (info.width !== fm.width || info.height !== fm.height) throw bad(`frame${i} is ${info.width}x${info.height} but meta says ${fm.width}x${fm.height}`);
    const v = checkFrame(fm, info, data.length, cfg);
    return { meta: fm, data, width: info.width, height: info.height, accepted: v.accepted, ...(v.reason ? { rejectReason: v.reason } : {}) };
  });
  return { meta, frames };
}
