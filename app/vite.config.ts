import { appendFileSync, mkdirSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

// Development only: the app on the phone posts its console lines, state and raw
// IMU samples here, and they are appended to app/.devlog/session.jsonl. Real
// glasses cannot be debugged remotely (the Even app's WebView is not
// debuggable), so this is how logs from real hardware reach the computer.
// Never part of a build: `apply: 'serve'`, and the client side is DEV-only.
function devLog(): Plugin {
  return {
    name: 'g2-devlog',
    apply: 'serve',
    configureServer(server) {
      mkdirSync('.devlog', { recursive: true });
      server.middlewares.use('/__devlog', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        let body = '';
        req.on('data', (c: Buffer) => { body += c.toString('utf8'); if (body.length > 2_000_000) req.destroy(); });
        req.on('end', () => {
          try {
            const lines = (JSON.parse(body) as unknown[]).map((l) => JSON.stringify(l)).join('\n');
            if (lines) appendFileSync('.devlog/session.jsonl', `${lines}\n`);
            res.statusCode = 204;
          } catch {
            res.statusCode = 400;
          }
          res.end();
        });
      });
    },
  };
}

// Relative asset paths, so the packed app works wherever the host serves it from.
export default defineConfig({ base: './', plugins: [devLog()] });
