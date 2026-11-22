import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AssistantDeps } from '../src/core/assistant.ts';
import { BridgeLane } from '../src/core/bridgeLane.ts';
import { HostLink, type HostBridge, type HostStatus } from '../src/hostLink.ts';
import type { HostEventLike } from '../src/hostEvents.ts';
import { shake, still, tilt } from '../src/core/synth.ts';
import { Rig } from './helpers.ts';

const status = (connected: boolean, isWearing?: boolean, isInCase?: boolean): HostStatus => ({ isConnected: () => connected, isWearing, isInCase, connectType: connected ? 'connected' : 'disconnected' });
const flushTasks = () => new Promise<void>((r) => setTimeout(r, 0));

class FakeBridge implements HostBridge {
  events = new Set<(e: HostEventLike) => void>();
  statuses = new Set<(s: HostStatus) => void>();
  imuCalls: boolean[] = [];
  infoReads = 0;
  info: HostStatus | undefined = status(true, true);
  infoGate: Promise<void> = Promise.resolve();
  imuOk = true;

  onEvenHubEvent(cb: (e: HostEventLike) => void): () => void { this.events.add(cb); return () => this.events.delete(cb); }
  onDeviceStatusChanged(cb: (s: HostStatus) => void): () => void { this.statuses.add(cb); return () => this.statuses.delete(cb); }
  async getDeviceInfo(): Promise<{ status?: HostStatus } | null> {
    this.infoReads++;
    const info = this.info;
    await this.infoGate;
    return { status: info };
  }
  async imuControl(on: boolean): Promise<boolean> { this.imuCalls.push(on); return this.imuOk; }
  emit(e: HostEventLike): void { for (const cb of this.events) cb(e); }
  status(s: HostStatus): void {
    this.info = s;
    for (const cb of this.statuses) cb(s);
  }
}

async function setup(overrides: Partial<AssistantDeps> = {}): Promise<{ r: Rig; b: FakeBridge; link: HostLink; closed: { n: number } }> {
  const r = await new Rig(undefined, overrides).start();
  const b = new FakeBridge();
  const closed = { n: 0 };
  const link = new HostLink({ bridge: b, assistant: r.a, lane: new BridgeLane(50), now: () => r.time, onClosed: () => closed.n++, log: () => {} });
  await link.start(true);
  return { r, b, link, closed };
}

test('start subscribes, reads wear and enables motion when gestures need it', async () => {
  const { r, b } = await setup();
  assert.equal(b.events.size, 1);
  assert.equal(b.statuses.size, 1);
  assert.deepEqual(b.imuCalls, [true]);
  assert.equal(r.a.snapshot().wear, 'worn');
});

test('without a page the IMU is not started', async () => {
  const r = await new Rig().start();
  const b = new FakeBridge();
  await new HostLink({ bridge: b, assistant: r.a, lane: new BridgeLane(50), now: () => r.time, log: () => {} }).start(false);
  assert.deepEqual(b.imuCalls, []);
});

test('a reconnect turns the IMU on again, because the glasses may have restarted', async () => {
  const { b } = await setup();
  b.status(status(false));
  b.status(status(true, true));
  await flushTasks();
  assert.deepEqual(b.imuCalls, [true, true]);
});

test('a lost sensor is restarted, but not on every tick', async () => {
  const { r, b, link } = await setup();
  r.wait(10_001);
  await r.a.tick();
  assert.equal(r.a.snapshot().sensorStale, true);
  link.tick();
  link.tick();
  await flushTasks();
  assert.deepEqual(b.imuCalls, [true, true]);
  r.wait(10_001);
  link.tick();
  await flushTasks();
  assert.deepEqual(b.imuCalls, [true, true, true]);
});

test('coming back to the foreground rereads wear, since events may have been missed', async () => {
  const { r, b } = await setup();
  assert.equal(r.a.snapshot().wear, 'worn');
  b.emit({ sysEvent: { eventType: 3 } });
  b.emit({ sysEvent: { eventType: 3 } });
  assert.equal(r.a.state, 'VISIBLE');
  const mark = r.markPlans();
  b.info = status(true, false);
  b.emit({ sysEvent: { eventType: 4 } });
  await flushTasks();
  assert.equal(r.a.state, 'REMOVED');
  assert.ok(r.plansSince(mark).every((plan) => plan.kind === 'blank'), 'foreground never resends the old answer');
});

