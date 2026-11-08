import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE2, startApp, until } from './helpers.ts';
import { MockProvider } from '../src/providers/mock.ts';

test('double press while the question is still queued: pages merge into one AI call', async () => {
  const provider = new MockProvider();
  provider.slowMs = 300;
  const app = await startApp({ provider });
  try {
    await app.capture({ frames: [{ comment: 'mock:slow' }] });
    await new Promise((r) => setTimeout(r, 30));
    const q = await (await app.capture()).json();
    const p2 = await (await app.capture({ appendTo: 'previous', frames: [{}, {}] })).json();
    assert.equal(p2.jobId, q.jobId);
    const j = await app.waitFor(q.jobId);
    assert.equal(j.status, 'ready');
    assert.equal(j.result?.pages, 2);
    assert.equal(j.result?.usedFrames, 5);
    assert.equal(provider.lastInput?.pages, 2);
    assert.deepEqual(provider.lastInput?.images.map((i) => i.page), [1, 1, 1, 2, 2]);
    assert.equal(provider.calls, 2, 'slow job + one fused call, not one per page');
    const ev = (await app.events('0')).events.find((e) => e.jobId === q.jobId)!;
    assert.equal(ev.photos, 5);
  } finally { await app.close(); }
});

test('double press after the answer: a continuation job reuses the earlier photos', async () => {
  const provider = new MockProvider();
  const app = await startApp({ provider });
  try {
    const q = await (await app.capture()).json();
    await app.waitFor(q.jobId);
    const c = await (await app.capture({ appendTo: 'previous', frames: [{}] })).json();
    assert.notEqual(c.jobId, q.jobId);
    const cj = await app.waitFor(c.jobId);
    assert.equal(cj.appendedTo, q.jobId);
    assert.equal(cj.result?.pages, 2);
    assert.equal(provider.lastInput?.images.length, 4, '3 earlier frames + 1 new');
    assert.equal(provider.lastInput?.carriedText, undefined);
    const ev = (await app.events('0')).events.find((e) => e.jobId === c.jobId)!;
    assert.equal(ev.appendedTo, q.jobId, 'the app can replace the earlier answer');
  } finally { await app.close(); }
});

test('continuation after the earlier photos were deleted: page text is carried instead', async () => {
  const provider = new MockProvider();
  const app = await startApp({ provider, env: { APPEND_WINDOW_MS: '0' } });
  try {
    const q = await (await app.capture()).json();
    await app.waitFor(q.jobId);
    await until(() => app.store.get(q.jobId)?.imagesDeletedAt);
    const c = await (await app.capture({ appendTo: q.jobId, frames: [{}] })).json();
    const cj = await app.waitFor(c.jobId);
    assert.equal(cj.status, 'ready');
    assert.equal(provider.lastInput?.images.length, 1, 'only the new page has photos');
    assert.match(provider.lastInput?.carriedText ?? '', /Pages 1-1, as read earlier: Solve for x/);
    assert.equal(cj.result?.pages, 2);
  } finally { await app.close(); }
});

test('a continuation waits for its parent, so results arrive in order', async () => {
  const provider = new MockProvider();
  provider.slowMs = 300;
  const app = await startApp({ provider });
  try {
    const q = await (await app.capture({ frames: [{ comment: 'mock:slow' }] })).json();
    await app.waitFor(q.jobId, ['processing']);
    const c = await (await app.capture({ appendTo: 'previous', frames: [{}] })).json();
    assert.notEqual(c.jobId, q.jobId, 'parent already started: new job');
    assert.equal(app.store.get(c.jobId)?.status, 'queued');
    await app.waitFor(c.jobId);
    const p = app.store.get(q.jobId)!;
    const cj = app.store.get(c.jobId)!;
    assert.ok(p.finishedAt! <= cj.finishedAt!);
    assert.ok(p.eventSeq < cj.eventSeq);
    // The parent's slow-marker frame was copied, so the continuation is slow too; both used.
    assert.equal(provider.lastInput?.images.length, 2);
  } finally { await app.close(); }
});

test('appendTo errors: unknown job, other device, too many pages; previous with nothing recent starts fresh', async () => {
  const app = await startApp({ env: { MAX_PAGES: '2' } });
  try {
    const fresh = await (await app.capture({ appendTo: 'previous' })).json();
    assert.equal(app.store.get(fresh.jobId)?.pages, 1);
    assert.equal(app.store.get(fresh.jobId)?.appendedTo, undefined);
    // Unknown id: a new question, not a 404 that would make the camera drop the photos.
    const unknown = await app.capture({ token: DEVICE2, appendTo: '00000000-0000-4000-8000-000000000000' });
    assert.equal(unknown.status, 202);
    assert.equal(app.store.get((await unknown.json()).jobId)?.appendedTo, undefined);
    const other = await app.capture({ appendTo: fresh.jobId, token: DEVICE2 });
    assert.equal(other.status, 202);
    const otherJob = app.store.get((await other.json()).jobId)!;
    assert.equal(otherJob.appendedTo, undefined, "cannot append to another device's question");
    assert.equal(app.store.get(fresh.jobId)?.pages, 1);
    await app.waitFor(fresh.jobId);
    const p2 = await (await app.capture({ appendTo: fresh.jobId, frames: [{}] })).json();
    const r = await app.capture({ appendTo: p2.jobId, frames: [{}] });
    assert.equal(r.status, 409);
  } finally { await app.close(); }
});

test('a page whose photos are all unusable is named in the caveats', async () => {
  const provider = new MockProvider();
  provider.slowMs = 300;
  const app = await startApp({ provider });
  try {
    await app.capture({ frames: [{ comment: 'mock:slow' }] });
    await new Promise((r) => setTimeout(r, 30));
    const q = await (await app.capture()).json();
    await app.capture({ appendTo: 'previous', frames: [{ meta: { brightness: 5 } }] });
    const j = await app.waitFor(q.jobId);
    assert.equal(j.status, 'ready');
    assert.match(j.result!.caveats[0], /Page 2 photos were unusable \(too dark\)/);
  } finally { await app.close(); }
});
