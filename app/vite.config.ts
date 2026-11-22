import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
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

// Development only: hands the local backend's tokens to the glasses app and the
// phone photo page, so nobody types a 32-character token on a phone. The tokens
// live in app/.dev-backend.local (git-ignored, written when the local backend
// was set up). Only addresses on this computer or the home network get them;
// anyone else on that network could, so use this on a network you trust.
const DEV_BACKEND_FILE = '.dev-backend.local';

function isPrivate(addr: string | undefined): boolean {
  const a = (addr ?? '').replace(/^::ffff:/, '');
  return a === '::1' || a === '127.0.0.1' || /^10\./.test(a) || /^192\.168\./.test(a) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(a) || /^169\.254\./.test(a);
}

function devBackend(): Plugin {
  return {
    name: 'g2-dev-backend',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__dev/backend', (req, res) => {
        let tokens: { clientToken?: string; deviceToken?: string; deviceId?: string } = {};
        try { tokens = JSON.parse(readFileSync(DEV_BACKEND_FILE, 'utf8')) as typeof tokens; } catch { /* not set up */ }
        if (!isPrivate(req.socket.remoteAddress) || !tokens.clientToken) { res.statusCode = 404; res.end(); return; }
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'no-store');
        res.end(JSON.stringify(tokens));
      });
    },
  };
}

// Relative asset paths, so the packed app works wherever the host serves it from.
// In development, /v1 goes to the local backend (backend/, port 8787), so the
// glasses app and the phone page reach it through the address they already use.
export default defineConfig({
  base: './',
  plugins: [devLog(), devBackend()],
  server: {
    proxy: {
      '/v1': { target: 'http://127.0.0.1:8787', changeOrigin: true, timeout: 60_000, proxyTimeout: 60_000 },
    },
  },
});
