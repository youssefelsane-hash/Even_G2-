// Prints a new random token and the line to put in the server's .env.
// Usage:
//   node scripts/make-token.mjs device cam1   -> token for camera "cam1"
//   node scripts/make-token.mjs client        -> token for the glasses app / phone panel
// The raw token is shown once. Only its SHA-256 digest goes on the server.
import { createHash, randomBytes } from 'node:crypto';

const role = process.argv[2] ?? 'device';
const token = randomBytes(24).toString('base64url');
const hash = createHash('sha256').update(token).digest('hex');
if (role === 'client') {
  console.log(`token (give to the glasses app, keep secret): ${token}`);
  console.log(`CLIENT_TOKEN_SHA256=${hash}   (comma-separate several)`);
} else {
  const id = process.argv[3] ?? 'cam1';
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) { console.error('device id: letters, digits, _ and - only'); process.exit(1); }
  console.log(`token (put in the camera's config, keep secret): ${token}`);
  console.log(`DEVICE_TOKENS=${id}:${hash}   (comma-separate several devices)`);
}
