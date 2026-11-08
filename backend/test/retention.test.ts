import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEVICE, startApp, until } from './helpers.ts';
import { MockProvider } from '../src/providers/mock.ts';

const imageFiles = async (dataDir: string, id: string) => readdir(path.join(dataDir, 'images', id)).catch(() => [] as string[]);

test('images are deleted as soon as a job ends when there is no append window', async () => {
  const app = await startApp({ env: { APPEND_WINDOW_MS: '0' } });
  try {
    for (const comment of ['mock:ready', 'mock:retake:blurry', 'mock:fail']) {
      const { jobId } = await (await app.capture({ frames: [{ comment }, {}] })).json();
      assert.equal((await imageFiles(app.dataDir, jobId)).length, 2, 'stored while queued');
      const j = await app.waitFor(jobId);
      await until(() => app.store.get(jobId)?.imagesDeletedAt);
      assert.deepEqual(await imageFiles(app.dataDir, jobId), [], `${j.status}: images gone`);
      const after = app.store.get(jobId)!;
      assert.ok(after.imagesDeletedAt);
      assert.ok(after.frames.every((f) => f.file === undefined));
    }
  } finally { await app.close(); }
});

test('with an append window, images go when the window closes', async () => {
  const app = await startApp({ env: { APPEND_WINDOW_MS: '60000' } });
  try {
    const { jobId } = await (await app.capture()).json();
    await app.waitFor(jobId);
    assert.equal((await imageFiles(app.dataDir, jobId)).length, 3, 'kept for a possible double press');
    await app.store.sweep(Date.now() + 59_000);
    assert.equal((await imageFiles(app.dataDir, jobId)).length, 3);
    await app.store.sweep(Date.now() + 60_001);
    assert.deepEqual(await imageFiles(app.dataDir, jobId), []);
  } finally { await app.close(); }
});

test('hard limit: nothing is kept past one hour, even unfinished jobs; a late AI answer is dropped', async () => {
  const provider = new MockProvider();
  provider.slowMs = 400;
  const app = await startApp({ provider });
  try {
    const slow = await (await app.capture({ frames: [{ comment: 'mock:slow' }] })).json();
    await app.waitFor(slow.jobId, ['processing']);
    const queued = await (await app.capture()).json();
    const r = await app.store.sweep(Date.now() + 3_600_001);
    assert.equal(r.expired, 2);
    for (const id of [slow.jobId, queued.jobId]) {
      const j = app.store.get(id)!;
      assert.equal(j.status, 'failed');
      assert.equal(j.error, 'expired');
      assert.deepEqual(await imageFiles(app.dataDir, id), []);
    }
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(app.store.get(slow.jobId)?.status, 'failed', 'the slow answer did not overwrite the expiry');
  } finally { await app.close(); }
});

test('results are purged after the TTL, and the cursor never goes backwards', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'g2-ttl-'));
  try {
    let app = await startApp({ dataDir });
    const { jobId } = await (await app.capture({ key: 'ttl-key-1' })).json();
    await app.waitFor(jobId);
    const before = await app.events('0');
    const r = await app.store.sweep(Date.now() + 31 * 24 * 3_600_000);
    assert.equal(r.purged, 1);
    assert.equal((await app.get(`/v1/captures/${jobId}`, DEVICE)).status, 404);
    assert.deepEqual((await app.events('0')).events, []);
    await app.close();
    app = await startApp({ dataDir });
    assert.ok(app.store.currentSeq() >= Number(before.cursor), 'sequence survives the purge and a restart');
    const { jobId: j2 } = await (await app.capture()).json();
    await app.waitFor(j2);
    const after = await app.events(before.cursor);
    assert.deepEqual(after.events.map((e) => e.jobId), [j2], 'an old cursor still sees new work');
    await app.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('leftover image directories without a job are removed at start', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'g2-orphan-'));
  try {
    const orphan = path.join(dataDir, 'images', 'not-a-job');
    await mkdir(orphan, { recursive: true });
    await writeFile(path.join(orphan, 'x.jpg'), 'x');
    const app = await startApp({ dataDir });
    assert.equal(existsSync(orphan), false);
    await app.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
