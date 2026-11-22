import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/core/settings.ts';
import { MemoryStore, SESSION_KEY, SETTINGS_KEY, LEGACY_SETTINGS_KEY, SessionWriter, loadSession, loadSettings, saveSettings, type Session } from '../src/core/storage.ts';

const session = (topLine: number): Session => ({ docId: 'a', short: 's', details: 'd', topLine, unseen: false });

test('settings round trip', async () => {
  const store = new MemoryStore();
  await saveSettings(store, sanitizeSettings({ tiltUpDeg: 21, pitchAxis: 'z', yawAxis: 'x' }));
  const s = await loadSettings(store);
  assert.equal(s.tiltUpDeg, 21);
  assert.equal(s.pitchAxis, 'z');
});

test('corrupt or missing settings give the defaults', async () => {
  const store = new MemoryStore();
  store.data.set(SETTINGS_KEY, '{not json');
  assert.deepEqual(await loadSettings(store), sanitizeSettings({ tiltEnabled: false }));
  assert.deepEqual(await loadSettings(new MemoryStore()), sanitizeSettings({ tiltEnabled: false }));
});

test('saved calibration carries over to the new controls, and explicit choices persist', async () => {
  const store = new MemoryStore();
  store.data.set(LEGACY_SETTINGS_KEY, JSON.stringify({ unlockGesture: 'either', recoveryPresses: 4,
    tiltEnabled: true, trustWearSensor: false, pitchAxis: 'z', tiltDownDeg: 20.6 }));
  const migrated = await loadSettings(store);
  assert.equal(migrated.unlockGesture, 'touch');
  assert.equal(migrated.recoveryPresses, 3);
  assert.equal(migrated.unlockTouchpad, 'either');
  assert.equal(migrated.tiltEnabled, false);
  assert.equal(migrated.trustWearSensor, true);
  assert.equal(migrated.pitchAxis, 'z');
  assert.equal(migrated.tiltDownDeg, 20.6);
  await saveSettings(store, { ...migrated, unlockGesture: 'shake', unlockTouchpad: 'right', tiltEnabled: true, trustWearSensor: false });
  const saved = await loadSettings(store);
  assert.equal(saved.unlockGesture, 'shake');
  assert.equal(saved.unlockTouchpad, 'right');
  assert.equal(saved.tiltEnabled, true);
  assert.equal(saved.trustWearSensor, false);
});

test('new installations use three taps and saved current choices survive older settings', async () => {
  const store = new MemoryStore();
  assert.equal((await loadSettings(store)).recoveryPresses, 3);
  store.data.set(LEGACY_SETTINGS_KEY, JSON.stringify({ unlockGesture: 'touch', recoveryPresses: 4 }));
  await saveSettings(store, sanitizeSettings({ recoveryPresses: 5, unlockTouchpad: 'left' }));
  const saved = await loadSettings(store);
  assert.equal(saved.recoveryPresses, 5);
  assert.equal(saved.unlockTouchpad, 'left');
});

test('unreadable current settings recover old calibration and the three-tap lock', async () => {
  const store = new MemoryStore();
  store.data.set(SETTINGS_KEY, '{broken');
  store.data.set(LEGACY_SETTINGS_KEY, JSON.stringify({ recoveryPresses: 4, pitchAxis: 'z', unlockTouchpad: 'right' }));
  const migrated = await loadSettings(store);
  assert.equal(migrated.recoveryPresses, 3);
  assert.equal(migrated.pitchAxis, 'z');
  assert.equal(migrated.unlockTouchpad, 'right');
  assert.equal(migrated.trustWearSensor, true);
});

test('settings are clamped, typed and kept consistent', () => {
  const s = sanitizeSettings({
    smoothingMs: -5, scrollLinesPerSec: 9999, tiltUpDeg: 'high', imuMode: 'nonsense',
    pitchAxis: 'y', yawAxis: 'y', deadZoneDeg: 30, imuPace: 340, pitchSign: 3,
  });
  assert.equal(s.smoothingMs, 0);
  assert.equal(s.scrollLinesPerSec, 30);
  assert.equal(s.imuMode, 'orientation');
  assert.notEqual(s.pitchAxis, s.yawAxis);
  assert.ok(s.tiltUpDeg > s.deadZoneDeg + s.tiltHysteresisDeg);
  assert.ok(s.tiltMaxDeg > s.tiltUpDeg);
  assert.equal(s.imuPace, 300);
  assert.equal(s.pitchSign, DEFAULT_SETTINGS.pitchSign);
});

test('a bad session is ignored', async () => {
  const store = new MemoryStore();
  store.data.set(SESSION_KEY, '{"docId":1}');
  assert.equal(await loadSession(store), null);
  store.data.set(SESSION_KEY, 'broken');
  assert.equal(await loadSession(store), null);
});

test('session writes are coalesced to the latest value', async () => {
  const store = new MemoryStore();
  let writes = 0;
  const set = store.set.bind(store);
  store.set = (k, v) => { writes++; return set(k, v); };
  const w = new SessionWriter(store, 1000);
  w.queue(session(1));
  await w.tick(5000);
  for (let i = 2; i < 50; i++) { w.queue(session(i)); await w.tick(5100); }
  assert.equal(writes, 1, 'held back by the interval');
  await w.tick(6100);
  assert.equal(writes, 2);
  assert.equal((await loadSession(store))?.topLine, 49);
});

test('a failed write is kept for the next try', async () => {
  const store = new MemoryStore();
  let fail = true;
  const set = store.set.bind(store);
  store.set = async (k, v) => (fail ? false : set(k, v));
  const w = new SessionWriter(store, 0);
  w.queue(session(3));
  await w.tick(1);
  assert.equal(await loadSession(store), null);
  fail = false;
  await w.tick(2);
  assert.equal((await loadSession(store))?.topLine, 3);
});

test('the Visible or Hidden mode is never written to storage', async () => {
  const store = new MemoryStore();
  const w = new SessionWriter(store, 0);
  w.queue(session(1));
  await w.flush(1);
  assert.doesNotMatch(store.data.get(SESSION_KEY)!, /VISIBLE|HIDDEN|mode/);
});
