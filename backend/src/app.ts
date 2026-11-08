import type { Server } from 'node:http';
import type { Config } from './config.ts';
import { JobStore } from './store.ts';
import { Worker, type Log } from './worker.ts';
import { buildServer } from './server.ts';
import { AuthRegistry } from './auth.ts';
import { Presence } from './presence.ts';
import { CameraConfigStore } from './cameraConfig.ts';
import type { FusionProvider } from './types.ts';

export interface App {
  cfg: Config;
  store: JobStore;
  worker: Worker;
  server: Server;
  presence: Presence;
  camera: CameraConfigStore;
  auth: AuthRegistry;
  close(): Promise<void>;
}

// Wires the parts together. Used by main.ts and by the tests, so both run
// exactly the same code.
export async function createApp(cfg: Config, provider: FusionProvider, log: Log = () => {}): Promise<App> {
  const auth = new AuthRegistry(cfg);
  if (!auth.hasAny()) throw new Error('No device or client token is configured');
  const store = new JobStore(cfg.dataDir, {
    appendMaxAgeMs: cfg.appendMaxAgeMs,
    maxPages: cfg.maxPages,
    appendWindowMs: cfg.appendWindowMs,
    imageMaxAgeMs: cfg.imageMaxAgeMs,
    resultTtlMs: cfg.resultTtlMs,
  });
  await store.open();
  const presence = new Presence(cfg.dataDir, cfg.pollGraceMs);
  await presence.load();
  const camera = new CameraConfigStore(cfg.dataDir);
  await camera.open();
  const worker = new Worker(store, provider, cfg, log);
  await worker.start();
  const server = buildServer({ cfg, store, auth, presence, camera, log });
  return {
    cfg, store, worker, server, presence, camera, auth,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await worker.stop();
      await store.close();
    },
  };
}