test('an old status reply cannot overwrite a newer status event', async () => {
  const { r, b } = await setup();
  let open!: () => void;
  b.infoGate = new Promise((res) => { open = res; });
  b.info = status(true, true);
  b.emit({ sysEvent: { eventType: 4 } }); // starts a status read
  await flushTasks();
  b.status(status(true, false)); // removed, while the read is on its way
  assert.equal(r.a.state, 'REMOVED');
  open();
  await flushTasks();
  assert.equal(r.a.state, 'REMOVED');
  assert.equal(r.a.snapshot().wear, 'removed');
});

test('glasses in the case count as removed', async () => {
  const { r, b } = await setup();
  b.status(status(true, true, true));
  assert.equal(r.a.state, 'REMOVED');
});

test('a system exit hides, stops the IMU, unsubscribes and closes', async () => {
  const { r, b, closed } = await setup();
  r.wait(2000);
  r.play(still(1500));
  r.play(shake());
  assert.equal(r.a.state, 'VISIBLE');
  b.emit({ sysEvent: { eventType: 7 } });
  await flushTasks();
  assert.equal(r.a.state, 'HIDDEN');
  assert.equal(r.lit(), false);
  assert.equal(b.imuCalls.at(-1), false);
  assert.equal(b.events.size, 0);
  assert.equal(b.statuses.size, 0);
  assert.equal(closed.n, 1);
});

test('an abnormal exit hides and stops the IMU, but stays subscribed so recovery still works', async () => {
  const { r, b, closed } = await setup();
  r.wait(2000);
  r.play(still(1500));
  r.play(shake());
  b.emit({ sysEvent: { eventType: 6 } });
  await flushTasks();
  assert.equal(r.a.state, 'HIDDEN');
  assert.equal(b.imuCalls.at(-1), false);
  assert.equal(b.events.size, 1);
  assert.equal(closed.n, 0);
  b.emit({ sysEvent: { eventType: 4 } });
  await flushTasks();
  assert.equal(b.imuCalls.at(-1), true);
  assert.equal(r.a.state, 'HIDDEN');
});

test('dispose is safe to call twice and leaves no listeners', async () => {
  const { b, link, closed } = await setup();
  link.dispose();
  link.dispose();
  assert.equal(b.events.size + b.statuses.size, 0);
  assert.equal(closed.n, 1);
});

test('a rejected or hung host call does not break the link', async () => {
  const { r, b } = await setup();
  b.imuControl = () => Promise.reject(new Error('down'));
  b.getDeviceInfo = () => new Promise(() => {});
  b.emit({ sysEvent: { eventType: 4 } });
  await new Promise((res) => setTimeout(res, 70));
  b.emit({ sysEvent: {} });
  assert.equal(r.a.state, 'HIDDEN');
});

test('taking the glasses off switches the IMU off, putting them on switches it back on', async () => {
  const { r, b } = await setup();
  b.status(status(true, false));
  await flushTasks();
  assert.equal(r.a.snapshot().wear, 'removed');
  assert.deepEqual(b.imuCalls, [true, false]);
  b.status(status(true, true));
  await flushTasks();
  assert.equal(r.a.snapshot().wear, 'worn');
  assert.deepEqual(b.imuCalls, [true, false, true]);
});

test('quick remove and re-wear cycles coalesce motion commands behind a busy bridge', async () => {
  const r = await new Rig().start();
  const b = new FakeBridge();
  const lane = new BridgeLane(50);
  const link = new HostLink({ bridge: b, assistant: r.a, lane, now: () => r.time, log: () => {} });
  await link.start(true);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const busy = lane.run(() => gate);
  for (let i = 0; i < 2; i++) {
    b.status(status(true, false));
    b.status(status(true, true));
  }
  release();
  await busy;
  await flushTasks();
  assert.deepEqual(b.imuCalls, [true, true]);
  assert.equal(r.a.state, 'HIDDEN');
});

