import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapHostEvent } from '../src/hostEvents.ts';

test('swipes come from textEvent', () => {
  assert.deepEqual(mapHostEvent({ textEvent: { eventType: 1 } }), { kind: 'touch', touch: 'swipeUp' });
  assert.deepEqual(mapHostEvent({ textEvent: { eventType: 2 } }), { kind: 'touch', touch: 'swipeDown' });
});

test('a press has no eventType because protobuf drops zero', () => {
  assert.deepEqual(mapHostEvent({ sysEvent: {} }), { kind: 'touch', touch: 'press' });
  assert.deepEqual(mapHostEvent({ sysEvent: { eventType: 3 } }), { kind: 'touch', touch: 'double' });
});

test('IMU, lifecycle and unknown events', () => {
  assert.deepEqual(mapHostEvent({ sysEvent: { eventType: 8, imuData: { x: 1 } } }), { kind: 'imu', data: { x: 1 } });
  assert.equal(mapHostEvent({ sysEvent: { eventType: 8 } }), null);
  assert.deepEqual(mapHostEvent({ sysEvent: { eventType: 4 } }), { kind: 'foreground' });
  assert.deepEqual(mapHostEvent({ sysEvent: { eventType: 5 } }), { kind: 'background' });
  assert.deepEqual(mapHostEvent({ sysEvent: { eventType: 6 } }), { kind: 'abnormalExit' });
  assert.deepEqual(mapHostEvent({ sysEvent: { eventType: 7 } }), { kind: 'exit' });
  assert.equal(mapHostEvent({ sysEvent: { eventType: 9 } }), null);
  assert.equal(mapHostEvent({}), null);
});

// Runs the real SDK: it needs a browser document just to load.
test('the numbers match the installed SDK, and its parser feeds this mapping', async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { readyState: 'complete', addEventListener() {}, createElement() { return {}; } };
  g.addEventListener ??= () => {};
  const log = console.log;
  console.log = () => {};
  const sdk = await import('@evenrealities/even_hub_sdk');
  console.log = log;
  const E = sdk.OsEventTypeList;
  assert.deepEqual(
    [E.CLICK_EVENT, E.SCROLL_TOP_EVENT, E.SCROLL_BOTTOM_EVENT, E.DOUBLE_CLICK_EVENT, E.FOREGROUND_ENTER_EVENT, E.FOREGROUND_EXIT_EVENT, E.ABNORMAL_EXIT_EVENT, E.SYSTEM_EXIT_EVENT, E.IMU_DATA_REPORT],
    [0, 1, 2, 3, 4, 5, 6, 7, 8],
  );
  const parsed = sdk.evenHubEventFromJson({ type: 'sysEvent', jsonData: { eventType: 8, imuData: { x: 1, y: 0 } } });
  assert.deepEqual(mapHostEvent(parsed), { kind: 'imu', data: parsed.sysEvent?.imuData });
  // Facts the wear and IMU handling depend on. If an SDK update changes these, revisit them.
  assert.equal(new sdk.DeviceStatus({ sn: 'a' }).isWearing, false, 'a missing isWearing becomes false');
  assert.equal(sdk.IMU_Report_Data.fromJson({ x: 1.5 }).y, undefined, 'a missing axis stays undefined');
  assert.equal('setBackgroundState' in sdk, false, 'setBackgroundState is not exported');
});
