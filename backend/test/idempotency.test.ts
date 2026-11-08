import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { DEVICE2, captureBody, startApp } from './helpers.ts';

test('a retried upload with the same key returns the same job', async () => {
  const app = await startApp();
  try {
    const a = await (await app.capture({ key: 'press-0001' })).json();
    const b = await app.capture({ key: 'press-0001' });
    assert.equal(b.status, 202);
    const bb = await b.json();
    assert.equal(bb.jobId, a.jobId);
    assert.equal(bb.duplicate, true);
    assert.equal(app.store.all().length, 1);
  } finally { await app.close(); }
});

test('race: 8 concurrent uploads with one key create exactly one job and one image set', async () => {
  const app = await startApp();
  try {
    const { body, contentType } = captureBody();
    const replies = await Promise.all(Array.from({ length: 8 }, () => app.rawCapture(body, contentType, { key: 'press-race-1' })));
    const bodies = await Promise.all(replies.map((r) => r.json()));
    assert.ok(replies.every((r) => r.status === 202), replies.map((r) => r.status).join(','));
    assert.equal(new Set(bodies.map((b) => b.jobId)).size, 1, 'one jobId for all');
    assert.equal(bodies.filter((b) => !b.duplicate).length, 1, 'exactly one original');
    assert.equal(app.store.all().length, 1);
    const dirs = await readdir(path.join(app.dataDir, 'images'));
    assert.equal(dirs.length, 1);
    assert.equal((await readdir(path.join(app.dataDir, 'images', dirs[0]))).length, 3);
    // And the glasses get one result, not eight.
    await app.waitFor(bodies[0].jobId);
    assert.equal((await app.events('0')).events.length, 1);
  } finally { await app.close(); }
});

test('race: concurrent different keys each get their own job', async () => {
  const app = await startApp();
  try {
    const replies = await Promise.all(Array.from({ length: 5 }, (_, i) => app.capture({ key: `press-many-${i}` })));
    const ids = await Promise.all(replies.map(async (r) => (await r.json()).jobId));
    assert.equal(new Set(ids).size, 5);
  } finally { await app.close(); }
});

test('keys are scoped per device', async () => {
  const app = await startApp();
  try {
    const a = await (await app.capture({ key: 'shared-key-1' })).json();
    const b = await (await app.capture({ key: 'shared-key-1', token: DEVICE2 })).json();
    assert.notEqual(a.jobId, b.jobId);
  } finally { await app.close(); }
});

test('race: concurrent appends to one queued question merge in order without losing a page', async () => {
  const app = await startApp({ env: { MOCK_SLOW_MS: '400' } });
  try {
    // Keep the worker busy so the next job stays queued.
    await app.capture({ frames: [{ comment: 'mock:slow' }] });
    await new Promise((r) => setTimeout(r, 30));
    const q = await (await app.capture({ key: 'question-1' })).json();
    const appends = await Promise.all([1, 2, 3].map((i) => app.capture({ key: `question-1-p${i}`, appendTo: q.jobId, frames: [{}] })));
    const ids = await Promise.all(appends.map(async (r) => (await r.json()).jobId));
    assert.deepEqual(ids, [q.jobId, q.jobId, q.jobId], 'all merged into the queued question');
    const j = app.store.get(q.jobId)!;
    assert.equal(j.pages, 4);
    assert.equal(j.frames.length, 6);
    assert.deepEqual([...new Set(j.frames.map((f) => f.page))].sort(), [1, 2, 3, 4]);
    // Retrying one of the appends must not add the page twice.
    await app.capture({ key: 'question-1-p2', appendTo: q.jobId, frames: [{}] });
    assert.equal(app.store.get(q.jobId)!.pages, 4);
  } finally { await app.close(); }
});
