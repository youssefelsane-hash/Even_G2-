// Mutation check: makes small deliberate bugs in a copy of the source and
// confirms that the tests catch each one. A mutant that survives means the
// tests do not guard that rule. The real source is never changed: each mutant
// runs in its own temporary copy, which is deleted afterwards.
//
// Usage: node tools/mutation-check.ts [name-filter]
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

interface Mutant { name: string; file: string; find: string; replace: string; tests: string[] }

const root = path.join(import.meta.dirname, '..');
const T = (...names: string[]) => names.map((n) => `test/${n}.test.ts`);

const MUTANTS: Mutant[] = [
  { name: 'boot visible', file: 'src/core/stateMachine.ts', find: "return { mode: 'HIDDEN', job:", replace: "return { mode: 'VISIBLE', job:", tests: T('stateMachine', 'acceptance') },
  { name: 'hidden shows content', file: 'src/core/stateMachine.ts', find: "return s.mode === 'VISIBLE';", replace: "return s.mode !== 'REMOVED';", tests: T('stateMachine', 'acceptance', 'property') },
  { name: 'result reveals', file: 'src/core/stateMachine.ts', find: "return yes({ ...s, job: 'RESULT_READY', unseen: s.mode !== 'VISIBLE' });", replace: "return yes({ ...s, mode: s.mode === 'HIDDEN' ? 'VISIBLE' : s.mode, job: 'RESULT_READY', unseen: false });", tests: T('property', 'jobs') },
  { name: 'reconnect reveals', file: 'src/core/stateMachine.ts', find: 'if (e.connected) return no;', replace: "if (e.connected) return yes({ ...s, mode: s.mode === 'HIDDEN' ? 'VISIBLE' : s.mode });", tests: T('property') },
  { name: 'undo ignores wear', file: 'src/core/stateMachine.ts', find: "if (s.mode !== 'HIDDEN' || s.wear !== 'worn') return no;", replace: "if (s.mode !== 'HIDDEN') return no;", tests: T('stateMachine', 'smartGestures') },
  { name: 'undo restores changed screen', file: 'src/core/assistant.ts', find: 'this.visibleText() !== u.text', replace: 'false', tests: T('smartGestures') },
  { name: 'undo never expires', file: 'src/core/assistant.ts', find: 'now > u.until', replace: 'false', tests: T('smartGestures') },
  { name: 'displayed ack while hidden', file: 'src/core/assistant.ts', find: "if (contentAllowed(this.machine) && this.machine.job !== 'ERROR' && this.inbox.markSeen(this.session.docId))", replace: 'if (this.inbox.markSeen(this.session.docId))', tests: T('jobs') },
  { name: 'presence never unknown', file: 'src/core/assistant.ts', find: "return this.connected === true && m.wear !== 'unknown' ? 'HIDDEN' : 'UNKNOWN';", replace: "return 'HIDDEN';", tests: T('jobs') },
  { name: 'repeated result shown again', file: 'src/core/inbox.ts', find: 'if (this.has(r.jobId)) return false;\n    this.list = [r,', replace: 'this.list = [r,', tests: T('jobs', 'property') },
  { name: 'inbox unbounded', file: 'src/core/inbox.ts', find: '.filter((x) => x.jobId !== replaces)].slice(0, INBOX_SIZE);', replace: '.filter((x) => x.jobId !== replaces)];', tests: T('jobs', 'property') },
  { name: 'client hands over duplicates', file: 'src/core/backend.ts', find: 'if (e.seq <= this.seenSeq(e.jobId)) continue;', replace: '', tests: T('backend') },
  { name: 'client never acks received', file: 'src/core/backend.ts', find: "if (e.status === 'ready' || e.status === 'retake' || e.status === 'failed') this.ack(e.jobId, 'received');", replace: '', tests: T('backend') },
  { name: 'ready without answer accepted', file: 'src/core/backend.ts', find: "if (status === 'ready' && !e.result) return null;", replace: '', tests: T('backend') },
  { name: 'shake cooldown removed', file: 'src/core/gestureEngine.ts', find: 'const inCooldown = s.t < this.shakeCooldownUntil;', replace: 'const inCooldown = false;', tests: T('gestureEngine', 'property', 'acceptance') },
  { name: 'tilt switch ignored', file: 'src/core/gestureEngine.ts', find: 'if (!c.tiltEnabled || busy) {', replace: 'if (busy) {', tests: T('smartGestures', 'property') },
  { name: 'activity boost off', file: 'src/core/gestureEngine.ts', find: 'this.shake.setBoost(this.activity.level(s.t).shakeBoost);', replace: 'this.shake.setBoost(1);', tests: T('smartGestures', 'population') },
  { name: 'own shake raises the bar', file: 'src/core/gestureEngine.ts', find: 'this.activity.exclude(this.shake.chainStart - 200, s.t + c.shakeCooldownMs);', replace: '', tests: T('smartGestures') },
  { name: 'glance rest limit off', file: 'src/core/shakeDetector.ts', find: 'if (this.anchorPlateau > this.plateauLimit(dur(last))) return false;', replace: '', tests: T('smartGestures', 'replay') },
  { name: 'shake needs one swing less', file: 'src/core/shakeDetector.ts', find: 'this.swings.length < c.shakeSwings - 1) return false;', replace: 'this.swings.length < c.shakeSwings - 2) return false;', tests: T('gestureEngine', 'acceptance', 'adversarial') },
  { name: 'pager not clamped', file: 'src/core/paging.ts', find: 'this.top = Math.min(this.maxTop, Math.max(0, Math.round(line)));', replace: 'this.top = Math.max(0, Math.round(line));', tests: T('paging', 'property') },
  { name: 'activity range not repaired', file: 'src/core/settings.ts', find: 'out.activityFullDeg = Math.max(out.activityFullDeg, out.activityQuietDeg + 0.5);', replace: '', tests: T('property') },
  { name: 'personal shake floor off', file: 'src/core/personal.ts', find: 'if (minAmpSeen < PERSONAL_MIN_SHAKE_DEG) return fail(', replace: 'if (false) return fail(', tests: T('breakit') },
  { name: 'personal chain time not widened', file: 'src/core/personal.ts', find: 'shakeMaxTotalMs: Math.max(base.shakeMaxTotalMs, longestSwing * 1.4 * base.shakeSwings + base.shakeMaxDwellMs),', replace: '', tests: T('breakit') },
  { name: 'boost not capped', file: 'src/core/shakeDetector.ts', find: 'return Math.min(plain * this.boost, Math.max(plain, this.cfg.shakeMaxAmpDeg * 0.8));', replace: 'return plain * this.boost;', tests: T('breakit') },
  { name: 'drift counted as activity', file: 'src/core/activity.ts', find: 'const slope = shared ? Math.min(...slopes.map(Math.abs)) : 0;', replace: 'const slope = 0;', tests: T('breakit') },
  { name: 'plateau limit ignores swing length', file: 'src/core/shakeDetector.ts', find: 'const PLATEAU_PER_SWING = 0.45;', replace: 'const PLATEAU_PER_SWING = 0;', tests: T('breakit') },
  { name: 'fast empty polls not paused', file: 'src/core/backend.ts', find: 'if (!events.length && this.now() - sentAt < FAST_EMPTY_MS) {', replace: 'if (false) {', tests: T('breakit') },
  { name: 'catch-up never history', file: 'src/core/backend.ts', find: 'if (catchUp && e.createdAt !== undefined && now - e.createdAt > HISTORY_AFTER_MS) e.history = true;', replace: '', tests: T('breakit') },
  { name: 'history pushes kept answers out', file: 'src/core/inbox.ts', find: 'if (i < 0) i = this.list.length;', replace: 'i = 0;', tests: T('breakit') },
  { name: 'personal ignores ordinary motion', file: 'src/core/personal.ts', find: 'for (let step = 0; step < 12 &&', replace: 'for (let step = 0; step < 0 &&', tests: T('personal') },
];

