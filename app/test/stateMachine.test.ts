import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootState, contentAllowed, flatState, reduce, type MachineEvent, type MachineState } from '../src/core/stateMachine.ts';

const state = (patch: Partial<MachineState> = {}): MachineState => ({ mode: 'VISIBLE', job: 'IDLE', wear: 'worn', unseen: false, ...patch });
const apply = (s: MachineState, ...events: MachineEvent[]): MachineState => events.reduce((cur, e) => reduce(cur, e).state, s);
const SHAKE: MachineEvent = { type: 'SHAKE' };
const WORN: MachineEvent = { type: 'WEAR', wear: 'worn' };
const REMOVED: MachineEvent = { type: 'WEAR', wear: 'removed' };

test('boot is always hidden, with unknown wear', () => {
  const s = bootState();
  assert.equal(flatState(s), 'HIDDEN');
  assert.equal(s.wear, 'unknown');
  assert.equal(contentAllowed(s), false);
});

test('VISIBLE + shake -> HIDDEN', () => assert.equal(flatState(apply(state(), SHAKE)), 'HIDDEN'));
test('HIDDEN + shake + worn -> VISIBLE', () => assert.equal(flatState(apply(state({ mode: 'HIDDEN' }), SHAKE)), 'VISIBLE'));
test('VISIBLE + removed -> REMOVED', () => assert.equal(flatState(apply(state(), REMOVED)), 'REMOVED'));
test('HIDDEN + removed -> REMOVED', () => assert.equal(flatState(apply(state({ mode: 'HIDDEN' }), REMOVED)), 'REMOVED'));
test('REMOVED + worn -> HIDDEN, not VISIBLE', () => assert.equal(flatState(apply(state(), REMOVED, WORN)), 'HIDDEN'));

test('HIDDEN + tilt is ignored', () => {
  const r = reduce(state({ mode: 'HIDDEN' }), { type: 'SCROLL', source: 'tilt' });
  assert.equal(r.accepted, false);
});

test('VISIBLE + tilt scrolls', () => assert.equal(reduce(state(), { type: 'SCROLL', source: 'tilt' }).accepted, true));

test('HIDDEN + result is stored without revealing', () => {
  const s = apply(state({ mode: 'HIDDEN' }), { type: 'AI_RESULT' });
  assert.equal(flatState(s), 'HIDDEN');
  assert.equal(s.job, 'RESULT_READY');
  assert.equal(s.unseen, true);
  assert.equal(contentAllowed(s), false);
});

test('a result seen after a shake shows as RESULT_READY, then ACK returns to VISIBLE', () => {
  const s = apply(state({ mode: 'HIDDEN' }), { type: 'AI_RESULT' }, SHAKE);
  assert.equal(flatState(s), 'RESULT_READY');
  assert.equal(s.unseen, false);
  assert.equal(flatState(apply(s, { type: 'ACK' })), 'VISIBLE');
});

test('PROCESSING and ERROR show only when visible', () => {
  assert.equal(flatState(apply(state(), { type: 'AI_STARTED' })), 'PROCESSING');
  assert.equal(flatState(apply(state(), { type: 'AI_ERROR' })), 'ERROR');
  assert.equal(flatState(apply(state({ mode: 'HIDDEN' }), { type: 'AI_STARTED' })), 'HIDDEN');
  assert.equal(flatState(apply(state({ mode: 'HIDDEN' }), { type: 'AI_ERROR' })), 'HIDDEN');
});

test('a shake hides from PROCESSING, RESULT_READY and ERROR', () => {
  for (const job of ['PROCESSING', 'RESULT_READY', 'ERROR'] as const) {
    assert.equal(flatState(apply(state({ job }), SHAKE)), 'HIDDEN');
  }
});

test('a result while removed stays stored through re-wear', () => {
  const s = apply(state(), REMOVED, { type: 'AI_RESULT' }, WORN);
  assert.equal(flatState(s), 'HIDDEN');
  assert.equal(s.unseen, true);
});

test('all gestures are ignored while not worn', () => {
  const removed = apply(state(), REMOVED);
  for (const e of [SHAKE, { type: 'SCROLL', source: 'tilt' }, { type: 'TOUCH_RECOVERY' }] as MachineEvent[]) {
    assert.equal(reduce(removed, e).accepted, false, e.type);
  }
  const unknown = state({ mode: 'HIDDEN', wear: 'unknown' });
  assert.equal(reduce(unknown, SHAKE).accepted, false);
  assert.equal(reduce(unknown, { type: 'SCROLL', source: 'tilt' }).accepted, false);
});

test('unknown wear hides visible content but is not treated as removal', () => {
  const s = apply(state(), { type: 'WEAR', wear: 'unknown' });
  assert.equal(flatState(s), 'HIDDEN');
  assert.equal(flatState(apply(state({ mode: 'REMOVED', wear: 'removed' }), { type: 'WEAR', wear: 'unknown' })), 'REMOVED');
});

test('a disconnect hides, and a reconnect never reveals', () => {
  const s = apply(state(), { type: 'CONNECTION', connected: false }, { type: 'CONNECTION', connected: true });
  assert.equal(flatState(s), 'HIDDEN');
  assert.equal(s.wear, 'unknown');
  assert.equal(flatState(apply(s, WORN)), 'HIDDEN');
  assert.equal(flatState(apply(s, WORN, SHAKE)), 'VISIBLE');
});

