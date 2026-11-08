// Full-system end-to-end test: backend (mock AI) + Linux camera client (fake
// sensor, fake button) + glasses app in the official Even Hub simulator.
//
//   node tools/e2e-system/run.mjs [--only name,name] [--screens dir] [--keep-tmp]
//
// Everything runs on 127.0.0.1. Tokens are generated for the run and never
// written to the repo. Two small TCP proxies sit between the backend and its
// clients so the test can cut the camera's or the glasses app's network on its
// own. Every process started here is stopped at the end, also on failure.
// Nothing here touches real hardware. See README.md in this folder.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { inflateSync } from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const APP = path.join(ROOT, 'app');
const BACKEND = path.join(ROOT, 'backend');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const ONLY = opt('--only')?.split(',') ?? null;
const SCREENS = path.resolve(opt('--screens') ?? path.join(ROOT, 'docs', 'screenshots'));
const KEEP_TMP = args.includes('--keep-tmp');
const SIM_PORT = 9898;
const VITE_PORT = 5174;
const MOCK_DELAY_MS = 3000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...a);

// ---------------------------------------------------------------- helpers

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function portBusy(port) {
  return new Promise((resolve) => {
    const c = net.connect(port, '127.0.0.1');
    c.once('connect', () => { c.destroy(); resolve(true); });
    c.once('error', () => resolve(false));
  });
}

async function until(what, fn, ms = 30_000, every = 250) {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for: ${what}`);
    await sleep(every);
  }
}

// Minimal decoder for 8-bit RGBA PNGs (the simulator's screenshot format).
function decodePng(buf) {
  let pos = 8; let width = 0; let height = 0; const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error('expected 8-bit RGBA, not interlaced');
    } else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4; const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= 4 ? px[y * stride + x - 4] : 0;
      const b = y ? px[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y ? px[(y - 1) * stride + x - 4] : 0;
      let p = 0;
      if (f === 1) p = a; else if (f === 2) p = b; else if (f === 3) p = (a + b) >> 1;
      else if (f === 4) { const q = a + b - c; const pa = Math.abs(q - a); const pb = Math.abs(q - b); const pc = Math.abs(q - c); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[y * stride + x] = (v + p) & 255;
    }
  }
  return { width, height, px };
}
const litPixels = ({ px }) => { let n = 0; for (let i = 3; i < px.length; i += 4) if (px[i] > 0) n++; return n; };

// ---------------------------------------------------------------- toggleable TCP proxy

function makeProxy(name, target) {
  const p = { name, mode: 'up', dropNextCaptureReply: false, dropped: 0, conns: new Set() };
  p.server = net.createServer((c) => {
    if (p.mode === 'down') { c.destroy(); return; }
    const u = net.connect(target(), '127.0.0.1');
    const pair = { c, u };
    p.conns.add(pair);
    let first = true; let capture = false;
    const kill = () => { c.destroy(); u.destroy(); p.conns.delete(pair); };
    c.on('data', (d) => {
      if (first) { first = false; capture = d.toString('latin1', 0, 24).startsWith('POST /v1/captures'); }
      u.write(d);
    });
    u.on('data', (d) => {
      // The request reached the server, the reply is lost: the camera must retry with the same key.
      if (capture && p.dropNextCaptureReply) { p.dropNextCaptureReply = false; p.dropped++; kill(); return; }
      c.write(d);
    });
    c.on('end', () => u.end()); u.on('end', () => c.end());
    c.on('error', kill); u.on('error', kill);
    c.on('close', kill); u.on('close', kill);
  });
  p.setMode = (m) => { p.mode = m; if (m === 'down') for (const x of [...p.conns]) { x.c.destroy(); x.u.destroy(); } p.conns.clear(); log(`network ${name}: ${m}`); };
  p.listen = (port) => new Promise((r) => p.server.listen(port, '127.0.0.1', r));
  p.close = () => new Promise((r) => { p.setMode('down'); p.server.close(() => r()); });
  return p;
}

// ---------------------------------------------------------------- run state

const children = new Set();
function track(child, label) {
  children.add(child);
  child.on('exit', (code, sig) => { children.delete(child); if (!stopping) log(`${label} exited (${code ?? sig})`); });
  return child;
}
let stopping = false;

const tmpBase = process.env.E2E_TMP ?? os.tmpdir();
await mkdir(tmpBase, { recursive: true });
const tmp = await mkdtemp(path.join(tmpBase, 'even-g2-e2e-'));
const dataDir = path.join(tmp, 'backend-data');
const camState = path.join(tmp, 'camera-state');
const deviceToken = randomBytes(24).toString('base64url');
const clientToken = randomBytes(24).toString('base64url');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const ports = { backend: await freePort(), camProxy: await freePort(), appProxy: await freePort(), ctl: await freePort() };
const backendLog = [];

// ---------------------------------------------------------------- backend

let backend = null;
async function startBackend() {
  const py = path.join(BACKEND, '.venv', 'bin', 'python');
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME,
    PORT: String(ports.backend), HOST: '127.0.0.1', DATA_DIR: dataDir,
    DEVICE_TOKENS: `cam1:${sha(deviceToken)}`, CLIENT_TOKEN_SHA256: sha(clientToken),
    AI_PROVIDER: 'mock', MOCK_DELAY_MS: String(MOCK_DELAY_MS),
    VERIFY_MATH: existsSync(py) ? 'true' : 'false', PYTHON_BIN: py,
    APPEND_WINDOW_MS: '20000', SWEEP_INTERVAL_MS: '2000', RETRY_BASE_MS: '500',
    CAPTURES_PER_MINUTE: '120', STATUS_POLLS_PER_MINUTE: '600', CORS_ORIGIN: '*',
  };
  backend = track(spawn(process.execPath, ['src/main.ts'], { cwd: BACKEND, env, stdio: ['ignore', 'pipe', 'pipe'] }), 'backend');
  const rl = createInterface({ input: backend.stdout });
  rl.on('line', (l) => backendLog.push(l));
  backend.stderr.on('data', (d) => backendLog.push(`ERR ${d}`));
  await until('backend health', async () => {
    try { return (await fetch(`http://127.0.0.1:${ports.backend}/v1/healthz`)).ok; } catch { return false; }
  }, 20_000);
}
async function killBackend(signal = 'SIGKILL') {
  const b = backend;
  if (!b || b.exitCode !== null) return;
  const done = new Promise((r) => b.once('exit', r));
  b.kill(signal);
  await done;
}

