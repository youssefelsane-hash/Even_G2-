// Wires the host to the Assistant: events, device status, IMU control and exit.
// Takes a small bridge interface, not the SDK, so it runs in plain Node tests.
import type { Assistant } from './core/assistant.ts';
import type { BridgeLane } from './core/bridgeLane.ts';
import { toRawSample } from './core/imuAdapter.ts';
import { mapHostEvent, type HostEventLike } from './hostEvents.ts';

export interface HostStatus {
  connectType?: unknown;
  isWearing?: boolean;
  isInCase?: boolean;
  isConnected(): boolean;
}

export interface HostBridge {
  onEvenHubEvent(cb: (e: HostEventLike) => void): () => void;
  onDeviceStatusChanged(cb: (s: HostStatus) => void): () => void;
  getDeviceInfo(): Promise<{ status?: HostStatus } | null>;
  imuControl(on: boolean, pace?: number): Promise<boolean>;
}

export interface HostLinkOptions {
  bridge: HostBridge;
  assistant: Assistant;
  lane: BridgeLane;
  now(): number;
  log?(line: string): void;
  /** The app has ended: stop timers. */
  onClosed?(): void;
}

const IMU_RETRY_MS = 10_000;

export class HostLink {
  private readonly o: HostLinkOptions;
  private readonly log: (line: string) => void;
  private unsubscribe: (() => void)[] = [];
  private closed = false;
  private statusEvents = 0;
  private linkLost = false;
  private lastImuStart = -Infinity;

  constructor(options: HostLinkOptions) {
    this.o = options;
    this.log = options.log ?? ((line) => console.log(line));
  }

  /** `pageReady`: imuControl needs the startup page first. */
  async start(pageReady: boolean): Promise<void> {
    const { bridge } = this.o;
    this.unsubscribe = [
      bridge.onEvenHubEvent((e) => this.onEvent(e)),
      bridge.onDeviceStatusChanged((s) => {
        this.statusEvents++;
        this.applyStatus(s);
      }),
    ];
    if (pageReady) await this.startImu();
    await this.readStatus();
  }

  startImu = async (): Promise<boolean> => {
    const { bridge, assistant, lane, now } = this.o;
    this.lastImuStart = now();
    const pace = assistant.settings.imuPace;
    const ok = await lane.run(() => bridge.imuControl(true, pace)).catch(() => false);
    this.log(`IMU control on, pace ${pace}: ${ok}`);
    return ok;
  };

  private stopImu(): void {
    const { bridge, lane } = this.o;
    void lane.run(() => bridge.imuControl(false)).catch(() => false);
  }

  // A reply can be older than a status event that overtook it, so that event wins.
  private async readStatus(): Promise<void> {
    const { bridge, lane } = this.o;
    const seen = this.statusEvents;
    const info = await lane.run(() => bridge.getDeviceInfo()).catch(() => null);
    if (seen === this.statusEvents && !this.closed) this.applyStatus(info?.status);
  }

  private applyStatus(status: HostStatus | undefined): void {
    if (!status) return;
    const { assistant } = this.o;
    // SDK 0.0.16 turns a missing isWearing into false, so "no report" and
    // "removed" look the same here. Both end in the safe direction.
    this.log(`DEVICE connect=${String(status.connectType)} wearing=${String(status.isWearing)} inCase=${String(status.isInCase)}`);
    const connected = status.isConnected();
    assistant.handleConnection(connected);
    if (!connected) {
      this.linkLost = true;
      return;
    }
    assistant.handleWear(status.isInCase ? false : status.isWearing);
    if (this.linkLost) void this.startImu(); // the glasses may have restarted
    this.linkLost = false;
  }

  private onEvent(e: HostEventLike): void {
    const { assistant, now } = this.o;
    const action = mapHostEvent(e);
    if (!action) return;
    switch (action.kind) {
      case 'imu': {
        const raw = toRawSample(action.data, now());
        if (raw) assistant.handleImu(raw);
        return;
      }
      case 'touch':
        assistant.handleTouch(action.touch);
        return;
      case 'foreground':
        assistant.handleForeground();
        void this.startImu();
        void this.readStatus(); // status events may have been missed while away
        return;
      case 'background':
        void assistant.flush();
        return;
      case 'abnormalExit':
        // The plugin guide says to unsubscribe here as well, but it describes this
        // event as an unexpected disconnect. Staying subscribed keeps recovery possible.
        assistant.handleExit();
        void assistant.flush();
        this.stopImu();
        return;
      case 'exit':
        assistant.handleExit();
        void assistant.flush();
        this.stopImu();
        this.dispose();
        return;
    }
  }

  /** Called by the app timer. Retries an IMU that has gone quiet. */
  tick(): void {
    const { assistant, now } = this.o;
    const s = assistant.snapshot();
    if (s.sensorStale && s.connected && now() - this.lastImuStart >= IMU_RETRY_MS) void this.startImu();
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    this.o.onClosed?.();
  }
}
