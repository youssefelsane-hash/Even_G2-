import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEvent, type JobEvent } from '../src/core/backend.ts';
import { GestureEngine } from '../src/core/gestureEngine.ts';
import { ImuAdapter, type RawSample } from '../src/core/imuAdapter.ts';
import { INBOX_SIZE, Inbox } from '../src/core/inbox.ts';
import { Pager, approxMeasure } from '../src/core/paging.ts';
import { countGestures } from '../src/core/scenarios.ts';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/core/settings.ts';
import { MemoryStore } from '../src/core/storage.ts';
import { sequence, shake, still, stream } from '../src/core/synth.ts';
import { Rig } from './helpers.ts';
import { Rng, forAll, randomMotion, randomMotionSeq } from './prop.ts';

// Property-based tests: each runs many generated cases from fixed seeds.

const base = sanitizeSettings(DEFAULT_SETTINGS);

// ---- The lens rule, under random sequences of everything that can happen ----

type Action =
  | { k: 'motion'; seed: number }
  | { k: 'shake' }
  | { k: 'presses'; n: number }
  | { k: 'wear'; v: boolean | null }
  | { k: 'conn'; v: boolean }
  | { k: 'touch'; v: 'press' | 'double' | 'swipeUp' | 'swipeDown' }
  | { k: 'job'; id: number; status: JobEvent['status'] }
  | { k: 'ai'; v: 'start' | 'result' | 'error' }
  | { k: 'wait'; ms: number }
  | { k: 'restart' }
  | { k: 'exit' }
  | { k: 'foreground' }
  | { k: 'settings'; tilt: boolean; undo: number; trust: boolean }
  | { k: 'tick' };

const RESTORES = new Set(['motion', 'touch', 'shake', 'presses']);

function action(r: Rng): Action {
  switch (r.int(0, 13)) {
    case 0: case 1: return { k: 'motion', seed: r.int(1, 1e9) };
    case 2: case 12: return { k: 'shake' };
    case 13: return { k: 'presses', n: r.int(2, 5) };
    case 3: return { k: 'wear', v: r.pick([true, true, false, null]) };
    case 4: return { k: 'conn', v: r.bool(0.6) };
    case 5: return { k: 'touch', v: r.pick(['press', 'double', 'swipeUp', 'swipeDown'] as const) };
    case 6: return { k: 'job', id: r.int(1, 6), status: r.pick(['received', 'processing', 'ready', 'ready', 'retake', 'failed'] as const) };
    case 7: return { k: 'ai', v: r.pick(['start', 'result', 'error'] as const) };
    case 8: return { k: 'wait', ms: r.int(10, 6000) };
    case 9: return r.bool(0.5) ? { k: 'restart' } : { k: r.pick(['exit', 'foreground', 'tick'] as const) };
    default: return { k: 'settings', tilt: r.bool(0.8), undo: r.pick([0, 4000, 10_000]), trust: r.bool(0.85) };
  }
}

const visibleState = (s: string): boolean => s !== 'HIDDEN' && s !== 'REMOVED';

export const coverage = { steps: 0, visibleSteps: 0, reveals: 0, samples: 0 };

