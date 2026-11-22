import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLANK, BLANK_TEXT, RenderQueue, type DisplayPort } from '../src/core/renderQueue.ts';

class FakePort implements DisplayPort {
  sent: string[] = [];
  rebuilt: string[] = [];
  gate: Promise<void> = Promise.resolve();
  ok = true;
  rebuildOk = true;
  async setText(t: string): Promise<boolean> {
    this.sent.push(t);
    await this.gate;
    return this.ok;
  }
  async rebuild(t: string): Promise<boolean> {
    this.rebuilt.push(t);
    return this.rebuildOk;
  }
}

const text = (t: string) => ({ kind: 'text', text: t }) as const;

test('calls are serial and only the newest waiting plan is sent', async () => {
  const p = new FakePort();
  let open!: () => void;
  p.gate = new Promise((r) => { open = r; });
  const q = new RenderQueue(p);
  const done = q.show(text('a'));
  for (const t of ['b', 'c', 'd']) void q.show(text(t));
  open();
  await done;
  assert.deepEqual(p.sent, ['a', 'd']);
});

test('a hide during a slow update goes straight after it and nothing follows', async () => {
  const p = new FakePort();
  let open!: () => void;
  p.gate = new Promise((r) => { open = r; });
  const q = new RenderQueue(p);
  const done = q.show(text('answer'));
  void q.show(text('answer scrolled'));
  void q.show(BLANK);
  open();
  await done;
  assert.equal(p.sent.at(-1), BLANK_TEXT);
  assert.equal(p.sent.length, 2);
});

test('blank timing includes the wait behind an in-progress update', async () => {
  let now = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const q = new RenderQueue({
    async setText(value) {
      if (value === BLANK_TEXT) now += 15;
      else await gate;
      return true;
    },
    async rebuild() { assert.fail('the update is accepted'); },
  }, 1000, () => now);
  const pending = q.show(text('test'));
  now = 25;
  void q.show(BLANK);
  now = 50;
  void q.show(BLANK); // an unchanged periodic refresh does not reset the timer
  release();
  await pending;
  assert.deepEqual(q.timings, { blankMs: 40, textMs: 50 });
});

test('removing the glasses cancels a text update still waiting to reach the bridge', async () => {
  let ready!: () => void;
  const gate = new Promise<void>((resolve) => { ready = resolve; });
  const sent: string[] = [];
  const q = new RenderQueue({
    async setText(value, stillWanted) {
      await gate;
      if (!stillWanted()) return false;
      sent.push(value);
      return true;
    },
    async rebuild() { assert.fail('no stale text rebuild'); },
  });
  const done = q.show(text('answer'));
  void q.show(BLANK, true);
  ready();
  await done;
  assert.deepEqual(sent, [BLANK_TEXT]);
});

test('rapid removal, re-wear and unlock still blank the lens before the next answer', async () => {
  const p = new FakePort();
  let release!: () => void;
  p.gate = new Promise((resolve) => { release = resolve; });
  const q = new RenderQueue(p);
  const done = q.show(text('previous line'));
  void q.show(text('scroll update'));
  void q.show(BLANK, true);
  void q.show(BLANK, true);
  void q.show(text('answer after unlock'));
  release();
  await done;
  assert.deepEqual(p.sent, ['previous line', BLANK_TEXT, 'answer after unlock']);
});

test('a blank that fails to clear the lens holds back text until it succeeds', async () => {
  const p = new FakePort();
  const q = new RenderQueue(p);
  await q.show(text('previous answer'));
  p.ok = p.rebuildOk = false;
  const done = q.show(BLANK, true);
  void q.show(text('new answer'));
  await done;
  assert.deepEqual(p.sent, ['previous answer', BLANK_TEXT]);
  assert.deepEqual(p.rebuilt, [BLANK_TEXT]);
  assert.equal(q.status, 'unconfirmed');
  p.ok = true;
  await q.show(text('new answer'));
  assert.deepEqual(p.sent, ['previous answer', BLANK_TEXT, BLANK_TEXT, 'new answer']);
});