test('touch recovery works with unknown wear, and is refused when removed', () => {
  assert.equal(flatState(apply(state({ mode: 'HIDDEN', wear: 'unknown' }), { type: 'TOUCH_RECOVERY' })), 'VISIBLE');
  assert.equal(flatState(apply(state({ mode: 'HIDDEN' }), { type: 'TOUCH_RECOVERY' })), 'VISIBLE');
  assert.equal(reduce(state({ mode: 'REMOVED', wear: 'removed' }), { type: 'TOUCH_RECOVERY' }).accepted, false);
});

test('hidden and removed never allow content, for every job', () => {
  for (const mode of ['HIDDEN', 'REMOVED'] as const) {
    for (const job of ['IDLE', 'PROCESSING', 'RESULT_READY', 'ERROR'] as const) {
      const s = state({ mode, job });
      assert.equal(contentAllowed(s), false);
      assert.equal(flatState(s), mode);
    }
  }
});

test('no sequence of non-reveal events can reach VISIBLE from a hidden start', () => {
  const events: MachineEvent[] = [
    WORN, REMOVED, { type: 'WEAR', wear: 'unknown' }, { type: 'CONNECTION', connected: true }, { type: 'CONNECTION', connected: false },
    { type: 'AI_STARTED' }, { type: 'AI_RESULT' }, { type: 'AI_ERROR' }, { type: 'ACK' }, { type: 'SCROLL', source: 'tilt' }, { type: 'SCROLL', source: 'touch' },
  ];
  let seed = 12345;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  for (let run = 0; run < 500; run++) {
    let s = bootState(run % 2 === 0);
    for (let i = 0; i < 40; i++) {
      s = reduce(s, events[next() % events.length]).state;
      assert.notEqual(s.mode, 'VISIBLE');
    }
  }
});

test('an exit hides from any visible state and keeps wear', () => {
  for (const job of ['IDLE', 'PROCESSING', 'RESULT_READY', 'ERROR'] as const) {
    const s = apply(state({ job }), { type: 'EXIT' });
    assert.equal(flatState(s), 'HIDDEN');
    assert.equal(s.wear, 'worn');
  }
  assert.equal(flatState(apply(state({ mode: 'REMOVED', wear: 'removed' }), { type: 'EXIT' })), 'REMOVED');
});

// Every state against every event, so a rule cannot hold only on the paths someone thought of.
test('every state and event obeys the spec rules', () => {
  const modes = ['VISIBLE', 'HIDDEN', 'REMOVED'] as const;
  const jobs = ['IDLE', 'PROCESSING', 'RESULT_READY', 'ERROR'] as const;
  const wears = ['worn', 'removed', 'unknown'] as const;
  const events: MachineEvent[] = [
    SHAKE, { type: 'SCROLL', source: 'tilt' }, { type: 'SCROLL', source: 'touch' }, { type: 'TOUCH_RECOVERY' }, { type: 'ACK' }, { type: 'EXIT' },
    WORN, REMOVED, { type: 'WEAR', wear: 'unknown' }, { type: 'CONNECTION', connected: true }, { type: 'CONNECTION', connected: false },
    { type: 'AI_STARTED' }, { type: 'AI_RESULT' }, { type: 'AI_ERROR' },
  ];
  for (const mode of modes) for (const job of jobs) for (const wear of wears) for (const unseen of [false, true]) {
    if (mode === 'VISIBLE' && wear === 'removed') continue; // cannot be reached: removal always leaves VISIBLE
    if (mode === 'HIDDEN' && wear === 'removed') continue;
    const s: MachineState = { mode, job, wear, unseen };
    for (const e of events) {
      const label = `${mode}/${job}/${wear}/${unseen} + ${e.type}`;
      const { state: n, accepted } = reduce(s, e);
      if (!accepted) assert.deepEqual(n, s, `${label}: an ignored event changes nothing`);
      // The only ways to become visible: a shake while worn, or touch recovery while not removed.
      if (mode !== 'VISIBLE' && n.mode === 'VISIBLE') {
        assert.equal(mode, 'HIDDEN', label);
        assert.ok((e.type === 'SHAKE' && wear === 'worn') || (e.type === 'TOUCH_RECOVERY' && wear !== 'removed'), label);
      }
      if (mode === 'REMOVED' && e.type !== 'WEAR') assert.equal(n.mode, 'REMOVED', `${label}: only wearing them again leaves Removed`);
      if (e.type === 'WEAR' && e.wear === 'removed') assert.equal(n.mode, 'REMOVED', label);
      if (e.type === 'CONNECTION' && !e.connected) assert.notEqual(n.mode, 'VISIBLE', label);
      if (e.type === 'CONNECTION' && e.connected) assert.equal(n.mode, mode, label);
      if (e.type === 'AI_RESULT' || e.type === 'AI_ERROR' || e.type === 'AI_STARTED') assert.equal(n.mode, mode, `${label}: the AI never changes what is revealed`);
      if (e.type === 'SCROLL') assert.equal(n.mode, mode, label);
      if (wear !== 'worn' && (e.type === 'SHAKE' || (e.type === 'SCROLL' && e.source === 'tilt'))) assert.equal(accepted, false, `${label}: gestures need worn`);
    }
  }
});

test('undo hide reveals only from Hidden while worn, never with wear unknown or removed', () => {
  const undo = { type: 'UNDO_HIDE' } as const;
  const base = bootState();
  assert.equal(reduce({ ...base, wear: 'worn' }, undo).state.mode, 'VISIBLE');
  assert.equal(reduce({ ...base, wear: 'unknown' }, undo).accepted, false);
  assert.equal(reduce({ ...base, mode: 'REMOVED', wear: 'removed' }, undo).accepted, false);
  assert.equal(reduce({ ...base, mode: 'VISIBLE', wear: 'worn' }, undo).accepted, false);
});