test('in the case counts as off the head', async () => {
  const { b } = await setup();
  b.status(status(true, true, true));
  await flushTasks();
  assert.deepEqual(b.imuCalls, [true, false]);
});

test('while asleep, silence is not a lost sensor and the tick does not restart the IMU', async () => {
  const { r, b, link } = await setup();
  b.status(status(true, false));
  await flushTasks();
  r.time += 60_000;
  await r.a.tick();
  link.tick();
  await flushTasks();
  assert.equal(r.a.snapshot().sensorStale, false);
  assert.deepEqual(b.imuCalls, [true, false]);
});

test('a reconnect while off the head keeps the IMU off', async () => {
  const { b } = await setup();
  b.status(status(true, false));
  b.status(status(false));
  b.status(status(true, false));
  await flushTasks();
  assert.deepEqual(b.imuCalls, [true, false]);
});

test('waking up: the lens stays blank until a shake, then the answer is back', async () => {
  const { r, b } = await setup();
  r.play(still(1500));
  r.play(shake());
  assert.equal(r.a.state, 'VISIBLE');
  b.status(status(true, false));
  await flushTasks();
  assert.equal(r.a.state, 'REMOVED');
  b.status(status(true, true));
  await flushTasks();
  assert.equal(r.a.state, 'HIDDEN', 'putting them on never shows anything by itself');
  r.play(still(2500));
  r.play(shake());
  assert.equal(r.a.state, 'VISIBLE');
});

test('the default waits for exactly three fresh taps after wear and still scrolls by swipe', async () => {
  const { r, b, link } = await setup({ initialSettings: undefined });
  const double = () => b.emit({ sysEvent: { eventType: 3 } });
  const tap = () => b.emit({ sysEvent: {} });
  const swipe = () => b.emit({ textEvent: { eventType: 2 } });
  const answer = { id: 'demo', short: 'Sample answer', details: 'Paragraph of sample text.\n'.repeat(24) };
  r.a.aiResult(answer);
  double(); tap();
  assert.equal(r.a.state, 'RESULT_READY');
  swipe();
  const line = r.a.snapshot().topLine;
  assert.ok(line > 0);
  const mark = r.markPlans();

  b.status(status(true, false));
  assert.equal(r.a.state, 'REMOVED');
  assert.equal(r.lit(), false);
  double(); double();
  b.status(status(true, true));
  assert.equal(r.a.state, 'HIDDEN');
  assert.equal(r.forced.at(-1), true);
  r.play(still(2000));
  r.play(shake());
  swipe();
  tap(); tap();
  assert.equal(r.a.state, 'HIDDEN');
  assert.ok(r.plansSince(mark).every((plan) => plan.kind === 'blank'));
  tap();
  assert.equal(r.a.state, 'VISIBLE');
  assert.equal(r.a.snapshot().topLine, line);
  r.play(still(1300));
  r.play(tilt(24));
  assert.equal(r.a.snapshot().topLine, line, 'the default is manual scrolling');
  r.wait(10_000);
  await r.a.tick();
  link.tick();
  await flushTasks();
  assert.equal(r.a.snapshot().sensorStale, false);
  assert.deepEqual(b.imuCalls, [], 'touch and wear gating do not wait for motion control');
});

for (const [side, source, otherSource] of [['left', 3, 1], ['right', 1, 3]] as const) {
  test(`${side}-only unlock requires fresh taps from the selected temple after every removal`, async () => {
    const { r, b } = await setup({ initialSettings: { unlockTouchpad: side, tiltEnabled: false } });
    const double = (eventSource = source as number) => b.emit({ sysEvent: { eventType: 3, eventSource } });
    const tap = () => b.emit({ sysEvent: { eventSource: source } });
    double(); tap();
    assert.equal(r.a.state, 'VISIBLE');

    for (let cycle = 0; cycle < 6; cycle++) {
      b.status(status(true, false));
      const mark = r.markPlans();
      assert.equal(r.a.state, 'REMOVED');
      assert.equal(r.lit(), false);
      double(); double();
      b.status(status(true, true));
      assert.equal(r.a.state, 'HIDDEN');
      assert.equal(r.a.snapshot().tapCount, 0);

      for (const rejected of [otherSource, 0, 2]) {
        tap(); tap();
        assert.equal(r.a.snapshot().tapCount, 2);
        double(rejected); double(rejected);
        assert.equal(r.a.snapshot().tapCount, 0);
        assert.equal(r.a.state, 'HIDDEN');
      }
      assert.ok(r.plansSince(mark).every((p) => p.kind === 'blank'));
      double();
      assert.equal(r.a.snapshot().lastTap, side);
      assert.equal(r.a.snapshot().tapCount, 2);
      r.wait(150);
      tap();
      assert.equal(r.a.state, 'VISIBLE');
    }
  });
}

