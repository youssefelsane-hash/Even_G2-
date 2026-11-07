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