test('an expired bridge command cannot send an old render after a fresh unlock', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const sent: string[] = [];
  let first = true;
  const q = new RenderQueue({
    async setText(t, stillWanted) {
      const delayed = first;
      first = false;
      if (delayed) await gate;
      if (!stillWanted()) return false;
      sent.push(delayed ? `late ${t}` : t);
      return true;
    },
    async rebuild() { assert.fail('no stale text rebuild'); },
  }, 20);
  const done = q.show(text('answer'));
  void q.show(BLANK, true);
  void q.show(text('answer'));
  await done;
  release();
  await gate;
  assert.deepEqual(sent, [BLANK_TEXT, 'answer']);
});

test('an unchanged plan is not sent, unless forced', async () => {
  const p = new FakePort();
  const q = new RenderQueue(p);
  await q.show(text('a'));
  await q.show(text('a'));
  assert.equal(p.sent.length, 1);
  await q.show(text('a'), true);
  assert.equal(p.sent.length, 2);
});

test('a blank that fails falls back to a full rebuild', async () => {
  const p = new FakePort();
  const q = new RenderQueue(p);
  await q.show(text('a'));
  p.ok = false;
  await q.show(BLANK);
  assert.deepEqual(p.rebuilt, [BLANK_TEXT]);
});

test('a failed text update rebuilds the page if the text is still wanted', async () => {
  const p = new FakePort();
  p.ok = false;
  const q = new RenderQueue(p);
  await q.show(text('answer'));
  await q.show(text('answer'));
  assert.deepEqual(p.sent, ['answer']);
  assert.deepEqual(p.rebuilt, ['answer']);
});

test('a pending hide prevents rebuilding a failed text update', async () => {
  const p = new FakePort();
  let open!: () => void;
  p.gate = new Promise((r) => { open = r; });
  p.ok = false;
  const q = new RenderQueue(p);
  const done = q.show(text('answer'));
  void q.show(BLANK);
  open();
  await done;
  assert.deepEqual(p.rebuilt, [BLANK_TEXT]);
});

test('a blank that cannot be delivered is reported and retried on the next plan', async () => {
  const p = new FakePort();
  p.rebuildOk = false;
  const q = new RenderQueue(p);
  let failed = 0;
  q.onBlankFailed = () => failed++;
  await q.show(text('a'));
  p.ok = false;
  await q.show(BLANK);
  assert.equal(failed, 1);
  p.ok = true;
  await q.show(BLANK);
  assert.equal(p.sent.at(-1), BLANK_TEXT);
});

test('a call that hangs times out instead of blocking the blank', async () => {
  const p = new FakePort();
  p.gate = new Promise(() => {}); // never resolves
  const q = new RenderQueue(p, 20);
  const done = q.show(text('a'));
  p.gate = Promise.resolve();
  void q.show(BLANK);
  await done;
  assert.equal(p.sent.at(-1), BLANK_TEXT);
});

test('a forced redraw requested during a call is not lost', async () => {
  const p = new FakePort();
  let open!: () => void;
  p.gate = new Promise((r) => { open = r; });
  const q = new RenderQueue(p);
  const done = q.show(BLANK); // first call goes out while the link is failing
  void q.show(BLANK, true); // the reconnect asks for a redraw
  p.gate = Promise.resolve();
  open();
  await done;
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(p.sent.length, 2, 'the blank must be sent again after the reconnect');
});

test('a fresh queue does not assume the lens is blank', async () => {
  // After a WebView restart the old page can still be on the lens.
  const p = new FakePort();
  await new RenderQueue(p).show(BLANK);
  assert.deepEqual(p.sent, [BLANK_TEXT]);
});

test('a port that throws at once cannot lose a hide', async () => {
  const p = new FakePort();
  const q = new RenderQueue(p);
  await q.show(text('a'));
  p.setText = () => { throw new Error('bad call'); };
  await q.show(BLANK);
  assert.deepEqual(p.rebuilt, [BLANK_TEXT]);
});

test('a plan that arrives just as the queue finishes is still sent', async () => {
  for (let tick = 0; tick < 12; tick++) {
    const p = new FakePort();
    let open!: () => void;
    p.gate = new Promise((r) => { open = r; });
    const q = new RenderQueue(p);
    void q.show(text('a'));
    open();
    for (let i = 0; i < tick; i++) await Promise.resolve();
    void q.show(BLANK);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(p.sent.at(-1), BLANK_TEXT, `arrived after ${tick} microtasks`);
  }
});
