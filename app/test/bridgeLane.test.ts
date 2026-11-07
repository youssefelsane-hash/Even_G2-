import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeLane, BridgeStore } from '../src/core/bridgeLane.ts';
import { loadSettings } from '../src/core/storage.ts';
import { sanitizeSettings } from '../src/core/settings.ts';

const later = (ms = 1) => new Promise<void>((r) => setTimeout(r, ms));

test('bridge calls never overlap', async () => {
  const lane = new BridgeLane(100);
  let running = 0;
  let peak = 0;
  const job = async () => { running++; peak = Math.max(peak, running); await later(); running--; return true; };
  await Promise.all([lane.run(job), lane.run(job, true), lane.run(job), lane.run(job, true)]);
  assert.equal(peak, 1);
});

test('a display call goes ahead of waiting storage calls, in order among themselves', async () => {
  const lane = new BridgeLane(100);
  const order: string[] = [];
  const job = (name: string) => async () => { order.push(name); await later(); };
  await Promise.all([lane.run(job('storage1')), lane.run(job('storage2')), lane.run(job('text'), true), lane.run(job('blank'), true)]);
  assert.deepEqual(order, ['storage1', 'text', 'blank', 'storage2']);
});

test('a hung call rejects, and the calls behind it still run', async () => {
  const lane = new BridgeLane(10);
  const hung = lane.run(() => new Promise<boolean>(() => {}));
  const next = lane.run(async () => 'ran');
  await assert.rejects(hung);
  assert.equal(await next, 'ran');
});

test('a call that throws at once rejects and does not stop the lane', async () => {
  const lane = new BridgeLane(100);
  await assert.rejects(lane.run(() => { throw new Error('bad'); }));
  assert.equal(await lane.run(async () => 1), 1);
});

test('storage that hangs at boot falls back to the defaults instead of stalling the app', async () => {
  const hung = { getLocalStorage: () => new Promise<string>(() => {}), setLocalStorage: () => new Promise<boolean>(() => {}) };
  const store = new BridgeStore(hung, new BridgeLane(10));
  assert.deepEqual(await loadSettings(store), sanitizeSettings({}));
  await assert.rejects(store.set('k', 'v'));
});
