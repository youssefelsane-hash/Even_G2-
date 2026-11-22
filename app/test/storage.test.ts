import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/core/settings.ts';
import { MemoryStore, SESSION_KEY, SETTINGS_KEY, PREVIOUS_SETTINGS_KEY, LEGACY_SETTINGS_KEY, WEAR_POLICY, SessionWriter, loadSession, loadSettings, saveSettings, type Session } from '../src/core/storage.ts';

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
  assert.deepEqual(await loadSettings(store), sanitizeSettings({ ...WEAR_POLICY, tiltEnabled: false }));
  assert.deepEqual(await loadSettings(new MemoryStore()), sanitizeSettings({ ...WEAR_POLICY, tiltEnabled: false }));
});

test('saved calibration carries over to the new controls, and explicit choices persist', async () => {
  const store = new MemoryStore();
  store.data.set(LEGACY_SETTINGS_KEY, JSON.stringify({ unlockGesture: 'either', recoveryPresses: 4,
    tiltEnabled: true, trustWearSensor: false, pitchAxis: 'z', tiltDownDeg: 20.6 }));
  const migrated = await loadSettings(store);
  assert.equal(migrated.unlockGesture, 'touch');
  assert.equal(migrated.recoveryPresses, 4);
  assert.equal(migrated.unlockTouchpad, 'right');
  assert.equal(migrated.tiltEnabled, false);
  assert.equal(migrated.trustWearSensor, false);
  assert.equal(migrated.motionLock, false);
  assert.equal(migrated.doublePressLocks, true);
  assert.equal(migrated.recoveryGapMs, 1500);
  assert.equal(migrated.pitchAxis, 'z');
  assert.equal(migrated.tiltDownDeg, 20.6);
  await saveSettings(store, { ...migrated, unlockGesture: 'shake', unlockTouchpad: 'left', tiltEnabled: true, trustWearSensor: true, motionLock: false });
  const saved = await loadSettings(store);
  assert.equal(saved.unlockGesture, 'shake');
  assert.equal(saved.unlockTouchpad, 'left');
  assert.equal(saved.tiltEnabled, true);
  assert.equal(saved.trustWearSensor, true);
  assert.equal(saved.motionLock, false);
});

test('new installations use four right taps and the double-tap lock, and saved current choices survive older settings', async () => {
  const store = new MemoryStore();
  const fresh = await loadSettings(store);
  assert.equal(fresh.recoveryPresses, 4);
  assert.equal(fresh.unlockTouchpad, 'right');
  assert.equal(fresh.trustWearSensor, false);
  assert.equal(fresh.motionLock, false);
  assert.equal(fresh.doublePressLocks, true);
  store.data.set(LEGACY_SETTINGS_KEY, JSON.stringify({ unlockGesture: 'touch', recoveryPresses: 4 }));
  await saveSettings(store, sanitizeSettings({ recoveryPresses: 6, unlockTouchpad: 'left' }));
  const saved = await loadSettings(store);
  assert.equal(saved.recoveryPresses, 6);
  assert.equal(saved.unlockTouchpad, 'left');
});

test('version 2 settings keep calibration and tilt, and move to four right taps', async () => {
  const store = new MemoryStore();
  store.data.set(PREVIOUS_SETTINGS_KEY, JSON.stringify({ unlockGesture: 'touch', recoveryPresses: 3, unlockTouchpad: 'either',
    trustWearSensor: true, tiltEnabled: true, imuScale: 45, neutralPitch: 0.1 }));
  const migrated = await loadSettings(store);
  assert.equal(migrated.recoveryPresses, 4);
  assert.equal(migrated.unlockTouchpad, 'right');
  assert.equal(migrated.trustWearSensor, false);
  assert.equal(migrated.motionLock, false);
  assert.equal(migrated.doublePressLocks, true);
  assert.equal(migrated.recoveryGapMs, 1500);
  assert.equal(migrated.tiltEnabled, true);
  assert.equal(migrated.imuScale, 45);
  assert.equal(migrated.neutralPitch, 0.1);
});

test('version 3 settings (five taps, motion lock) move to four taps and keep calibration', async () => {
  const store = new MemoryStore();
  store.data.set('g2a.settings.v3', JSON.stringify({ unlockGesture: 'touch', recoveryPresses: 5, unlockTouchpad: 'right',
    trustWearSensor: false, motionLock: true, tiltEnabled: false, imuScale: 45 }));
  const migrated = await loadSettings(store);
  assert.equal(migrated.recoveryPresses, 4);
  assert.equal(migrated.motionLock, false);
  assert.equal(migrated.doublePressLocks, true);
  assert.equal(migrated.imuScale, 45);
});

test('unreadable current settings recover old calibration and the four-tap lock', async () => {
  const store = new MemoryStore();
  store.data.set(SETTINGS_KEY, '{broken');
  store.data.set(LEGACY_SETTINGS_KEY, JSON.stringify({ recoveryPresses: 4, pitchAxis: 'z', unlockTouchpad: 'right' }));
  const migrated = await loadSettings(store);
  assert.equal(migrated.recoveryPresses, 4);
  assert.equal(migrated.pitchAxis, 'z');
  assert.equal(migrated.unlockTouchpad, 'right');
  assert.equal(migrated.trustWearSensor, false);
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