test('changing sides and manually locking both reset the touch sequence', async () => {
  const { r, b } = await setup({ initialSettings: undefined });
  const double = (eventSource: number) => b.emit({ sysEvent: { eventType: 3, eventSource } });
  double(1);
  assert.equal(r.a.snapshot().tapCount, 2);
  await r.a.updateSettings({ unlockTouchpad: 'left' });
  assert.equal(r.a.snapshot().tapCount, 0);
  double(3);
  assert.equal(r.a.state, 'HIDDEN');
  double(3);
  assert.equal(r.a.state, 'VISIBLE');
  r.a.lockDisplay();
  assert.equal(r.a.state, 'HIDDEN');
  assert.equal(r.lit(), false);
  double(3);
  r.wait(r.a.settings.recoveryWindowMs + 1);
  assert.equal(r.a.snapshot().tapCount, 0);
  double(3);
  assert.equal(r.a.state, 'HIDDEN');
  double(3);
  assert.equal(r.a.state, 'VISIBLE');
});

test('locked wear snapshots refresh missed wear reports without reopening the display', async () => {
  const { r, b, link } = await setup({ initialSettings: undefined });
  const double = () => b.emit({ sysEvent: { eventType: 3, eventSource: 1 } });
  double(); double();
  assert.equal(r.a.state, 'VISIBLE');
  r.a.lockDisplay();
  b.info = status(true, false);
  r.wait(2000);
  link.tick(); link.tick();
  await flushTasks();
  assert.equal(b.infoReads, 2, 'only one snapshot while the check is pending');
  assert.equal(r.a.state, 'REMOVED');
  assert.equal(r.lit(), false);
  double(); double();

  b.info = status(true, true);
  r.wait(2000);
  link.tick();
  await flushTasks();
  assert.equal(r.a.state, 'HIDDEN');
  double();
  assert.equal(r.a.state, 'HIDDEN');
  double();
  assert.equal(r.a.state, 'VISIBLE');
});

test('a fresh worn notification locks even when the host omitted the previous removal', async () => {
  const { r, b } = await setup({ initialSettings: undefined });
  const double = () => b.emit({ sysEvent: { eventType: 3, eventSource: 1 } });
  for (let cycle = 0; cycle < 6; cycle++) {
    double(); double();
    assert.equal(r.a.state, 'VISIBLE');
    const mark = r.markPlans();
    b.status(status(true, true, false));
    assert.equal(r.a.state, 'HIDDEN');
    assert.equal(r.a.snapshot().tapCount, 0);
    assert.equal(r.forced.at(-1), true, 'clear the native page even if the app thought it was blank');
    assert.ok(r.plansSince(mark).every((p) => p.kind === 'blank'));
    double();
    b.status(status(true, true, false));
    double();
    assert.equal(r.a.state, 'HIDDEN', 'a partial pattern from before a status notification expires');
    r.a.lockDisplay();
  }
});

test('an unlocked display keeps reading wear when the host sends no change notification', async () => {
  const { r, b, link } = await setup({ initialSettings: undefined });
  const tap = () => b.emit({ sysEvent: { eventSource: 1 } });
  for (let cycle = 0; cycle < 6; cycle++) {
    tap(); tap();
    assert.equal(r.a.state, 'HIDDEN');
    tap();
    assert.equal(r.a.state, 'VISIBLE');

    // Reproduce the real host failure: the cached device info changes but no
    // onDeviceStatusChanged callback reaches the plug-in.
    b.info = status(true, false, false);
    r.wait(250);
    link.tick();
    await flushTasks();
    assert.equal(r.a.state, 'REMOVED');
    assert.equal(r.lit(), false);

    tap(); tap();
    b.info = status(true, true, false);
    r.wait(250);
    link.tick();
    await flushTasks();
    assert.equal(r.a.state, 'HIDDEN');
    assert.equal(r.a.snapshot().tapCount, 0);
    assert.equal(r.lit(), false);
  }
  assert.equal(b.infoReads, 13, 'initial read plus off/on reads for every cycle');
  assert.deepEqual(b.imuCalls, []);
});

