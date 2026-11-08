import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResultClient, type JobEvent } from '../src/core/backend.ts';
import { INBOX_KEY, INBOX_SIZE } from '../src/core/inbox.ts';
import { MemoryStore } from '../src/core/storage.ts';
import { shake, still } from '../src/core/synth.ts';
import { FakeBackend, MemoryKV, TOKEN, until } from './fakeBackend.ts';
import { Rig } from './helpers.ts';

// Camera job events reaching the Assistant: status display, retakes, pages,
// the hidden queue, acknowledgements and presence.

let seq = 0;
const ev = (jobId: string, status: JobEvent['status'], extra: Partial<JobEvent> = {}): JobEvent => ({ jobId, seq: ++seq, status, photos: 3, pages: 1, ...extra });
const ready = (jobId: string, short = `Answer ${jobId}`, extra: Partial<JobEvent> = {}): JobEvent =>
  ev(jobId, 'ready', { result: { short, detail: Array.from({ length: 20 }, (_, i) => `${short} detail ${i + 1}.`), label: 'CHECKED', caveats: ['Check the units.'], pages: extra.pages ?? 1, usedFrames: 2 }, ...extra });
const retake = (jobId: string, reason: string) => ev(jobId, 'retake', { result: { short: '', detail: [], label: 'RETAKE', caveats: [], pages: 1, usedFrames: 0, retakeReason: reason } });

async function visible(store = new MemoryStore()): Promise<Rig> {
  const r = await new Rig(store).ready();
  r.play(shake());
  assert.equal(r.a.state, 'VISIBLE');
  return r;
}

async function hidden(store = new MemoryStore()): Promise<Rig> {
  const r = await new Rig(store).ready();
  assert.equal(r.a.state, 'HIDDEN');
  return r;
}

test('VISIBLE: received -> reading -> ready, shown in the header line', async () => {
  const r = await visible();
  await r.a.handleJobEvent(ev('a', 'received', { photos: 3 }));
  assert.match(r.text().split('\n')[0], /^RECEIVED 3 PHOTOS/);
  await r.a.handleJobEvent(ev('a', 'processing'));
  assert.match(r.text().split('\n')[0], /^READING\.\.\./);
  await r.a.handleJobEvent(ready('a'));
  assert.equal(r.a.state, 'RESULT_READY');
  assert.match(r.text().split('\n')[0], /^CHECKED/);
  assert.match(r.text(), /Answer a/);
  assert.deepEqual(r.displayed, ['a'], 'displayed ack only once it was on the lens');
});

test('one photo is singular, and an appended page says which page', async () => {
  const r = await visible();
  await r.a.handleJobEvent(ev('a', 'received', { photos: 1 }));
  assert.match(r.text(), /^RECEIVED 1 PHOTO\b/);
  await r.a.handleJobEvent(ev('b', 'processing', { pages: 2, appendedTo: 'a' }));
  assert.match(r.text(), /^READING\.\.\. \(page 2\)/);
});

test('HIDDEN and REMOVED: camera status draws nothing at all', async () => {
  const r = await hidden();
  const mark = r.markPlans();
  await r.a.handleJobEvent(ev('a', 'received'));
  await r.a.handleJobEvent(ev('a', 'processing'));
  await r.a.handleJobEvent(ready('a'));
  await r.a.handleJobEvent(retake('b', 'too dark'));
  r.a.handleWear(false);
  await r.a.handleJobEvent(ready('c'));
  assert.ok(r.plansSince(mark).every((p) => !r.lit(p)), 'no plan lit the lens');
  assert.deepEqual(r.displayed, []);
});

test('retake shows the reason and a press dismisses it', async () => {
  const r = await visible();
  await r.a.handleJobEvent(ev('a', 'received'));
  await r.a.handleJobEvent(retake('a', 'too dark'));
  assert.equal(r.a.state, 'ERROR');
  assert.match(r.text(), /^RETAKE/);
  assert.match(r.text(), /Retake: too dark/);
  r.a.handleTouch('press');
  assert.equal(r.a.state, 'VISIBLE');
  assert.doesNotMatch(r.text(), /Retake/);
});

test('failed job shows a plain error', async () => {
  const r = await visible();
  await r.a.handleJobEvent(ev('a', 'failed', { error: 'provider down' }));
  assert.equal(r.a.state, 'ERROR');
  assert.match(r.text(), /could not be made/);
  assert.doesNotMatch(r.text(), /provider down/, 'server error text is not shown');
});

test('a late status after the result does not bring back "reading"', async () => {
  const r = await visible();
  await r.a.handleJobEvent(ready('a'));
  await r.a.handleJobEvent(ev('a', 'processing'));
  assert.doesNotMatch(r.text(), /READING/);
  assert.equal(r.a.state, 'RESULT_READY');
});

test('a second page replaces the first answer, with the page count in the header', async () => {
  const r = await visible();
  await r.a.handleJobEvent(ready('p1', 'First page'));
  await r.a.handleJobEvent(ready('p2', 'Both pages', { appendedTo: 'p1', pages: 2 }));
  assert.match(r.text(), /^CHECKED 2p/);
  assert.match(r.text(), /Both pages/);
  assert.equal(r.a.snapshot().stored, 1);
});