// Read-only view of the backend, as the phone panel would see it (client token).
async function serverEvents() {
  const r = await fetch(`http://127.0.0.1:${ports.backend}/v1/results?cursor=0&wait=0`, { headers: { Authorization: `Bearer ${clientToken}` } });
  const all = [];
  let body = await r.json();
  all.push(...body.events);
  while (body.more) {
    body = await (await fetch(`http://127.0.0.1:${ports.backend}/v1/results?cursor=${body.cursor}&wait=0`, { headers: { Authorization: `Bearer ${clientToken}` } })).json();
    all.push(...body.events);
  }
  const jobs = new Map();
  for (const e of all) if (!jobs.has(e.jobId) || jobs.get(e.jobId).seq < e.seq) jobs.set(e.jobId, e);
  return jobs;
}
async function serverPresence() {
  try { return JSON.parse(await readFile(path.join(dataDir, 'state', 'presence.json'), 'utf8')).displayMode; } catch { return null; }
}
async function imagesOnDisk() {
  let n = 0;
  const walk = async (d) => { for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) { if (e.isDirectory()) await walk(path.join(d, e.name)); else if (/\.jpe?g$/i.test(e.name)) n++; } };
  await walk(path.join(dataDir, 'images'));
  return n;
}

// ---------------------------------------------------------------- camera agent

let camera = null;
const camEvents = [];
let camReqId = 0;
const camWaiters = new Map();
async function startCamera() {
  const py = path.join(ROOT, 'camera', '.venv', 'bin', 'python');
  if (!existsSync(py)) throw new Error('camera/.venv is missing: see camera/linux/README.md (Pillow is needed)');
  camera = track(spawn(py, ['-I', path.join(import.meta.dirname, 'camera_agent.py')], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, SERVER_URL: `http://127.0.0.1:${ports.camProxy}`, ALLOW_INSECURE_HTTP: '1', DEVICE_TOKEN: deviceToken, DEVICE_ID: 'cam1', STATE_DIR: camState },
    stdio: ['pipe', 'pipe', 'pipe'],
  }), 'camera');
  createInterface({ input: camera.stdout }).on('line', (l) => {
    let e; try { e = JSON.parse(l); } catch { return; }
    if (e.ev === 'reply') { camWaiters.get(e.id)?.(e); camWaiters.delete(e.id); return; }
    camEvents.push(e);
    if (e.ev === 'led') log(`  camera LED: ${e.name}`);
    if (e.ev === 'capture') log(`  camera capture: mode=${e.metaMode} append=${e.append} kept=${JSON.stringify(e.kept)} of ${e.candidates} attempts=${e.attempts} issue=${e.issue}`);
  });
  const camErr = [];
  camera.stderr.on('data', (d) => camErr.push(String(d)));
  camera.errTail = () => camErr.join('').slice(-1500);
  await until('camera ready', () => camEvents.some((e) => e.ev === 'ready'), 15_000);
}
function cam(cmd, extra = {}) {
  const id = ++camReqId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`camera did not answer ${cmd}`)), 15_000);
    camWaiters.set(id, (r) => { clearTimeout(timer); r.ok ? resolve(r) : reject(new Error(r.error)); });
    camera.stdin.write(`${JSON.stringify({ id, cmd, ...extra })}\n`);
  });
}
const camMark = () => camEvents.length;
const camSince = (mark) => camEvents.slice(mark);
const ledsSince = (mark) => camSince(mark).filter((e) => e.ev === 'led').map((e) => e.name);
const capturesSince = (mark) => camSince(mark).filter((e) => e.ev === 'capture');
async function press(kind, scene) {
  if (scene) await cam('scene', { name: scene });
  const mark = camMark();
  await cam('press', { kind });
  return mark;
}
// A final LED pattern that belongs to this press: it must come after the press's
// capture, or a late "ready" of the previous press would be taken for this one.
async function waitLed(mark, names, ms = 45_000) {
  return until(`camera LED one of ${names}`, () => {
    const ev = camSince(mark);
    const start = names.includes('queued_offline') ? 0 : ev.findIndex((e) => e.ev === 'capture');
    if (start < 0) return null;
    return ev.slice(start).find((e) => e.ev === 'led' && names.includes(e.name))?.name ?? null;
  }, ms);
}

