import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { DEVICE_ID_RE, type Config } from './config.ts';

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function eqHex(a: Buffer, hex: string): boolean {
  const b = Buffer.from(hex, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function bearer(req: IncomingMessage): string {
  const h = req.headers.authorization ?? '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

interface AuthData {
  devices: Map<string, string>;
  clients: string[];
}

// Holds the accepted tokens. Each device token is bound to exactly one device
// ID, so a stolen token cannot pose as another camera. When AUTH_FILE is set,
// the file is re-read whenever its modification time changes, so a lost
// camera's token can be revoked without restarting the server.
//
// AUTH_FILE format: {"devices": {"cam1": "<sha256>"}, "clients": ["<sha256>"]}
// File entries are added to the ones from the environment.
export class AuthRegistry {
  private readonly envData: AuthData;
  private fileData: AuthData = { devices: new Map(), clients: [] };
  private readonly file: string;
  private fileMtime = -1;
  private lastCheck = 0;

  constructor(cfg: Pick<Config, 'deviceTokens' | 'clientTokenHashes' | 'authFile'>) {
    this.envData = { devices: cfg.deviceTokens, clients: cfg.clientTokenHashes };
    this.file = cfg.authFile;
    this.reloadIfChanged(true);
  }

  private reloadIfChanged(force = false): void {
    if (!this.file) return;
    const now = Date.now();
    if (!force && now - this.lastCheck < 1000) return;
    this.lastCheck = now;
    let mtime: number;
    try {
      mtime = statSync(this.file).mtimeMs;
    } catch {
      // A missing file means "no extra tokens", which also revokes all file tokens.
      this.fileData = { devices: new Map(), clients: [] };
      this.fileMtime = -1;
      return;
    }
    if (mtime === this.fileMtime) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { devices?: Record<string, string>; clients?: string[] };
      const devices = new Map<string, string>();
      for (const [id, h] of Object.entries(raw.devices ?? {})) {
        if (DEVICE_ID_RE.test(id) && /^[0-9a-f]{64}$/i.test(h)) devices.set(id, h.toLowerCase());
      }
      const clients = (raw.clients ?? []).filter((h) => /^[0-9a-f]{64}$/i.test(h)).map((h) => h.toLowerCase());
      this.fileData = { devices, clients };
      this.fileMtime = mtime;
    } catch {
      // Keep the previous data if the file is half-written; retry on the next check.
    }
  }

  // Returns the device ID bound to this token, or null. Every candidate is
  // compared, so timing does not depend on which entry matched.
  device(token: string): string | null {
    if (!token) return null;
    this.reloadIfChanged();
    const presented = Buffer.from(sha256Hex(token), 'hex');
    let found: string | null = null;
    for (const src of [this.envData.devices, this.fileData.devices]) {
      for (const [id, h] of src) if (eqHex(presented, h) && found === null) found = id;
    }
    return found;
  }

  client(token: string): boolean {
    if (!token) return false;
    this.reloadIfChanged();
    const presented = Buffer.from(sha256Hex(token), 'hex');
    let ok = false;
    for (const h of [...this.envData.clients, ...this.fileData.clients]) if (eqHex(presented, h)) ok = true;
    return ok;
  }

  hasAny(): boolean {
    this.reloadIfChanged(true);
    const d = this.envData.devices.size + this.fileData.devices.size;
    const c = this.envData.clients.length + this.fileData.clients.length;
    return d > 0 && c > 0;
  }
}
