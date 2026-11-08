// All runtime settings come from environment variables, so no key, token or
// provider choice is compiled into the camera firmware or the glasses app.

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  // deviceId -> SHA-256 hex digest of that device's token. Raw tokens are never stored.
  deviceTokens: Map<string, string>;
  clientTokenHashes: string[];
  // Optional JSON file with the same data, re-read when it changes (revocation without restart).
  authFile: string;
  maxFrameBytes: number;
  maxFramesPerCapture: number;
  maxPages: number;
  maxAiImages: number;
  maxAiBytes: number;
  minFrameWidth: number;
  minFrameHeight: number;
  minFrameScore: number;
  minBytesPerPixel: number;
  aiProvider: string;
  aiTimeoutMs: number;
  answerLanguage: string;
  maxAttempts: number;
  retryBaseMs: number;
  verifyMath: boolean;
  pythonBin: string;
  appendWindowMs: number; // finished jobs keep images this long so a double press can add a page
  appendMaxAgeMs: number; // 'previous' only matches a job this recent
  imageMaxAgeMs: number; // hard limit for any image on disk
  resultTtlMs: number;
  sweepIntervalMs: number;
  capturesPerMinute: number;
  statusPollsPerMinute: number;
  authFailuresPerMinute: number;
  authBlockMs: number;
  trustProxy: boolean;
  corsOrigin: string;
  pollGraceMs: number;
}

function int(v: string | undefined, def: number): number {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : def;
}

function num(v: string | undefined, def: number): number {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : def;
}

function list(v: string | undefined): string[] {
  return (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

const HASH_RE = /^[0-9a-f]{64}$/;
export const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

// DEVICE_TOKENS="cam1:<sha256>,cam2:<sha256>"
export function parseDeviceTokens(v: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of list(v)) {
    const i = entry.indexOf(':');
    const id = entry.slice(0, i);
    const hash = entry.slice(i + 1).toLowerCase();
    if (i <= 0 || !DEVICE_ID_RE.test(id) || !HASH_RE.test(hash)) {
      throw new Error(`DEVICE_TOKENS entry must be <deviceId>:<sha256 hex>, got "${entry.slice(0, 20)}..."`);
    }
    out.set(id, hash);
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg: Config = {
    port: int(env.PORT, 8787),
    // Plain HTTP: put TLS in a reverse proxy and keep Node on localhost.
    host: env.HOST ?? '127.0.0.1',
    dataDir: env.DATA_DIR ?? './data',
    deviceTokens: parseDeviceTokens(env.DEVICE_TOKENS),
    clientTokenHashes: list(env.CLIENT_TOKEN_SHA256).map((h) => h.toLowerCase()),
    authFile: env.AUTH_FILE ?? '',
    maxFrameBytes: int(env.MAX_FRAME_BYTES, 2_621_440), // 2.5 MiB
    maxFramesPerCapture: 3,
    maxPages: int(env.MAX_PAGES, 4), // CAPTURE-STRATEGY.md: 4 pages, 12 images per AI request
    maxAiImages: int(env.MAX_AI_IMAGES, 12),
    maxAiBytes: int(env.MAX_AI_BYTES, 20 * 1024 * 1024),
    minFrameWidth: int(env.MIN_FRAME_WIDTH, 480),
    minFrameHeight: int(env.MIN_FRAME_HEIGHT, 360),
    minFrameScore: num(env.MIN_FRAME_SCORE, 0.15),
    minBytesPerPixel: num(env.MIN_BYTES_PER_PIXEL, 0.01),
    aiProvider: env.AI_PROVIDER ?? 'anthropic',
    aiTimeoutMs: int(env.AI_TIMEOUT_MS, 90_000),
    answerLanguage: env.ANSWER_LANGUAGE ?? 'English',
    maxAttempts: int(env.MAX_ATTEMPTS, 3),
    retryBaseMs: int(env.RETRY_BASE_MS, 2_000),
    verifyMath: (env.VERIFY_MATH ?? 'true') !== 'false',
    pythonBin: env.PYTHON_BIN ?? 'python3',
    appendWindowMs: int(env.APPEND_WINDOW_MS, 120_000),
    appendMaxAgeMs: int(env.APPEND_MAX_AGE_MS, 600_000),
    imageMaxAgeMs: int(env.IMAGE_MAX_AGE_MS, 3_600_000),
    resultTtlMs: int(env.RESULT_TTL_MS, 30 * 24 * 3_600_000),
    sweepIntervalMs: int(env.SWEEP_INTERVAL_MS, 30_000),
    capturesPerMinute: int(env.CAPTURES_PER_MINUTE, 10),
    statusPollsPerMinute: int(env.STATUS_POLLS_PER_MINUTE, 120),
    authFailuresPerMinute: int(env.AUTH_FAILURES_PER_MINUTE, 10),
    authBlockMs: int(env.AUTH_BLOCK_MS, 60_000),
    trustProxy: env.TRUST_PROXY === 'true',
    corsOrigin: env.CORS_ORIGIN ?? '*',
    pollGraceMs: int(env.POLL_GRACE_MS, 5_000),
  };
  if ((cfg.deviceTokens.size === 0 || cfg.clientTokenHashes.length === 0) && !cfg.authFile) {
    throw new Error('Set DEVICE_TOKENS and CLIENT_TOKEN_SHA256, or AUTH_FILE (see .env.example)');
  }
  for (const h of cfg.clientTokenHashes) {
    if (!HASH_RE.test(h)) throw new Error('CLIENT_TOKEN_SHA256 must be comma-separated SHA-256 hex digests');
  }
  // The hard limit wins over the append window.
  if (cfg.appendWindowMs > cfg.imageMaxAgeMs) cfg.appendWindowMs = cfg.imageMaxAgeMs;
  if (cfg.maxFrameBytes > 2_621_440) throw new Error('MAX_FRAME_BYTES may not exceed 2.5 MiB (API contract)');
  return cfg;
}