// ---------------------------------------------------------------- app control server

const ctl = { queue: [], waiters: new Map(), hellos: 0, id: 0 };
const ctlServer = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'GET' && req.url === '/cmd') {
    const c = ctl.queue.shift();
    if (!c) { res.writeHead(204); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(c));
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  const msg = body ? JSON.parse(body) : {};
  if (req.url === '/hello') { ctl.hellos++; log(`app driver connected (#${ctl.hellos})`); }
  if (req.url === '/done') { ctl.waiters.get(msg.id)?.(msg); ctl.waiters.delete(msg.id); }
  res.writeHead(204); res.end();
});
function app(cmd, args = {}, ms = 20_000) {
  const id = ++ctl.id;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ctl.waiters.delete(id); reject(new Error(`app did not answer ${cmd}`)); }, ms);
    ctl.waiters.set(id, (r) => { clearTimeout(timer); r.ok ? resolve(r.result) : reject(new Error(r.error)); });
    ctl.queue.push({ id, cmd, args });
  });
}
const appState = () => app('state');
async function waitApp(what, pred, ms = 40_000) {
  return until(`app: ${what}`, async () => { const s = await appState(); return pred(s) ? s : null; }, ms, 200);
}

// ---------------------------------------------------------------- simulator

const SIM = `http://127.0.0.1:${SIM_PORT}`;
let vite = null; let sim = null;
async function startSimulator() {
  if (await portBusy(VITE_PORT) || await portBusy(SIM_PORT)) throw new Error(`port ${VITE_PORT} or ${SIM_PORT} is in use; stop the other dev server or simulator first`);
  const require = createRequire(path.join(APP, 'package.json'));
  const binary = require.resolve(`@evenrealities/sim-${process.platform}-${process.arch}/bin/evenhub-simulator`);
  vite = track(spawn(process.execPath, [path.join(APP, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', String(VITE_PORT), '--strictPort'], { cwd: APP, stdio: 'ignore' }), 'vite');
  await until('vite', async () => { try { return (await fetch(`http://127.0.0.1:${VITE_PORT}/`)).ok; } catch { return false; } }, 20_000);
  const q = new URLSearchParams({ e2e: `http://127.0.0.1:${ports.ctl}`, server: `http://127.0.0.1:${ports.appProxy}`, token: clientToken });
  sim = track(spawn(binary, ['--automation-port', String(SIM_PORT), `http://127.0.0.1:${VITE_PORT}/?${q}`], { cwd: APP, stdio: ['ignore', 'ignore', 'ignore'] }), 'simulator');
  await until('simulator automation port', async () => { try { return (await (await fetch(`${SIM}/api/ping`)).text()).includes('pong'); } catch { return false; } }, 40_000, 500);
  await until('app driver hello', () => ctl.hellos > 0, 40_000);
}
async function shot(name) {
  const png = Buffer.from(await (await fetch(`${SIM}/api/screenshot/glasses`)).arrayBuffer());
  if (name) await writeFile(path.join(SCREENS, `${name}.png`), png);
  return litPixels(decodePng(png));
}
// The lens may take a moment to redraw after a state change.
async function lensSettled() { await sleep(900); return shot(); }

// ---------------------------------------------------------------- checks and scenarios

const table = [];
let current = null;
function check(name, ok, detail = '') {
  current.checks.push({ name, ok, detail });
  console.log(`    ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
  return ok;
}
async function scenario(name, title, fn) {
  if (ONLY && !ONLY.includes(name)) return;
  current = { name, title, checks: [], error: null };
  table.push(current);
  log(`--- ${name}: ${title}`);
  try { await fn(); } catch (e) { current.error = e.message; console.log(`    FAIL ${e.message}`); }
}
const readyIds = (jobs) => [...jobs.values()].filter((e) => e.status === 'ready').map((e) => e.jobId);
async function newJob(before, status = null, ms = 40_000) {
  return until(`a new server job${status ? ` with status ${status}` : ''}`, async () => {
    const jobs = await serverEvents();
    return [...jobs.values()].find((e) => !before.has(e.jobId) && (!status || e.status === status)) ?? null;
  }, ms, 300);
}
const lensHas = (s, re) => re.test(s.lens);
// The answer of a server job is the one the app holds as its document, and the
// lens plan shows it (empty plan when hidden).
const shows = (x, jobId) => x.docId === jobId && x.snapshot.camera === null && /x = 4/.test(x.lens);
const gestureInfo = (s) => `shakes=${s.snapshot.shakes} last=${s.snapshot.lastGesture} stale=${s.snapshot.sensorStale} engine=${JSON.stringify(s.snapshot.engine)} adapter=${JSON.stringify(s.snapshot.adapter)}`;
async function makeVisible() {
  let s = await appState();
  if (s.snapshot.wear !== 'worn') s = await app('wear', { on: true });
  if (s.snapshot.state.startsWith('VISIBLE') || s.snapshot.presence === 'VISIBLE') return s;
  for (let i = 0; i < 3; i++) {
    s = await app('motion', { name: 'shake' });
    if (s.snapshot.presence === 'VISIBLE') return s;
  }
  throw new Error(`could not make the lens visible (state ${s.snapshot.state}; ${gestureInfo(s)})`);
}
async function makeHidden() {
  let s = await appState();
  for (let i = 0; i < 3 && s.snapshot.presence === 'VISIBLE'; i++) s = await app('motion', { name: 'shake' });
  if (s.snapshot.presence === 'VISIBLE') throw new Error(`could not hide the lens (${gestureInfo(s)})`);
  return s;
}
async function dismissError() {
  const s = await appState();
  if (s.snapshot.presence === 'VISIBLE' && /RETAKE|ERROR/.test(s.lens.split('\n')[0])) await app('touch', { kind: 'press' });
}

async function scenarios() {
  await scenario('boot', 'App starts dark and connects to the backend', async () => {
    // With no jobs yet the first long-poll is held for its full 25 s, so "connecting" with a poll open is fine.
    let s = await waitApp('long-poll open', (x) => x.polls >= 1 && x.conn !== 'offline' && x.conn !== 'unauthorized', 30_000);
    check('lens dark at start', (await shot('e2e-00-boot')) === 0);
    s = await app('connect', { on: true });
    const cfg = await cam('state');
    check('camera fetched its config from the backend', cfg.configLoaded === true, JSON.stringify(cfg.config));
    check('presence reported as hidden-like before wear is known', ['UNKNOWN', 'HIDDEN'].includes(await serverPresence() ?? 'UNKNOWN'), String(await serverPresence()));
    s = await makeVisible();
    await sleep(500);
    check('presence VISIBLE reached the backend', await until('presence', async () => (await serverPresence()) === 'VISIBLE', 5000).catch(() => false));
    check('lens lit when visible', (await lensSettled()) > 0);
  });

  await scenario('burst', 'Burst press -> "Received n photos" -> "Reading" -> answer on lens', async () => {
    await makeVisible();
    const before = await serverEvents();
    const mark = await press('single', 'sharp');
    const s1 = await waitApp('camera status on lens', (x) => /RECEIVED|READING/.test(x.lens), 20_000);
    check('camera status shown while visible', true, s1.lens.split('\n')[0]);
    await shot('e2e-01-burst-status');
    const job0 = await newJob(before, 'ready');
    const r = await waitApp('answer on lens', (x) => shows(x, job0.jobId), 30_000);
    check('this job\'s answer on lens', true, r.lens.split('\n')[0]);
    check('lens lit with answer', (await lensSettled()) > 0);
    await shot('e2e-02-burst-answer');
    const caps = capturesSince(mark);
    check('one capture, burst mode', caps.length === 1 && caps[0].metaMode === 'burst', JSON.stringify(caps.map((c) => c.metaMode)));
    check('best K uploaded (<= 3 of N)', caps[0]?.uploadFrames >= 1 && caps[0]?.uploadFrames <= 3, `${caps[0]?.uploadFrames} of ${caps[0]?.candidates}`);
    await waitLed(mark, ['ready', 'retake', 'error']);
    const leds = ledsSince(mark);
    check('LED: captured, uploaded, ready', ['captured', 'uploaded', 'ready'].every((n) => leds.includes(n)), leds.join(','));
    const job = await newJob(before, 'ready');
    check('server job ready with K photos', job.photos === caps[0]?.uploadFrames, `photos=${job.photos} label=${job.result?.label}`);
  });

  await scenario('dark', 'Dark frames -> automatic second try -> retake message and LED', async () => {
    await makeVisible();
    const mark = await press('single', 'dark');
    const r = await waitApp('retake on lens', (x) => /Retake/i.test(x.lens), 40_000);
    check('lens shows the retake reason', /too dark/.test(r.lens), r.lens.replace(/\n/g, ' | ').slice(0, 120));
    await shot('e2e-03-retake-dark');
    await waitLed(mark, ['retake', 'error', 'ready']);
    const leds = ledsSince(mark);
    check('LED: retake pattern', leds.includes('retake') && !leds.includes('ready'), leds.join(','));
    const caps = capturesSince(mark);
    check('camera took a second capture (auto retry)', caps[0]?.attempts === 2, `attempts=${caps[0]?.attempts} issue=${caps[0]?.issue}`);
    await dismissError();
  });

  await scenario('blurry', 'Blurry frames -> retake "blurry"', async () => {
    await makeVisible();
    const before = await serverEvents();
    const mark = await press('single', 'blurry');
    await waitLed(mark, ['retake', 'error', 'ready'], 45_000);
    const leds = ledsSince(mark);
    const caps = capturesSince(mark);
    check('camera flagged the frames as blurry', caps[0]?.issue === 'blurry', `issue=${caps[0]?.issue} attempts=${caps[0]?.attempts}`);
    const job = await newJob(before, null).catch(() => null);
    const s = await appState();
    check('LED: retake pattern', leds.includes('retake'), leds.join(','));
    check('server answered retake: blurry', job?.status === 'retake' && job?.result?.retakeReason === 'blurry', `${job?.status} ${job?.result?.retakeReason ?? ''}`);
    check('lens shows "Retake: blurry"', /Retake: blurry/.test(s.lens), s.lens.split('\n').slice(0, 2).join(' | '));
    await shot('e2e-04-retake-blurry');
    await dismissError();
  });

  await scenario('glare', 'Glare on every frame -> retake "glare"', async () => {
    await makeVisible();
    const before = await serverEvents();
    const mark = await press('single', 'glare');
    await waitLed(mark, ['retake', 'error', 'ready'], 45_000);
    const job = await newJob(before, null).catch(() => null);
    const s = await waitApp('retake on lens', (x) => /Retake/.test(x.lens), 10_000).catch(() => appState());
    check('server answered retake: glare', job?.status === 'retake' && job?.result?.retakeReason === 'glare', `${job?.status} ${job?.result?.retakeReason ?? ''}`);
    check('lens shows "Retake: glare"', /Retake: glare/.test(s.lens), s.lens.split('\n').slice(0, 2).join(' | '));
    check('LED: retake pattern', ledsSince(mark).includes('retake'), ledsSince(mark).join(','));
    await dismissError();
  });

  await scenario('multipage', 'Single press, then double press adds page 2 to the same question', async () => {
    await makeVisible();
    const before = await serverEvents();
    let mark = await press('single', 'sharp');
    await waitLed(mark, ['ready', 'retake', 'error']);
    await waitApp('page 1 answer', (x) => /1 page\)/.test(x.lens), 20_000);
    mark = await press('double', 'page2');
    const caps = await until('double press capture', () => capturesSince(mark).length ? capturesSince(mark) : null, 15_000);
    check('double press read as one appended capture', caps.length === 1 && caps[0].append === true, JSON.stringify(caps.map((c) => [c.metaMode, c.append])));
    const r = await waitApp('2-page answer', (x) => /2 pages\)/.test(x.lens), 40_000);
    await waitLed(mark, ['ready', 'retake', 'error']);
    check('lens shows the 2-page answer', true, r.lens.split('\n').slice(0, 2).join(' | '));
    await shot('e2e-05-two-pages');
    const jobs = await serverEvents();
    const fresh = [...jobs.values()].filter((e) => !before.has(e.jobId));
    const two = fresh.find((e) => e.pages === 2);
    check('server: page 2 linked to page 1', two && (two.appendedTo ? fresh.some((e) => e.jobId === two.appendedTo) : true), `jobs=${fresh.length} appendedTo=${two?.appendedTo ?? 'merged'}`);
    check('lens header shows the page count', /2p/.test(r.lens.split('\n')[0]), r.lens.split('\n')[0]);
    check('inbox replaced page 1 with the 2-page answer (no extra unseen)', r.snapshot.unseenAnswers === 0, `unseen=${r.snapshot.unseenAnswers}`);
  });

  await scenario('clip', 'Long press -> clip mode (local video, best frames) -> answer', async () => {
    await makeVisible();
    const before = await serverEvents();
    const mark = await press('long', 'sharp');
    await waitLed(mark, ['ready', 'retake', 'error']);
    const caps = capturesSince(mark);
    check('long press made exactly one clip capture', caps.length === 1 && caps[0].metaMode === 'clip', JSON.stringify(caps.map((c) => c.metaMode)));
    check('at most 3 frames uploaded from the clip', caps[0]?.uploadFrames <= 3, `${caps[0]?.uploadFrames} of ${caps[0]?.candidates}`);
    const job = await newJob(before, 'ready');
    check('server job ready', !!job, job?.result?.label);
    const st = await cam('state');
    check('nothing left in the camera queue folder', st.queueDirEntries.length === 0, JSON.stringify(st.queueDirEntries));
    const r = await waitApp('answer on lens', (x) => shows(x, job.jobId), 20_000).catch(() => null);
    check('clip answer on lens', !!r);
  });

  await scenario('hidden', 'Captures while hidden stay dark, appear on restore with unseen count', async () => {
    await makeVisible();
    await makeHidden();
    check('lens dark after hide', (await lensSettled()) === 0);
    check('presence HIDDEN on the backend', await until('presence', async () => (await serverPresence()) === 'HIDDEN', 5000).catch(() => false));
    const before = await serverEvents();
    let mark = await press('single', 'sharp');
    await waitApp('camera status known to the app', (x) => x.snapshot.camera !== null, 20_000);
    check('lens dark while processing', (await shot('e2e-06-hidden-processing')) === 0);
    await waitLed(mark, ['ready', 'retake', 'error']);
    const first = await newJob(before, 'ready');
    mark = await press('single', 'clean');
    await waitLed(mark, ['ready', 'retake', 'error']);
    const second = await newJob(new Map([...before, [first.jobId, first]]), 'ready');
    const s = await waitApp('two unseen answers stored', (x) => x.snapshot.unseenAnswers >= 2 && x.snapshot.camera === null, 20_000);
    check('lens dark with two new answers waiting', (await lensSettled()) === 0);
    await shot('e2e-07-hidden-two-ready');
    check('the app holds them as unseen', s.snapshot.unseenAnswers === 2, `unseen=${s.snapshot.unseenAnswers} stored=${s.snapshot.stored}`);
    check('nothing in the lens plan while hidden', s.lens === '', JSON.stringify(s.lens.slice(0, 40)));
    const v = await makeVisible();
    const head = v.lens.split('\n')[0];
    check('restore shows the newest answer with "+1 new"', /\+1 new/.test(head) && shows(v, second.jobId), head);
    await shot('e2e-08-restored-unseen');
    const after = await app('touch', { kind: 'press' });
    check('a press opens the other unseen answer', shows(after, first.jobId) && !/\+\d+ new/.test(after.lens.split('\n')[0]) && after.snapshot.unseenAnswers === 0, after.lens.split('\n')[0]);
    const jobs = await serverEvents();
    check('both jobs ready on the server', [...jobs.values()].filter((e) => !before.has(e.jobId) && e.status === 'ready').length === 2);
  });

  await scenario('restart', 'Backend killed mid-AI-call and restarted', async () => {
    await makeVisible();
    const before = await serverEvents();
    const mark = await press('single', 'sharp');
    const job = await newJob(before, 'processing', 20_000);
    log('  killing the backend (SIGKILL) during the AI call');
    await killBackend('SIGKILL');
    await sleep(1500);
    await startBackend();
    log('  backend restarted');
    const r = await waitApp('answer after restart', (x) => shows(x, job.jobId), 60_000);
    check('answer reached the lens after the restart', true, r.lens.split('\n')[0]);
    await waitLed(mark, ['ready', 'retake', 'error'], 45_000).catch(() => null);
    const leds = ledsSince(mark);
    check('camera LED still got "ready"', leds.includes('ready'), leds.join(','));
    const jobs = await serverEvents();
    const fresh = [...jobs.values()].filter((e) => !before.has(e.jobId));
    check('exactly one job, finished ready', fresh.length === 1 && fresh[0].jobId === job.jobId && fresh[0].status === 'ready', fresh.map((e) => e.status).join(','));
    check('app long-poll back online', r.conn === 'online', r.conn);
  });

  await scenario('camera-offline', 'Camera network down: press queued, sent when back', async () => {
    await makeVisible();
    camProxy.setMode('down');
    const mark = await press('single', 'sharp');
    const before = await serverEvents();
    await waitLed(mark, ['queued_offline'], 15_000);
    let st = await cam('state');
    check('press held in the camera queue', st.pending === 1, `pending=${st.pending}`);
    await sleep(4000);
    camProxy.setMode('up');
    await waitLed(mark, ['ready', 'retake', 'error'], 90_000);
    st = await cam('state');
    const leds = ledsSince(mark);
    check('LED: queued_offline, uploaded, ready', ['queued_offline', 'uploaded', 'ready'].every((n) => leds.includes(n)), leds.join(','));
    check('queue empty afterwards', st.pending === 0);
    const job = await newJob(before, 'ready');
    const r = await waitApp('answer on lens', (x) => shows(x, job.jobId), 20_000).catch(() => null);
    check('answer on lens', !!r);
  });

  await scenario('app-offline', 'Glasses app network down while a job finishes; long-poll recovers', async () => {
    await makeVisible();
    const before = await serverEvents();
    const s0 = await appState();
    appProxy.setMode('down');
    await waitApp('client offline', (x) => x.conn === 'offline', 30_000);
    const mark = await press('single', 'sharp');
    await waitLed(mark, ['ready', 'retake', 'error']);
    const job = await newJob(before, 'ready');
    const mid = await appState();
    check('app did not get it while offline', mid.snapshot.stored === s0.snapshot.stored, `stored ${s0.snapshot.stored} -> ${mid.snapshot.stored}`);
    await shot('e2e-09-app-offline');
    appProxy.setMode('up');
    const r = await waitApp('answer after recovery', (x) => x.conn === 'online' && x.snapshot.stored > s0.snapshot.stored, 60_000);
    check('long-poll recovered and delivered this job\'s answer', shows(r, job.jobId), `doc=${r.docId === job.jobId ? 'this job' : r.docId}`);
    check('stored exactly one new answer', r.snapshot.stored === Math.min(20, s0.snapshot.stored + 1), `stored ${s0.snapshot.stored} -> ${r.snapshot.stored}`);
    check('cursor moved past the job', Number(r.cursor) >= job.seq, `cursor=${r.cursor} seq=${job.seq}`);
  });

  await scenario('duplicates', 'Lost upload reply (same key retried) and a bouncy button', async () => {
    await makeVisible();
    let before = await serverEvents();
    const s0 = await appState();
    camProxy.dropNextCaptureReply = true;
    let mark = await press('single', 'sharp');
    await waitLed(mark, ['ready', 'retake', 'error'], 60_000);
    check('the proxy dropped the first reply', camProxy.dropped >= 1, `dropped=${camProxy.dropped}`);
    const st = await cam('state');
    check('camera retried', st.retried >= 1, `retried=${st.retried}`);
    let jobs = await serverEvents();
    let fresh = [...jobs.values()].filter((e) => !before.has(e.jobId));
    check('one press -> one job on the server', fresh.length === 1, `${fresh.length} jobs`);
    const ids = Object.values(st.jobIds);
    check('the retry got the same job back', fresh.length === 1 && ids.filter((j) => j === fresh[0].jobId).length === 1, `camera mapped ${ids.filter((j) => j === fresh[0]?.jobId).length} press(es) to it`);
    const r = await waitApp('answer', (x) => fresh[0] && shows(x, fresh[0].jobId), 20_000);
    check('app stored one answer, not two', r.snapshot.stored === Math.min(20, s0.snapshot.stored + 1), `stored ${s0.snapshot.stored} -> ${r.snapshot.stored}`);
    before = await serverEvents();
    mark = await press('bounce', 'sharp');
    await waitLed(mark, ['ready', 'retake', 'error']);
    await sleep(800);
    const caps = capturesSince(mark);
    check('bouncy contact -> one capture', caps.length === 1 && !caps[0].append, JSON.stringify(caps.map((c) => [c.metaMode, c.append])));
    jobs = await serverEvents();
    fresh = [...jobs.values()].filter((e) => !before.has(e.jobId));
    check('bouncy contact -> one job', fresh.length === 1, `${fresh.length} jobs`);
    await waitApp('settled', (x) => x.snapshot.camera === null, 20_000);
  });

  await scenario('removed', 'Glasses taken off during processing', async () => {
    await makeVisible();
    const before = await serverEvents();
    const mark = await press('single', 'sharp');
    await waitApp('processing', (x) => x.snapshot.camera !== null, 20_000);
    let s = await app('wear', { on: false });
    check('lens dark when removed', (await lensSettled()) === 0);
    check('presence REMOVED on the backend', await until('presence', async () => (await serverPresence()) === 'REMOVED', 5000).catch(() => false));
    await waitLed(mark, ['ready', 'retake', 'error']);
    const job = await newJob(before, 'ready');
    s = await waitApp('answer stored while removed', (x) => x.snapshot.camera === null && x.snapshot.unseenAnswers >= 1, 20_000);
    check('lens dark with the answer waiting', (await lensSettled()) === 0 && s.lens === '');
    await shot('e2e-10-removed-ready');
    s = await app('wear', { on: true });
    check('putting the glasses back on stays dark', (await lensSettled()) === 0 && s.snapshot.presence !== 'VISIBLE', s.snapshot.state);
    await shot('e2e-11-rewear-dark');
    const v = await makeVisible();
    check('shake shows the answer that came while removed', shows(v, job.jobId) && v.snapshot.unseenAnswers === 0, v.lens.split('\n')[0]);
  });

  await scenario('reload', 'App restarted while hidden with a new answer: nothing revealed, nothing doubled', async () => {
    await makeVisible();
    await makeHidden();
    const before = await serverEvents();
    const mark = await press('single', 'sharp');
    await waitLed(mark, ['ready', 'retake', 'error']);
    const job = await newJob(before, 'ready');
    const s0 = await waitApp('answer stored', (x) => x.snapshot.unseenAnswers >= 1 && x.snapshot.camera === null, 20_000);
    const hellos = ctl.hellos;
    await app('reload');
    await until('app came back', () => ctl.hellos > hellos, 30_000);
    let s = await waitApp('online again', (x) => x.conn === 'online', 30_000);
    check('lens dark after restart', (await lensSettled()) === 0);
    s = await app('connect', { on: true });
    s = await app('wear', { on: true });
    check('still dark after reconnect and wear', (await lensSettled()) === 0 && s.snapshot.presence !== 'VISIBLE', s.snapshot.state);
    await shot('e2e-12-after-reload-dark');
    check('inbox kept, nothing doubled', s.snapshot.stored === s0.snapshot.stored && s.snapshot.unseenAnswers === s0.snapshot.unseenAnswers, `stored ${s0.snapshot.stored}->${s.snapshot.stored}, unseen ${s0.snapshot.unseenAnswers}->${s.snapshot.unseenAnswers}`);
    const v = await makeVisible();
    check('shake shows the waiting answer', shows(v, job.jobId), v.lens.split('\n')[0]);
  });

  await scenario('retention', 'Images deleted on the backend after the jobs end', async () => {
    const n = await until('images deleted', async () => ((await imagesOnDisk()) === 0 ? 'none' : null), 40_000, 1000).catch(async () => `${await imagesOnDisk()} left`);
    check('no images left on the backend (append window 20 s in this run)', n === 'none', n);
  });
}

// ---------------------------------------------------------------- main

const camProxy = makeProxy('camera', () => ports.backend);
const appProxy = makeProxy('glasses app', () => ports.backend);
let exitCode = 1;
try {
  await mkdir(SCREENS, { recursive: true });
  await startBackend();
  log(`backend on ${ports.backend} (mock AI, ${MOCK_DELAY_MS} ms per answer), data in ${tmp}`);
  await camProxy.listen(ports.camProxy);
  await appProxy.listen(ports.appProxy);
  await new Promise((r) => ctlServer.listen(ports.ctl, '127.0.0.1', r));
  await startCamera();
  log('camera client running (fake GPIO, fake sensor)');
  await startSimulator();
  log('simulator and app running');
  await scenarios();
  const failed = table.filter((s) => s.error || s.checks.some((c) => !c.ok));
  console.log('\n| Scenario | Result | Checks |');
  console.log('| --- | --- | --- |');
  for (const s of table) {
    const ok = !s.error && s.checks.every((c) => c.ok);
    console.log(`| ${s.name}: ${s.title} | ${ok ? 'PASS' : 'FAIL'} | ${s.checks.filter((c) => c.ok).length}/${s.checks.length}${s.error ? ` (stopped: ${s.error})` : ''} |`);
  }
  console.log(`\n${table.length - failed.length} of ${table.length} scenarios passed`);
  exitCode = failed.length ? 1 : 0;
} catch (e) {
  console.error(`run stopped: ${e.message}`);
  if (camera?.errTail) console.error(camera.errTail());
  console.error(backendLog.slice(-20).join('\n'));
} finally {
  stopping = true;
  // The simulator keeps the WebView's localStorage between runs: remove this run's
  // server address, token and cursor so a later plain `npm run sim:e2e` is not affected.
  if (sim && sim.exitCode === null) await app('forget', {}, 5000).then(() => log('app forgot the test server')).catch((e) => log(`could not clear app settings: ${e.message}`));
  try { camera?.stdin.end(`${JSON.stringify({ id: 0, cmd: 'quit' })}\n`); } catch { /* gone */ }
  await sleep(500);
  for (const c of [...children]) c.kill('SIGTERM');
  await sleep(1500);
  for (const c of [...children]) c.kill('SIGKILL');
  await camProxy.close();
  await appProxy.close();
  await new Promise((r) => ctlServer.close(() => r()));
  ctlServer.closeAllConnections?.();
  if (!KEEP_TMP) await rm(tmp, { recursive: true, force: true });
  else log(`kept ${tmp}`);
}
process.exit(exitCode);