test('a foreground enter without a preceding exit blanks immediately while status is pending', async () => {
  const { r, b } = await setup({ initialSettings: undefined });
  const double = () => b.emit({ sysEvent: { eventType: 3, eventSource: 1 } });
  double(); double();
  assert.equal(r.a.state, 'VISIBLE');
  let release!: () => void;
  b.infoGate = new Promise((resolve) => { release = resolve; });
  const mark = r.markPlans();
  b.emit({ sysEvent: { eventType: 4 } });
  assert.equal(r.a.state, 'HIDDEN');
  double(); double();
  assert.equal(r.a.state, 'HIDDEN');
  release();
  await flushTasks();
  assert.ok(r.plansSince(mark).every((p) => p.kind === 'blank'));
  double();
  assert.equal(r.a.state, 'HIDDEN');
  double();
  assert.equal(r.a.state, 'VISIBLE');
});

test('the sensor check uses bridge reports and keeps all six rounds locked', async () => {
  const { r, b, link } = await setup({ initialSettings: undefined });
  b.info = status(true, true, false);
  link.startWearCheck();
  await flushTasks();
  assert.equal(link.wearCheck.snapshot(r.time).phase, 'remove');
  for (let cycle = 0; cycle < 6; cycle++) {
    b.emit({ sysEvent: { eventType: 3, eventSource: 1 } });
    b.emit({ sysEvent: { eventType: 3, eventSource: 1 } });
    assert.equal(r.a.state, 'HIDDEN');
    r.wait(100);
    b.status(status(true, false, false));
    assert.equal(r.a.state, 'REMOVED');
    assert.equal(link.wearCheck.snapshot(r.time).phase, 'wear');
    r.wait(100);
    b.status(status(true, true, false));
    assert.equal(r.a.state, 'HIDDEN');
    assert.equal(r.lit(), false);
  }
  assert.equal(link.wearCheck.snapshot(r.time).phase, 'complete');
  assert.equal(link.wearCheck.snapshot(r.time).completed, 6);
  b.emit({ sysEvent: { eventType: 3, eventSource: 1 } });
  assert.equal(r.a.state, 'HIDDEN');
  b.emit({ sysEvent: { eventType: 3, eventSource: 1 } });
  assert.equal(r.a.state, 'VISIBLE');
});

test('a pending wear snapshot cannot undo a removal or reopen off-head input', async () => {
  const { r, b, link } = await setup({ initialSettings: undefined });
  let release!: () => void;
  b.infoGate = new Promise((resolve) => { release = resolve; });
  r.wait(2000);
  link.tick();
  assert.equal(b.infoReads, 2);
  b.status(status(true, false));
  release();
  await flushTasks();
  b.emit({ sysEvent: { eventType: 3, eventSource: 1 } });
  b.emit({ sysEvent: { eventType: 3, eventSource: 1 } });
  assert.equal(r.a.state, 'REMOVED');
  assert.equal(r.lit(), false);
});

test('recording motion starts the sensor in touch mode, and stopping the recording idles it', async () => {
  const { r, b, link } = await setup({ initialSettings: undefined });
  r.a.logger.start();
  link.syncMotion();
  await flushTasks();
  b.emit({ sysEvent: { eventType: 8, imuData: { x: 1, y: 2, z: 3 } } });
  assert.equal(r.a.logger.summary().samples, 1);
  assert.deepEqual(b.imuCalls, [true]);
  r.a.logger.stop();
  link.syncMotion();
  await flushTasks();
  assert.deepEqual(b.imuCalls, [true, false]);
});

