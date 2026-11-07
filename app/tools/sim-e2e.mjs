// End-to-end check against the official Even Hub simulator. Starts the Vite dev
// server and the simulator, follows the app's autopilot, screenshots the real
// glasses framebuffer at each step, counts lit pixels, then presses the real
// touch input to test recovery. Stops everything it started.
//
// The simulator has no IMU and no wear events, so motion and wear in this run
// are injected inside the app. Usage: node tools/sim-e2e.mjs [screenshot-dir]
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inflateSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const PORT = 9898;
const SIM = `http://127.0.0.1:${PORT}`;
const APP = 'http://127.0.0.1:5174/?autopilot=1';
const root = path.join(import.meta.dirname, '..');
const outDir = process.argv[2] ?? path.join(root, '..', 'docs', 'screenshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal decoder for 8-bit RGBA PNGs, the format the simulator documents.
function decodePng(buf) {
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
      if (data[8] !== 8 || colorType !== 6 || data[12] !== 0) throw new Error('expected 8-bit RGBA, not interlaced');
    } else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const b = y ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0;
      let pred = 0;
      if (f === 1) pred = a;
      else if (f === 2) pred = b;
      else if (f === 3) pred = (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = (v + pred) & 255;
    }
  }
  return { width, height, px };
}

const litPixels = ({ px }) => {
  let n = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] > 0) n++;
  return n;
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
};

async function shot(name) {
  const png = Buffer.from(await (await fetch(`${SIM}/api/screenshot/glasses`)).arrayBuffer());
  await writeFile(path.join(outDir, `${name}.png`), png);
  const image = decodePng(png);
  return { lit: litPixels(image), image };
}

let lastId;
async function poll() {
  const q = lastId === undefined ? '' : `?since_id=${lastId}`;
  const { entries } = await (await fetch(`${SIM}/api/console${q}`)).json();
  if (entries.length) lastId = entries[entries.length - 1].id;
  return entries;
}

const seen = [];
async function waitFor(pattern, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    const i = seen.findIndex((m) => pattern.test(m));
    if (i >= 0) return seen.splice(0, i + 1)[i];
    if (Date.now() > end) throw new Error(`console never matched ${pattern}`);
    for (const e of await poll()) {
      seen.push(e.message);
      if (/^(APP_|STATE|DEVICE|IMU|STEP)/.test(e.message) || e.level === 'error') console.log(`  [app] ${e.message}`);
      if (e.level === 'error' || /^\[(uncaught|unhandledrejection)\]/.test(e.message)) check(`no app error: ${e.message.slice(0, 100)}`, false);
    }
    await sleep(120);
  }
}

async function input(action) {
  const r = await (await fetch(`${SIM}/api/input`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) })).json();
  if (!r.ok) throw new Error(`input ${action} failed`);
  await sleep(350);
}

const STEPS = [
  ['start', 'dark'], ['visible-answer', 'lit'], ['visible-scrolled', 'lit'], ['hidden', 'dark'],
  ['hidden-with-result', 'dark'], ['visible-new-result', 'lit'], ['visible-position-before-hide', 'lit'],
  ['hidden-again', 'dark'], ['visible-position-restored', 'lit'], ['removed', 'dark'], ['rewear-stays-hidden', 'dark'],
];

const binary = require.resolve(`@evenrealities/sim-${process.platform}-${process.arch}/bin/evenhub-simulator`);
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const vite = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', '5174', '--strictPort'], { cwd: root, stdio: 'ignore' });
let sim;

try {
  await mkdir(outDir, { recursive: true });
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch('http://127.0.0.1:5174/')).ok) break; } catch { /* not up yet */ }
    await sleep(250);
  }
  sim = spawn(binary, ['--automation-port', String(PORT), APP], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let simOut = '';
  sim.stdout.on('data', (d) => { simOut += d; });
  sim.stderr.on('data', (d) => { simOut += d; });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { up = (await (await fetch(`${SIM}/api/ping`)).text()).includes('pong'); } catch { /* not up yet */ }
    if (sim.exitCode !== null) throw new Error(`simulator exited with ${sim.exitCode}: ${simOut.slice(-500)}`);
    await sleep(500);
  }
  if (!up) throw new Error('simulator automation port never answered');
  check('simulator automation port answers', true);
  await waitFor(/^APP_READY/);

  const shots = {};
  for (const [name, want] of STEPS) {
    const line = await waitFor(new RegExp(`^STEP ${name} `));
    await sleep(900);
    const s = await shot(name);
    shots[name] = s;
    check(`${name}: lens is ${want}`, want === 'lit' ? s.lit > 0 : s.lit === 0, `${s.lit} lit pixels; ${line}`);
  }
  const same = (a, b) => a.image.px.equals(b.image.px);
  check('scrolling changed the screen', !same(shots['visible-answer'], shots['visible-scrolled']));
  check('after hide and show the screen is pixel-identical', same(shots['visible-position-before-hide'], shots['visible-position-restored']));

  await waitFor(/^STEP done/);
  await sleep(1800); // past the wear settle time
  for (let i = 0; i < 3; i++) await input('click');
  check('three real presses do not reveal', (await shot('recovery-3-presses')).lit === 0);
  await input('click');
  await waitFor(/^STATE (VISIBLE|RESULT_READY)/, 5000);
  await sleep(700);
  const rec = await shot('recovery-4-presses');
  check('fourth real press reveals (touch recovery through simulator input)', rec.lit > 0, `${rec.lit} lit pixels`);
  await input('up');
  await sleep(700);
  const swiped = await shot('touch-swipe');
  check('a real swipe scrolls', !same(rec, swiped));

  const panel = Buffer.from(await (await fetch(`${SIM}/api/screenshot/webview`)).arrayBuffer());
  await writeFile(path.join(outDir, 'phone-panel.png'), panel);
} catch (e) {
  check(`run finished: ${e.message}`, false);
} finally {
  sim?.kill('SIGTERM');
  vite.kill('SIGTERM');
  await sleep(500);
  if (sim && sim.exitCode === null) sim.kill('SIGKILL');
  if (vite.exitCode === null) vite.kill('SIGKILL');
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} of ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
