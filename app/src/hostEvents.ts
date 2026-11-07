// Turns SDK events into app actions. Values match OsEventTypeList in SDK 0.0.16
// (test/hostEvents.test.ts checks them). Kept free of SDK imports so it can be
// tested in plain Node: the SDK needs a browser document just to load.
import type { Touch } from './core/assistant.ts';

const EV = { CLICK: 0, SCROLL_TOP: 1, SCROLL_BOTTOM: 2, DOUBLE_CLICK: 3, FOREGROUND_ENTER: 4, FOREGROUND_EXIT: 5, ABNORMAL_EXIT: 6, SYSTEM_EXIT: 7, IMU: 8 } as const;

export interface HostEventLike {
  textEvent?: { eventType?: number };
  sysEvent?: { eventType?: number; imuData?: { x?: number; y?: number; z?: number } };
}

export type HostAction =
  | { kind: 'imu'; data: { x?: number; y?: number; z?: number } }
  | { kind: 'touch'; touch: Touch }
  | { kind: 'foreground' }
  | { kind: 'background' }
  | { kind: 'abnormalExit' }
  | { kind: 'exit' };

export function mapHostEvent(e: HostEventLike): HostAction | null {
  // Swipes arrive as textEvent, presses and lifecycle as sysEvent. Protobuf
  // drops zero values, so a single press has no eventType at all.
  if (e.textEvent) {
    const t = e.textEvent.eventType ?? EV.CLICK;
    if (t === EV.SCROLL_TOP) return { kind: 'touch', touch: 'swipeUp' };
    if (t === EV.SCROLL_BOTTOM) return { kind: 'touch', touch: 'swipeDown' };
    if (t === EV.CLICK) return { kind: 'touch', touch: 'press' };
    return null;
  }
  if (!e.sysEvent) return null;
  const t = e.sysEvent.eventType ?? EV.CLICK;
  switch (t) {
    case EV.IMU: return e.sysEvent.imuData ? { kind: 'imu', data: e.sysEvent.imuData } : null;
    case EV.CLICK: return { kind: 'touch', touch: 'press' };
    case EV.DOUBLE_CLICK: return { kind: 'touch', touch: 'double' };
    case EV.FOREGROUND_ENTER: return { kind: 'foreground' };
    case EV.FOREGROUND_EXIT: return { kind: 'background' };
    case EV.ABNORMAL_EXIT: return { kind: 'abnormalExit' };
    case EV.SYSTEM_EXIT: return { kind: 'exit' };
    default: return null;
  }
}