async function runActions(actions: Action[]): Promise<void> {
  const store = new MemoryStore();
  let r = await new Rig(store).ready();
  let seq = 0;
  for (const [i, a] of actions.entries()) {
    const before = r.a.state;
    const mark = r.markPlans();
    switch (a.k) {
      case 'motion': r.play(randomMotion(new Rng(a.seed)), a.seed); break;
      case 'shake': r.play(sequence(still(1500), shake())); break;
      case 'presses': for (let n = 0; n < a.n; n++) { r.wait(300); r.a.handleTouch('press'); } break;
      case 'wear': r.a.handleWear(a.v === null ? undefined : a.v); break;
      case 'conn': r.a.handleConnection(a.v); break;
      case 'touch': r.a.handleTouch(a.v); break;
      case 'job': {
        const jobId = `j${a.id}`;
        const result = a.status === 'ready' ? { short: `answer ${a.id}`, detail: ['d1', 'd2'], label: 'LIKELY' as const, caveats: [], pages: 1, usedFrames: 2 }
          : a.status === 'retake' ? { short: '', detail: [], label: 'RETAKE' as const, caveats: [], pages: 1, usedFrames: 0, retakeReason: 'blurry' } : undefined;
        await r.a.handleJobEvent({ jobId, seq: ++seq, status: a.status, photos: 3, pages: 1, ...(result ? { result } : {}) });
        break;
      }
      case 'ai':
        if (a.v === 'start') r.a.aiStarted();
        else if (a.v === 'result') r.a.aiResult({ id: `ai${i}`, short: 'local', details: 'x' });
        else r.a.aiError('failed');
        break;
      case 'wait': r.wait(a.ms); await r.a.tick(); break;
      case 'restart': await r.a.flush(); r = await new Rig(store).ready(); break;
      case 'exit': r.a.handleExit(); break;
      case 'foreground': r.a.handleForeground(); break;
      case 'settings': await r.a.updateSettings({ tiltEnabled: a.tilt, undoHideMs: a.undo, trustWearSensor: a.trust }); break;
      case 'tick': await r.a.tick(); break;
    }
    const after = r.a.state;
    coverage.steps++;
    if (visibleState(after)) coverage.visibleSteps++;
    if (visibleState(after) && !visibleState(before)) coverage.reveals++;
    const plans = r.plansSince(mark);
    const where = `step ${i} (${a.k}) ${before} -> ${after}`;
    // 1. Content is only ever on the lens while the mode is visible.
    if (!visibleState(after)) assert.ok(!r.lit(r.a.plan()), `${where}: plan lit while ${after}`);
    if (plans.length && !visibleState(after)) assert.ok(!r.lit(plans.at(-1)), `${where}: last plan lit`);
    // 2. Only a restore action may reveal. A restart, reconnect, wear change,
    //    new result, timer or setting can never move to visible.
    if (!RESTORES.has(a.k) && a.k !== 'restart') {
      if (!visibleState(before)) {
        assert.ok(!visibleState(after), `${where}: revealed without a restore action`);
        assert.ok(plans.every((p) => !r.lit(p)), `${where}: a lit plan was sent`);
      }
    }
    if (a.k === 'restart') assert.equal(after, 'HIDDEN', `${where}: restart must boot hidden`);
    if (a.k === 'wear' && a.v === false) assert.ok(!visibleState(after) || !r.a.settings.trustWearSensor, `${where}: removal must hide`);
  }
}

test('property: under any sequence of events, the lens is blank unless visible, and only a restore action reveals', async () => {
  await forAll((r) => r.list(5, 40, action), runActions, { runs: 120 });
  // The property is only worth something if the random runs really reach the visible state.
  console.log(`# coverage ${JSON.stringify(coverage)}`);
  assert.ok(coverage.reveals >= 30, `only ${coverage.reveals} reveals in ${coverage.steps} steps`);
  assert.ok(coverage.visibleSteps >= coverage.steps * 0.1, `visible in ${coverage.visibleSteps} of ${coverage.steps} steps`);
});

// ---- Smaller properties ----

test('property: the pager never leaves its range and never shows more than one screen', async () => {
  await forAll((r) => ({ words: r.int(0, 600), ops: r.list(1, 60, (q) => q.int(-40, 40)) }), ({ words, ops }) => {
    const p = new Pager(9, approxMeasure);
    p.setText(Array.from({ length: words }, (_, i) => `w${i}${i % 17 === 0 ? '\n' : ''}`).join(' '));
    for (const n of ops) {
      p.scrollBy(n);
      assert.ok(p.topLine >= 0 && p.topLine <= p.maxTop);
      assert.ok(p.visible().length <= 9);
    }
  }, { runs: 200 });
});

function junk(r: Rng, depth = 0): unknown {
  switch (r.int(0, depth > 2 ? 5 : 7)) {
    case 0: return r.float(-1e9, 1e9);
    case 1: return r.pick([NaN, Infinity, -Infinity, 0, -0, 1e308]);
    case 2: return r.pick(['', 'x', 'orientation', 'rate', 'y', 'VISIBLE']);
    case 3: return r.bool();
    case 4: return null;
    case 5: return undefined;
    case 6: return r.list(0, 4, (q) => junk(q, depth + 1));
    default: return Object.fromEntries(r.list(0, 5, (q) => [q.pick(['a', 'jobId', 'seq', 'status', 'result', 'short']), junk(q, depth + 1)]));
  }
}

test('property: settings from any stored junk are complete, in range and stable', async () => {
  const keys = Object.keys(DEFAULT_SETTINGS) as (keyof typeof DEFAULT_SETTINGS)[];
  await forAll((r) => Object.fromEntries(keys.filter(() => r.bool(0.4)).map((k) => [k, junk(r)])), (input) => {
    const s = sanitizeSettings(input);
    assert.deepEqual(Object.keys(s).sort(), [...keys].sort());
    for (const k of keys) {
      const v = s[k];
      if (typeof v === 'number') assert.ok(Number.isFinite(v), `${k} = ${v}`);
    }
    assert.deepEqual(sanitizeSettings(s), s, 'sanitizing twice changes nothing');
    assert.ok(s.tiltUpDeg > s.deadZoneDeg + s.tiltHysteresisDeg && s.tiltMaxDeg > s.tiltUpDeg);
    assert.ok(s.activityFullDeg > s.activityQuietDeg);
  }, { runs: 300 });
});

