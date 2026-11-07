import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeLane } from '../src/core/bridgeLane.ts';
import { HostLink, type HostBridge, type HostStatus } from '../src/hostLink.ts';
import type { HostEventLike } from '../src/hostEvents.ts';
import { shake, still } from '../src/core/synth.ts';
import { Rig } from './helpers.ts';

const status = (connected: boolean, isWearing?: boolean, isInCase?: boolean): HostStatus => ({ isConnected: () => connected, isWearing, isInCase, connectType: connected ? 'connected' : 'disconnected' });
const flushTasks = () => new Promise<void>((r) => setTimeout(r, 0));

class FakeBridge implements HostBridge {
  events = new Set<(e: HostEventLike) => void>();
  statuses = new Set<(s: HostStatus) => void>();
  imuCalls: boolean[] = [];
  info: HostStatus | undefined = status(true, true);
  infoGate: Promise<void> = Promise.resolve();
  imuOk = true;

  onEvenHubEvent(cb: (e: HostEventLike) => void): () => void { this.events.add(cb); return () => this.events.delete(cb); }
  onDeviceStatusChanged(cb: (s: HostStatus) => void): () => void { this.statuses.add(cb); return () => this.statuses.delete(cb); }
  async getDeviceInfo(): Promise<{ status?: HostStatus } | null> { const info = this.info; await this.infoGate; return { status: info }; }
  async imuControl(on: boolean): Promise<boolean> { this.imuCalls.push(on); return this.imuOk; }
  emit(e: HostEventLike): void { for (const cb of this.events) cb(e); }
  status(s: HostStatus): void { for (const cb of this.statuses) cb(s); }
}

async function setup(): Promise<{ r: Rig; b: FakeBridge; link: HostLink; closed: { n: number } }> {
  const r = await new Rig().start();
  const b = new FakeBridge();
  const closed = { n: 0 };
  const link = new HostLink({ bridge: b, assistant: r.a, lane: new BridgeLane(50), now: () => r.time, onClosed: () => closed.n++, log: () => {} });
  await link.start(true);
  return { r, b, link, closed };
}

test('start subscribes, turns the IMU on and reads the first status', async () => {
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
  b.info = status(true, false);
  b.emit({ sysEvent: { eventType: 4 } });
  await flushTasks();
  assert.equal(r.a.state, 'REMOVED');
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
