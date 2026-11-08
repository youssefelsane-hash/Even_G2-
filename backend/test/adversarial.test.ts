// Regression tests for defects found by trying to break the backend.
// Each one failed before its fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { CLIENT, startApp } from './helpers.ts';

const imageFiles = async (dataDir: string, id: string) => readdir(path.join(dataDir, 'images', id)).catch(() => [] as string[]);

test('auth blocker: a spoofed X-Forwarded-For prefix does not reset the failure count', async () => {
  const app = await startApp({ env: { TRUST_PROXY: 'true', AUTH_FAILURES_PER_MINUTE: '3' } });
  try {
    // The proxy appends the real client address; whatever comes before it is client-supplied.
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${app.base}/v1/results`, { headers: { Authorization: 'Bearer wrong', 'X-Forwarded-For': `10.9.9.${i}, 203.0.113.7` } });
      assert.equal(r.status, 401);
    }
    const r = await fetch(`${app.base}/v1/results`, { headers: { Authorization: 'Bearer guess', 'X-Forwarded-For': '10.9.9.99, 203.0.113.7' } });
    assert.equal(r.status, 429, 'the same real client stays blocked whatever it puts in front');
  } finally { await app.close(); }
});

test('appendTo an unknown or too old jobId starts a new question instead of dropping the press', async () => {
  const app = await startApp({ env: { APPEND_MAX_AGE_MS: '600000' } });
  try {
    // Unknown id (e.g. purged, or the server data was reset): a 404 would make the camera give up on the photos.
    const r = await app.capture({ appendTo: '00000000-0000-4000-8000-000000000000' });
    assert.equal(r.status, 202);
    const fresh = await r.json();
    assert.equal(app.store.get(fresh.jobId)?.pages, 1);
    assert.equal(app.store.get(fresh.jobId)?.appendedTo, undefined);

    // An hours-old question (the camera remembered its id) must not absorb a new page.
    const old = await (await app.capture()).json();
    await app.waitFor(old.jobId);
    await app.store.update(old.jobId, { createdAt: Date.now() - 2 * 3_600_000 });
    const next = await (await app.capture({ appendTo: old.jobId })).json();
    assert.notEqual(next.jobId, old.jobId);
    assert.equal(app.store.get(next.jobId)?.appendedTo, undefined);
    assert.equal(app.store.get(next.jobId)?.pages, 1);
  } finally { await app.close(); }
});

test('hard limit: photos copied into a continuation are deleted one hour after they were taken', async () => {
  const app = await startApp({ env: { APPEND_WINDOW_MS: '3600000', APPEND_MAX_AGE_MS: '3600000' } });
  try {
    const parent = await (await app.capture({ frames: [{}] })).json();
    const pj = await app.waitFor(parent.jobId);
    const takenAt = Date.now() - 50 * 60_000; // page 1 was photographed 50 minutes ago
    await app.store.update(parent.jobId, { createdAt: takenAt, frames: pj.frames.map((f) => ({ ...f, bornAt: takenAt })) });
    const child = await (await app.capture({ appendTo: parent.jobId, frames: [{}] })).json();
    const cj = await app.waitFor(child.jobId);
    assert.equal(cj.appendedTo, parent.jobId);
    assert.equal((await imageFiles(app.dataDir, child.jobId)).length, 2, 'page 1 copy and page 2');

    await app.store.sweep(Date.now() + 11 * 60_000); // page 1 is now 61 minutes old
    const left = await imageFiles(app.dataDir, child.jobId);
    assert.ok(left.every((f) => f.startsWith('p2-')), `only page 2 may remain, found ${left.join(', ')}`);
    assert.equal(left.length, 1, 'page 2 is only 11 minutes old and stays for the append window');
    assert.deepEqual(await imageFiles(app.dataDir, parent.jobId), []);
    const after = app.store.get(child.jobId)!;
    assert.ok(after.frames.filter((f) => f.page === 1).every((f) => !f.file));
  } finally { await app.close(); }
});

test('a continuation whose earlier photos vanished before the copy still carries the earlier page text', async () => {
  const app = await startApp();
  try {
    const parent = await (await app.capture({ frames: [{}] })).json();
    const pj = await app.waitFor(parent.jobId);
    assert.ok(pj.result?.question, 'mock gives a question text');
    // The sweep (or a disk problem) removed the files, but the record still lists them.
    await rm(path.join(app.dataDir, 'images', parent.jobId), { recursive: true, force: true });
    const child = await (await app.capture({ appendTo: parent.jobId, frames: [{}] })).json();
    const cj = app.store.get(child.jobId)!;
    assert.equal(cj.appendedTo, parent.jobId);
    assert.ok(cj.frames.filter((f) => f.page === 1).every((f) => !f.file));
    assert.match(cj.carriedText ?? '', /as read earlier/, 'the AI gets page 1 as text');
  } finally { await app.close(); }
});

test('the status endpoint for the camera never carries answer text', async () => {
  const app = await startApp();
  try {
    const { jobId } = await (await app.capture()).json();
    await app.waitFor(jobId);
    const body = await (await app.get(`/v1/captures/${jobId}`, 'device-secret-token-cam1')).json();
    assert.deepEqual(Object.keys(body).sort(), ['status']);
    assert.equal((await app.get(`/v1/captures/${jobId}`, CLIENT)).status, 401, 'the phone token is not a camera token');
  } finally { await app.close(); }
});
