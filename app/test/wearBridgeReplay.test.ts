import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Assistant } from '../src/core/assistant.ts';
import { BridgeLane } from '../src/core/bridgeLane.ts';
import { BLANK_TEXT, RenderQueue } from '../src/core/renderQueue.ts';
import { MemoryStore } from '../src/core/storage.ts';
import { HostLink } from '../src/hostLink.ts';

test('recorded host message shapes lock through the installed SDK and display bridge', async (t) => {
  const events = new EventTarget();
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.window = globalThis;
  globals.document = { readyState: 'complete', addEventListener() {}, createElement() { return {}; } };
  globals.addEventListener = events.addEventListener.bind(events);
  globals.removeEventListener = events.removeEventListener.bind(events);
  globals.dispatchEvent = events.dispatchEvent.bind(events);
  t.mock.method(console, 'log', () => {});
  const sdk = await import('@evenrealities/even_hub_sdk');
  const { GlassesPort } = await import('../src/glasses.ts');
  const bridge = sdk.EvenAppBridge.getInstance();
  const status = { sn: 'replay', connectType: 'connected', isWearing: true, isInCase: false };
  let now = 0;
  let lens = 'content left from an earlier run';

  // Stub only the phone/native boundary. Event parsing, SDK serialization,
  // HostLink, Assistant, RenderQueue and GlassesPort run their real code.
  t.mock.method(bridge, 'callEvenApp', async (method: string, params?: Record<string, unknown>) => {
    if (method === 'getGlassesInfo') return { model: 'g2', sn: 'replay', status: { ...status } };
    if (method === 'createStartUpPageContainer' || method === 'rebuildPageContainer') {
      const textObject = params?.textObject as { content: string }[];
      lens = textObject[0].content;
      return method === 'createStartUpPageContainer' ? 0 : true;
    }
    if (method === 'textContainerUpgrade') { lens = params?.content as string; return true; }
    assert.fail(`unexpected native method ${method}`);
  });
  const lane = new BridgeLane(1000);
  const port = new GlassesPort(bridge, lane);
  assert.equal(await port.init(), true);
  assert.equal(lens, BLANK_TEXT);
  const queue = new RenderQueue(port, 1000);
  const assistant = await Assistant.create({
    store: new MemoryStore(), now: () => now,
    onPlan: (plan, force) => { void queue.show(plan, force); },
  });
  await assistant.updateSettings({ unlockGesture: 'touch', unlockTouchpad: 'right', trustWearSensor: true, motionLock: false, recoveryPresses: 3, recoveryGapMs: 0, recoveryWindowMs: 3000, doublePressLocks: false });
  const link = new HostLink({ bridge, assistant, lane, now: () => now, log: () => {} });
  t.after(() => link.dispose());
  await link.start(true);
  const receive = globals._listenEvenAppMessage as (message: unknown) => void;
  assert.equal(typeof receive, 'function');
  const emit = (method: string, data: unknown) => receive({ type: 'listen_even_app_data', method, data });
  const doubleTap = () => emit('evenHubEvent', { type: 'sysEvent', jsonData: { eventType: 3, eventSource: 1 } });
  const tap = () => emit('evenHubEvent', { type: 'sysEvent', jsonData: { eventSource: 1 } });
  const drain = () => queue.show(assistant.plan());

  for (let cycle = 0; cycle < 6; cycle++) {
    doubleTap();
    assert.equal(assistant.state, 'HIDDEN');
    tap();
    await drain();
    assert.equal(assistant.state, 'VISIBLE');
    assert.notEqual(lens, BLANK_TEXT);

    // A fresh true notification, with no preceding false: the regression.
    emit('deviceStatusChanged', { ...status });
    await drain();
    assert.equal(assistant.state, 'HIDDEN');
    assert.equal(lens, BLANK_TEXT);
    doubleTap();
    await drain();
    assert.equal(lens, BLANK_TEXT);
    tap();
    await drain();
    assert.notEqual(lens, BLANK_TEXT);

    // The host can also omit the matching foreground-exit event.
    emit('evenHubEvent', { type: 'sysEvent', jsonData: { eventType: 4 } });
    assert.equal(assistant.state, 'HIDDEN');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await drain();
    assert.equal(lens, BLANK_TEXT);
    assert.equal(assistant.state, 'HIDDEN');
    now += 1000;
  }
});
