import path from 'node:path';
import { atomicWrite, readJson } from './fsutil.ts';

// Camera settings, fetched by the camera at wake (GET /v1/camera/config) and
// changed from the phone panel (PUT). There is deliberately no field that
// turns off the LED, starts a capture, or enables audio: those are not
// settings, they are fixed in the firmware.
export const RESOLUTIONS = ['1280x720', '1600x1200', '1920x1080', '2048x1536', '2592x1944'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

export interface CameraConfig {
  version: number; // bumped on every change, so the camera can tell it is current
  updatedAt: string;
  defaultMode: 'burst' | 'single'; // what a single press does
  burstFrames: number; // N frames captured per burst, 1..8
  uploadFrames: number; // K best frames uploaded, 1..3
  longPressMode: 'clip' | 'burst'; // Linux: clip; ESP32 always does an 8-frame burst
  clipSeconds: number; // 1..4, Linux only
  resolution: Resolution;
  jpegQuality: number; // 50..95
  minUploadScore: number; // 0..1; frames below this are not uploaded if a better one exists
  statusPollSeconds: number; // how long the camera polls job status after upload, 0..60
}

export const DEFAULT_CAMERA_CONFIG: Omit<CameraConfig, 'version' | 'updatedAt'> = {
  defaultMode: 'burst',
  burstFrames: 4,
  uploadFrames: 3,
  longPressMode: 'clip',
  clipSeconds: 2,
  resolution: '2048x1536',
  jpegQuality: 85,
  minUploadScore: 0.15,
  statusPollSeconds: 30,
};

type Editable = Omit<CameraConfig, 'version' | 'updatedAt'>;

function intIn(v: unknown, lo: number, hi: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
}

// Validates a PUT body. Unknown fields are an error, so a typo is not silently ignored.
export function validatePatch(body: unknown): { ok: true; patch: Partial<Editable> } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'body must be a JSON object' };
  const b = body as Record<string, unknown>;
  const patch: Partial<Editable> = {};
  for (const [k, v] of Object.entries(b)) {
    switch (k) {
      case 'defaultMode':
        if (v !== 'burst' && v !== 'single') return { ok: false, error: 'defaultMode must be burst or single' };
        patch.defaultMode = v; break;
      case 'burstFrames':
        if (!intIn(v, 1, 8)) return { ok: false, error: 'burstFrames must be an integer 1..8' };
        patch.burstFrames = v; break;
      case 'uploadFrames':
        if (!intIn(v, 1, 3)) return { ok: false, error: 'uploadFrames must be an integer 1..3' };
        patch.uploadFrames = v; break;
      case 'longPressMode':
        if (v !== 'clip' && v !== 'burst') return { ok: false, error: 'longPressMode must be clip or burst' };
        patch.longPressMode = v; break;
      case 'clipSeconds':
        if (!intIn(v, 1, 4)) return { ok: false, error: 'clipSeconds must be an integer 1..4' };
        patch.clipSeconds = v; break;
      case 'resolution':
        if (!(RESOLUTIONS as readonly unknown[]).includes(v)) return { ok: false, error: `resolution must be one of ${RESOLUTIONS.join(', ')}` };
        patch.resolution = v as Resolution; break;
      case 'jpegQuality':
        if (!intIn(v, 50, 95)) return { ok: false, error: 'jpegQuality must be an integer 50..95' };
        patch.jpegQuality = v; break;
      case 'minUploadScore':
        if (typeof v !== 'number' || !(v >= 0 && v <= 1)) return { ok: false, error: 'minUploadScore must be a number 0..1' };
        patch.minUploadScore = v; break;
      case 'statusPollSeconds':
        if (!intIn(v, 0, 60)) return { ok: false, error: 'statusPollSeconds must be an integer 0..60' };
        patch.statusPollSeconds = v; break;
      case 'version':
      case 'updatedAt':
        break; // read-only, ignored so a client can PUT back what it got
      default:
        return { ok: false, error: `unknown field ${k}` };
    }
  }
  return { ok: true, patch };
}

export class CameraConfigStore {
  private cfg: CameraConfig = { version: 1, updatedAt: new Date(0).toISOString(), ...DEFAULT_CAMERA_CONFIG };
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'state', 'camera-config.json');
  }

  async open(): Promise<void> {
    const saved = await readJson<Partial<CameraConfig>>(this.file);
    if (!saved) return;
    // Re-validate what is on disk; a bad file falls back to defaults field by field.
    const v = validatePatch(Object.fromEntries(Object.entries(saved).filter(([k]) => k !== 'version' && k !== 'updatedAt')));
    if (v.ok) this.cfg = { ...this.cfg, ...v.patch };
    if (typeof saved.version === 'number') this.cfg.version = saved.version;
    if (typeof saved.updatedAt === 'string') this.cfg.updatedAt = saved.updatedAt;
  }

  get(): CameraConfig {
    return { ...this.cfg };
  }

  async update(patch: Partial<Editable>): Promise<CameraConfig> {
    const next: CameraConfig = { ...this.cfg, ...patch, version: this.cfg.version + 1, updatedAt: new Date().toISOString() };
    if (next.uploadFrames > next.burstFrames) next.uploadFrames = Math.min(3, next.burstFrames);
    this.cfg = next;
    await atomicWrite(this.file, JSON.stringify(next));
    return { ...next };
  }
}