const filter = process.argv[2];
const chosen = MUTANTS.filter((m) => !filter || m.name.includes(filter));
let killed = 0;
const survived: string[] = [];
const started = Date.now();

for (const m of chosen) {
  const src = readFileSync(path.join(root, m.file), 'utf8');
  const hits = src.split(m.find).length - 1;
  if (hits !== 1) {
    console.log(`STALE    ${m.name}: the text to change was found ${hits} times in ${m.file}. Update this mutant.`);
    survived.push(`${m.name} (stale)`);
    continue;
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'g2a-mutant-'));
  try {
    for (const part of ['src', 'test', 'app.json']) cpSync(path.join(root, part), path.join(dir, part), { recursive: true });
    symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    writeFileSync(path.join(dir, m.file), src.replace(m.find, m.replace));
    // A planted bug can make a test wait for ever, so each test gets a time limit; a timeout counts as caught.
    const r = spawnSync(process.execPath, ['--test', '--test-timeout=20000', ...m.tests], { cwd: dir, encoding: 'utf8', timeout: 240_000 });
    const failing = /# fail (\d+)/.exec(r.stdout ?? '')?.[1] ?? '?';
    // A mutant that does not even load is not a real test of the tests.
    if (/SyntaxError|ERR_INVALID_TYPESCRIPT_SYNTAX/.test(`${r.stdout}${r.stderr}`)) {
      survived.push(`${m.name} (does not load)`);
      console.log(`INVALID  ${m.name}: the mutant does not load. Fix this mutant.`);
      continue;
    }
    if (r.status !== 0) {
      killed++;
      console.log(`killed   ${m.name} (${failing} failing tests)`);
    } else {
      survived.push(m.name);
      console.log(`SURVIVED ${m.name}: no test noticed`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${killed} of ${chosen.length} mutants killed in ${((Date.now() - started) / 1000).toFixed(0)} s`);
if (survived.length) console.log(`Not caught: ${survived.join(', ')}`);
process.exit(survived.length ? 1 : 0);
