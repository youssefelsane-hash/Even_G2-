import { mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { get } from 'node:http';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const app = fileURLToPath(new URL('../', import.meta.url));
const addresses = Object.entries(networkInterfaces()).flatMap(([name, entries]) =>
  (entries ?? []).filter((entry) => entry.family === 'IPv4' && !entry.internal &&
    !entry.address.startsWith('169.254.')).map((entry) => ({ name, address: entry.address })),
);
const network = addresses.find((entry) => entry.name === 'en0') ??
  addresses.find((entry) => entry.name.startsWith('en')) ?? addresses[0];
if (!network) {
  console.error('Connect the Mac and phone to the same Wi-Fi, then run npm run qr again.');
  process.exit(1);
}
const url = `http://${network.address}:5174`;
try {
  await new Promise((resolve, reject) => {
    const request = get(url, { agent: false, timeout: 2500 }, (response) => {
      response.resume();
      if (response.statusCode === 200) resolve();
      else reject(new Error(`HTTP ${response.statusCode}`));
    });
    request.on('timeout', () => request.destroy(new Error('The server did not respond.')));
    request.on('error', reject);
  });
} catch {
  console.error(`The app is not reachable at ${url}. Start npm run dev:glasses in another Terminal.`);
  process.exit(1);
}

// QR generation needs no login. Keep its URL cache beside the development app.
const config = join(app, '.evenhub-dev');
mkdirSync(config, { recursive: true });
console.log(`G2 Assistant is running at ${url}`);
console.log('On the phone, open Even Realities → Even Hub → Scan QR. Keep the server Terminal open.');
const result = spawnSync(join(app, 'node_modules', '.bin', 'evenhub'), ['qr', '--url', url], {
  cwd: app,
  env: { ...process.env, XDG_CONFIG_HOME: config },
  stdio: 'inherit',
});
if (result.error) console.error(`Could not run the QR tool. Run npm install first. ${result.error.message}`);
process.exitCode = result.status ?? 1;