test('property: server events of any shape never crash the parser, and what passes is well formed', async () => {
  await forAll((r) => r.list(1, 10, (q) => (q.bool(0.3)
    ? { jobId: q.pick(['a', 'b', 5, null]), seq: junk(q), status: q.pick(['ready', 'received', 'nope', 3]), result: junk(q) }
    : junk(q))), (items) => {
    for (const raw of items) {
      const e = parseEvent(raw);
      if (!e) continue;
      assert.equal(typeof e.jobId, 'string');
      assert.ok(Number.isSafeInteger(e.seq) && e.seq >= 0);
      if (e.status === 'ready') assert.ok(e.result && typeof e.result.short === 'string');
      if (e.result) assert.ok(e.result.detail.every((d) => typeof d === 'string'));
    }
  }, { runs: 300 });
});

test('property: the inbox keeps at most 20 unique answers, newest first, and unseen counts add up', async () => {
  type Op = { add: number } | { see: number };
  await forAll((r) => r.list(1, 80, (q): Op => (q.bool(0.7) ? { add: q.int(0, 40) } : { see: q.int(0, 40) })), (ops) => {
    const inbox = new Inbox(new MemoryStore());
    const order: number[] = [];
    for (const op of ops) {
      if ('add' in op) {
        const added = inbox.add({ jobId: `j${op.add}`, short: 's', detail: [], label: 'LIKELY', caveats: [], pages: 1, usedFrames: 1, at: 0, seen: false });
        if (added) order.unshift(op.add);
      } else inbox.markSeen(`j${op.see}`);
    }
    const ids = inbox.records.map((x) => x.jobId);
    assert.ok(ids.length <= INBOX_SIZE);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(ids, order.slice(0, INBOX_SIZE).map((n) => `j${n}`));
    assert.equal(inbox.unseenCount(), inbox.records.filter((x) => !x.seen).length);
  }, { runs: 200 });
});

test('property: two shakes are never closer than the cooldown, and tilt switched off never scrolls', async () => {
  const off = { ...base, tiltEnabled: false };
  await forAll((r) => ({ seed: r.int(1, 1e9), hz: r.pick([15, 25, 50, 100]) }), ({ seed, hz }) => {
    const m = randomMotionSeq(new Rng(seed), 2, 8);
    const c = countGestures(stream(m, { hz, seed, jitterMs: 5 }), base, true);
    const shakes = c.events.filter((e) => e.type === 'shake').map((e) => e.t);
    for (let i = 1; i < shakes.length; i++) assert.ok(shakes[i] - shakes[i - 1] >= base.shakeCooldownMs, `shakes ${shakes[i - 1]} and ${shakes[i]}`);
    const none = countGestures(stream(m, { hz, seed }), off);
    assert.equal(none.upLines + none.downLines, 0);
    for (const e of c.events) if (e.type === 'shake' || e.type === 'tiltStart') assert.ok(e.confidence >= 0 && e.confidence <= 1);
  }, { runs: 80 });
});

test('property: broken sensor data (NaN, huge jumps, time going back, bursts) never throws or yields non-finite output', async () => {
  await forAll((r) => r.list(10, 400, (q): RawSample => ({
    x: q.bool(0.05) ? q.pick([NaN, Infinity, 1e300]) : q.float(-400, 400),
    y: q.float(-400, 400),
    z: q.bool(0.02) ? NaN : q.float(-10, 10),
    t: q.bool(0.05) ? q.float(-1e6, 1e6) : 0,
  })), (raw) => {
    let t = 0;
    for (const mode of ['orientation', 'rate'] as const) {
      const s = { ...base, imuMode: mode };
      const a = new ImuAdapter(s);
      const e = new GestureEngine(s);
      for (const x of raw) {
        t += 20;
        const sig = a.push({ ...x, t: x.t || t });
        if (!sig) continue;
        assert.ok(Number.isFinite(sig.pitch) && Number.isFinite(sig.yaw) && Number.isFinite(sig.t));
        for (const g of e.push(sig)) assert.ok(Number.isFinite(g.t));
      }
    }
  }, { runs: 150 });
});
