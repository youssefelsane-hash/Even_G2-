import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEVICE, startApp } from './helpers.ts';
import { MockProvider } from '../src/providers/mock.ts';

async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'g2-restart-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('a job interrupted mid-AI-call is finished after a restart, without duplicates', () => withDir(async (dataDir) => {
  const p1 = new MockProvider();
  p1.slowMs = 5000;
  let app = await startApp({ dataDir, provider: p1 });
  const { jobId } = await (await app.capture({ key: 'restart-key-1', frames: [{ comment: 'mock:slow' }] })).json();
  await app.waitFor(jobId, ['processing']);
  const cursor = (await app.events('0')).cursor;
  await app.close();

  const p2 = new MockProvider();
  p2.slowMs = 20;
  app = await startApp({ dataDir, provider: p2 });
  try {
    const j = await app.waitFor(jobId);
    assert.equal(j.status, 'ready');
    assert.equal(j.attempts, 2);
    // The camera retries the same press after the outage: same job.
    const again = await (await app.capture({ key: 'restart-key-1' })).json();
    assert.equal(again.jobId, jobId);
    assert.equal(app.store.all().length, 1);
    const ev = await app.events(cursor);
    assert.deepEqual(ev.events.map((e) => [e.jobId, e.status]), [[jobId, 'ready']], 'resumed cursor sees the result once');
    assert.ok(Number(ev.cursor) > Number(cursor));
  } finally { await app.close(); }
}));

test('queued jobs, results, acks, camera settings and display mode survive a restart', () => withDir(async (dataDir) => {
  let app = await startApp({ dataDir });
  const { jobId } = await (await app.capture()).json();
  await app.waitFor(jobId);
  await app.send('POST', '/v1/acks', { jobId, stage: 'displayed' });
  await app.send('PUT', '/v1/camera/config', { burstFrames: 7 });
  await app.send('POST', '/v1/presence', { displayMode: 'HIDDEN' });
  await app.close();

  app = await startApp({ dataDir });
  try {
    const j = app.store.get(jobId)!;
    assert.equal(j.status, 'ready');
    assert.ok(j.displayedAt && j.receivedAt);
    assert.equal((await (await app.get('/v1/camera/config', DEVICE)).json()).burstFrames, 7);
    assert.equal(app.presence.display().displayMode, 'HIDDEN');
    assert.deepEqual(await (await app.get(`/v1/captures/${jobId}`, DEVICE)).json(), { status: 'ready' });
  } finally { await app.close(); }
}));

test('a corrupt job file is set aside and the server still starts', () => withDir(async (dataDir) => {
  let app = await startApp({ dataDir });
  const { jobId } = await (await app.capture()).json();
  await app.waitFor(jobId);
  await app.close();
  await writeFile(path.join(dataDir, 'jobs', 'broken.json'), '{"id": "half');
  await writeFile(path.join(dataDir, 'jobs', `${jobId}.json.123.4.tmp`), 'partial');
  app = await startApp({ dataDir });
  try {
    assert.equal(app.store.all().length, 1);
    const files = await readdir(path.join(dataDir, 'jobs'));
    assert.ok(files.includes('broken.json.corrupt'));
    assert.ok(!files.some((f) => f.endsWith('.tmp')));
  } finally { await app.close(); }
}));

test('a client cursor from before a data reset starts over instead of missing results', () => withDir(async (dataDir) => {
  const app = await startApp({ dataDir });
  try {
    const { jobId } = await (await app.capture()).json();
    await app.waitFor(jobId);
    const r = await app.events('999999');
    assert.deepEqual(r.events.map((e) => e.jobId), [jobId]);
    assert.ok(Number(r.cursor) <= app.store.currentSeq());
  } finally { await app.close(); }
}));