test('after the preview leaves the foreground, a missed removal cannot restore the answer', async () => {
  const { r, b } = await setup({ initialSettings: undefined });
  const double = () => b.emit({ sysEvent: { eventType: 3 } });
  double(); double();
  assert.equal(r.a.state, 'VISIBLE');
  const mark = r.markPlans();
  b.emit({ sysEvent: { eventType: 5 } });
  assert.equal(r.a.state, 'HIDDEN');
  double(); double();
  let thenRead!: () => void;
  b.infoGate = new Promise((resolve) => { thenRead = resolve; });
  b.emit({ sysEvent: { eventType: 4 } }); // host still reports worn, with no off/on events
  double(); double();
  assert.equal(r.a.state, 'HIDDEN');
  thenRead();
  await flushTasks();
  assert.ok(r.plansSince(mark).every((plan) => plan.kind === 'blank'));
  double();
  assert.equal(r.a.state, 'HIDDEN');
  double();
  assert.equal(r.a.state, 'VISIBLE');
});

test('shake-only reopening ignores a completed touch sequence and waits for a new shake', async () => {
  const { r, b } = await setup({ initialSettings: undefined });
  await r.a.updateSettings({ unlockGesture: 'shake' });
  r.play(still(2500));
  r.play(shake());
  assert.equal(r.a.state, 'VISIBLE');
  b.status(status(true, false));
  b.status(status(true, true));
  for (let i = 0; i < 6; i++) b.emit({ sysEvent: {} });
  assert.equal(r.a.state, 'HIDDEN');
  r.play(still(2500));
  r.play(shake());
  assert.equal(r.a.state, 'VISIBLE');
});

test('trusting the wear sensor off ends the sleep on the next tick', async () => {
  const { r, b, link } = await setup();
  b.status(status(true, false));
  await flushTasks();
  await r.a.updateSettings({ trustWearSensor: false });
  link.tick();
  await flushTasks();
  assert.deepEqual(b.imuCalls, [true, false, true]);
});

test('calibration wakes the IMU even when the wear report says removed', async () => {
  const { r, b, link } = await setup();
  b.status(status(true, false));
  await flushTasks();
  r.a.startCalibration();
  link.tick();
  await flushTasks();
  assert.deepEqual(b.imuCalls, [true, false, true]);
  await r.a.finishCalibration(false);
  link.tick();
  await flushTasks();
  assert.deepEqual(b.imuCalls, [true, false, true, false]);
});

test('a disconnect while asleep does not start the IMU over a dead link', async () => {
  const { b, link } = await setup();
  b.status(status(true, false));
  b.status(status(false));
  link.tick();
  await flushTasks();
  assert.deepEqual(b.imuCalls, [true, false]);
});

test('a lens page that only works on retry starts the IMU then', async () => {
  const r = await new Rig().start();
  const b = new FakeBridge();
  const link = new HostLink({ bridge: b, assistant: r.a, lane: new BridgeLane(50), now: () => r.time, log: () => {} });
  await link.start(false);
  assert.deepEqual(b.imuCalls, []);
  link.setPageReady();
  await flushTasks();
  assert.deepEqual(b.imuCalls, [true]);
  link.setPageReady();
  await flushTasks();
  assert.deepEqual(b.imuCalls, [true], 'only once');
});

test('a late page while off the head keeps the IMU off', async () => {
  const r = await new Rig().start();
  const b = new FakeBridge();
  b.info = status(true, false);
  const link = new HostLink({ bridge: b, assistant: r.a, lane: new BridgeLane(50), now: () => r.time, log: () => {} });
  await link.start(false);
  link.setPageReady();
  await flushTasks();
  assert.deepEqual(b.imuCalls, []);
});

test('without the lens page, nothing starts the IMU: not the tick, a foreground or a reconnect', async () => {
  const r = await new Rig().start();
  const b = new FakeBridge();
  const link = new HostLink({ bridge: b, assistant: r.a, lane: new BridgeLane(50), now: () => r.time, log: () => {} });
  await link.start(false);
  r.time += 20_000;
  await r.a.tick();
  link.tick();
  b.emit({ sysEvent: { eventType: 4 } } as HostEventLike);
  b.status(status(false));
  b.status(status(true, true));
  assert.equal(await link.startImu(), false);
  await flushTasks();
  assert.deepEqual(b.imuCalls, []);
});
