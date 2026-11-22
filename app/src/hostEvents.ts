// Turns SDK events into app actions. Values match OsEventTypeList in SDK 0.0.16
// (test/hostEvents.test.ts checks them). Kept free of SDK imports so it can be
// tested in plain Node: the SDK needs a browser document just to load.
import type { Touch, TouchSource } from './core/assistant.ts';

const EV = { CLICK: 0, SCROLL_TOP: 1, SCROLL_BOTTOM: 2, DOUBLE_CLICK: 3, FOREGROUND_ENTER: 4, FOREGROUND_EXIT: 5, ABNORMAL_EXIT: 6, SYSTEM_EXIT: 7, IMU: 8 } as const;
const TOUCH_SOURCES: Partial<Record<number, TouchSource>> = { 1: 'right', 2: 'ring', 3: 'left' };

interface InputEvent {
  eventType?: number;
  eventSource?: number;
}

export interface HostEventLike {
  textEvent?: InputEvent;
  sysEvent?: InputEvent & { imuData?: { x?: number; y?: number; z?: number } };
}

export type HostAction =
  | { kind: 'imu'; data: { x?: number; y?: number; z?: number } }
  | { kind: 'touch'; touch: Touch; source: TouchSource }
  | { kind: 'foreground' }
  | { kind: 'background' }
  | { kind: 'abnormalExit' }
  | { kind: 'exit' };

export function mapHostEvent(e: HostEventLike): HostAction | null {
  // The host delivers input via the text container or the system channel.
  // Protobuf drops zero values, so a single press may have no eventType.
  const event = e.textEvent ?? e.sysEvent;
  if (!event) return null;
  const source = TOUCH_SOURCES[event.eventSource ?? 0] ?? 'unknown';
  switch (event.eventType ?? EV.CLICK) {
    case EV.IMU: return e.sysEvent?.imuData ? { kind: 'imu', data: e.sysEvent.imuData } : null;
    case EV.CLICK: return { kind: 'touch', touch: 'press', source };
    case EV.DOUBLE_CLICK: return { kind: 'touch', touch: 'double', source };
    case EV.SCROLL_TOP: return { kind: 'touch', touch: 'swipeUp', source };
    case EV.SCROLL_BOTTOM: return { kind: 'touch', touch: 'swipeDown', source };
    case EV.FOREGROUND_ENTER: return { kind: 'foreground' };
    case EV.FOREGROUND_EXIT: return { kind: 'background' };
    case EV.ABNORMAL_EXIT: return { kind: 'abnormalExit' };
    case EV.SYSTEM_EXIT: return { kind: 'exit' };
    default: return null;
  }
}