test('hidden queue: three answers while hidden, newest first on restore, then the rest by press', async () => {
  const r = await hidden();
  await r.a.handleJobEvent(ready('a', 'Oldest'));
  await r.a.handleJobEvent(ready('b', 'Middle'));
  await r.a.handleJobEvent(ready('c', 'Newest'));
  assert.equal(r.a.snapshot().unseenAnswers, 3);
  assert.ok(!r.lit());
  r.play(still(1300));
  r.play(shake());
  assert.equal(r.a.state, 'RESULT_READY');
  assert.match(r.text(), /Newest/);
  assert.match(r.text().split('\n')[0], /\+2 new/);
  r.a.handleTouch('press');
  assert.match(r.text(), /Middle/);
  assert.match(r.text().split('\n')[0], /\+1 new/);
  r.a.handleTouch('press');
  assert.match(r.text(), /Oldest/);
  assert.doesNotMatch(r.text().split('\n')[0], /new/);
  r.a.handleTouch('press');
  assert.equal(r.a.state, 'VISIBLE');
  assert.deepEqual(r.displayed, ['c', 'b', 'a']);
});

test('the inbox keeps the newest 20 and drops the oldest', async () => {
  const r = await hidden();
  for (let i = 0; i < INBOX_SIZE + 5; i++) await r.a.handleJobEvent(ready(`j${i}`));
  assert.equal(r.a.snapshot().stored, INBOX_SIZE);
  const saved = JSON.parse((await r.store.get(INBOX_KEY))!) as { jobId: string }[];
  assert.equal(saved.length, INBOX_SIZE);
  assert.equal(saved[0].jobId, `j${INBOX_SIZE + 4}`);
  assert.ok(!saved.some((x) => x.jobId === 'j0'));
});

test('restart: queued answers survive, nothing is revealed, and a shake still shows the newest', async () => {
  const store = new MemoryStore();
  const r = await hidden(store);
  await r.a.handleJobEvent(ready('a', 'Before restart A'));
  await r.a.handleJobEvent(ready('b', 'Before restart B'));
  await r.a.flush();
  const r2 = await new Rig(store).ready();
  assert.equal(r2.a.state, 'HIDDEN');
  assert.ok(r2.plans.every((p) => !r2.lit(p)), 'restart never lit the lens');
  // The same results come again from the server after the restart: no duplicates.
  await r2.a.handleJobEvent(ready('a', 'Before restart A'));
  await r2.a.handleJobEvent(ready('b', 'Before restart B'));
  assert.equal(r2.a.snapshot().stored, 2);
  assert.ok(r2.plans.every((p) => !r2.lit(p)));
  r2.play(shake());
  assert.match(r2.text(), /Before restart B/);
  assert.match(r2.text(), /\+1 new/);
});

test('reconnect never reveals a result that arrived while disconnected', async () => {
  const r = await visible();
  r.a.handleConnection(false);
  await r.a.handleJobEvent(ready('a', 'While away'));
  r.a.handleConnection(true);
  r.a.handleWear(true);
  assert.ok(!r.lit());
  assert.deepEqual(r.displayed, []);
});

test('presence follows what the lens may show', async () => {
  const r = await new Rig().start();
  r.a.handleConnection(true);
  r.a.handleWear(true);
  r.wait(2000);
  r.play(still(1500));
  r.play(shake());
  r.a.handleWear(false);
  r.a.handleWear(true);
  r.a.handleConnection(false);
  assert.deepEqual(r.presence, ['HIDDEN', 'VISIBLE', 'REMOVED', 'HIDDEN', 'UNKNOWN']);
});

test('the phone panel snapshot never carries answer text', async () => {
  const r = await visible();
  await r.a.handleJobEvent(ready('secret', 'TOP SECRET ANSWER'));
  assert.doesNotMatch(JSON.stringify(r.a.snapshot()), /SECRET/);
});

test('end to end with the fake server: poll, store, show, ack displayed', async () => {
  const fake = new FakeBackend();
  const r = await new Rig(new MemoryStore()).ready();
  let client: ResultClient | null = null;
  r.extra.onDisplayed = (id) => client?.ack(id, 'displayed');
  r.extra.onPresence = (m) => client?.setPresence(m);
  await r.start(); // rebuild with the client hooks
  r.a.handleConnection(true);
  r.a.handleWear(true);
  r.wait(2000);
  r.play(still(1500));
  client = new ResultClient({ kv: new MemoryKV(), fetch: fake.fetch, waitSeconds: 1, sleep: (ms, s) => new Promise((res) => { const t = setTimeout(res, Math.min(ms, 5)); s.addEventListener('abort', () => { clearTimeout(t); res(); }); }), onEvent: (e) => r.a.handleJobEvent(e) });
  client.setPresence(r.a.snapshot().presence);
  client.start({ serverUrl: 'https://fake.test', token: TOKEN });
  fake.push({ jobId: 'e1', status: 'received', photos: 2, pages: 1 });
  fake.ready('e1', 'Hidden answer');
  await until(() => fake.acks.some((a) => a.stage === 'received'), 2000, 'received ack');
  assert.ok(!r.lit(), 'still hidden');
  assert.ok(!fake.acks.some((a) => a.stage === 'displayed'), 'not displayed while hidden');
  assert.equal(fake.presence.at(-1), 'HIDDEN');
  r.play(shake());
  assert.match(r.text(), /Hidden answer/);
  await until(() => fake.acks.some((a) => a.stage === 'displayed') && fake.presence.at(-1) === 'VISIBLE', 2000, 'displayed ack');
  await client.stop();
});
