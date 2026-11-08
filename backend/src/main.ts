import { loadConfig } from './config.ts';
import { createApp } from './app.ts';
import { createProvider } from './providers/index.ts';

// Logs carry IDs, counts and timings only, never answer text or image data.
const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

const cfg = loadConfig();
const provider = await createProvider(cfg.aiProvider);
const app = await createApp(cfg, provider, log);

app.server.listen(cfg.port, cfg.host, () => {
  log('listening', { host: cfg.host, port: cfg.port, provider: provider.name, model: provider.model });
  if (cfg.host !== '127.0.0.1' && cfg.host !== '::1' && cfg.host !== 'localhost') {
    log('warning', { note: 'listening beyond localhost; put TLS in front of this server' });
  }
});

let closing = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (closing) return;
    closing = true;
    setTimeout(() => process.exit(1), 5000).unref();
    void app.close().then(() => process.exit(0));
  });
}
