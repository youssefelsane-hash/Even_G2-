// Wires the host to the Assistant: events, device status, IMU control and exit.
// Takes a small bridge interface, not the SDK, so it runs in plain Node tests.
import type { Assistant } from './core/assistant.ts';
import type { BridgeLane } from './core/bridgeLane.ts';
import { toRawSample } from './core/imuAdapter.ts';
import { WearCheck } from './core/wearCheck.ts';
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
  /** The app came back to the foreground: for example, poll the backend now. */
  onForeground?(): void;
}

const IMU_RETRY_MS = 10_000;
const WEAR_CHECK_MS = 250;
const WEAR_CHECK_TIMEOUT_MS = 400;

export class HostLink {
  readonly wearCheck = new WearCheck();
  private readonly o: HostLinkOptions;
  private readonly log: (line: string) => void;
  private unsubscribe: (() => void)[] = [];
  private closed = false;
  private statusEvents = 0;
  private lastStatusCheck = -Infinity;
  private lastStatusLog = '';
  private checkingWear = false;
  private lastImuStart = -Infinity;
  private motionRequested = false;
  private motionRevision = 0;
  private foreground = true;
  private foregroundRevision = 0;
  private pageReady = false;

  constructor(options: HostLinkOptions) {
    this.o = options;
    this.log = options.log ?? ((line) => console.log(line));
  }

  /** `pageReady`: imuControl needs the startup page first. */
  async start(pageReady: boolean): Promise<void> {
    const { bridge } = this.o;
    this.pageReady = pageReady;
    this.unsubscribe = [
      bridge.onEvenHubEvent((e) => this.onEvent(e)),
      bridge.onDeviceStatusChanged((s) => {
        this.statusEvents++;
        this.lastStatusCheck = this.o.now();
        // A pushed wear confirmation expires the previous unlock even if the
        // host omitted the preceding removal. Routine snapshots keep it intact.
        this.applyStatus(s, true);
      }),
    ];
    await this.readStatus();
    this.syncMotion();
  }

  /** The lens page was created late (startup failed and a retry worked): the IMU can start now. */
  setPageReady(): void {
    if (this.pageReady || this.closed) return;
    this.pageReady = true;
    this.log('PAGE ready after retry');
    this.syncMotion();
  }

  get isPageReady(): boolean { return this.pageReady; }
  get isClosed(): boolean { return this.closed; }

  startWearCheck = (): void => {
    if (this.closed || !this.foreground) return;
    this.o.assistant.lockDisplay(true);
    this.wearCheck.start(this.o.now());
    this.lastStatusCheck = -Infinity;
    this.tick();
  };

  cancelWearCheck = (): void => {
    this.wearCheck.cancel();
    this.o.assistant.lockDisplay(true);
  };

  startImu = async (): Promise<boolean> => {
    const { bridge, assistant, lane, now } = this.o;
    if (!this.pageReady || this.closed || !this.foreground || !assistant.motionNeeded) return false;
    this.motionRequested = true;
    const revision = ++this.motionRevision;
    this.lastImuStart = now();
    const pace = assistant.settings.imuPace;
    const ok = await lane.run(async () => {
      if (this.closed || revision !== this.motionRevision || !assistant.motionNeeded) return false;
      return bridge.imuControl(true, pace);
    }).catch(() => false);
    this.log(`IMU control on, pace ${pace}: ${ok}`);
    return ok;
  };

  // Touch unlock and touch scroll use separate SDK events and need no IMU.
  syncMotion = (): void => {
    if (!this.pageReady || this.closed) return;
    const need = this.foreground && this.o.assistant.motionNeeded;
    if (need === this.motionRequested) return;
    if (need) void this.startImu();
    else this.stopImu();
  };

  private stopImu(): void {
    const { bridge, lane } = this.o;
    this.motionRequested = false;
    const revision = ++this.motionRevision;
    void lane.run(async () => {
      if (revision !== this.motionRevision) return false;
      return bridge.imuControl(false);
    }).catch(() => false);
  }

  // A reply can be older than a status event that overtook it, so that event wins.
  private async readStatus(required = true): Promise<void> {
    const { bridge, lane, now } = this.o;
    const seen = this.statusEvents;
    const revision = this.foregroundRevision;
    const current = () => seen === this.statusEvents && revision === this.foregroundRevision && !this.closed;
    this.lastStatusCheck = now();
    const info = await lane.run(async () => current() ? bridge.getDeviceInfo() : null,
      false, required ? undefined : WEAR_CHECK_TIMEOUT_MS).catch(() => null);
    if (!current()) return;
    if (info?.status) this.applyStatus(info.status);
    else if (required && this.o.assistant.settings.trustWearSensor) this.o.assistant.handleWear(undefined);
    this.log(`WEAR_CHECK snapshot=${info?.status ? String(info.status.isWearing) : 'unavailable'} inCase=${String(info?.status?.isInCase)}`);
  }

  private applyStatus(status: HostStatus | undefined, pushed = false): void {
    if (!status) return;
    const { assistant } = this.o;
    // SDK 0.0.16 turns a missing isWearing into false, so "no report" and
    // "removed" look the same here. Both end in the safe direction.
    const line = `DEVICE connect=${String(status.connectType)} wearing=${String(status.isWearing)} inCase=${String(status.isInCase)}`;
    if (line !== this.lastStatusLog) this.log(line);
    this.lastStatusLog = line;
    const connected = status.isConnected();
    this.wearCheck.observe({ connected, wearing: status.isWearing, inCase: status.isInCase }, this.o.now());
    assistant.handleConnection(connected);
    if (!connected) {
      if (this.motionRequested) {
        this.motionRequested = false;
        this.motionRevision++;
      }
      return;
    }
    assistant.handleWear(status.isInCase ? false : status.isWearing, status.isInCase === true,
      pushed && assistant.settings.trustWearSensor);
    this.syncMotion();
  }

  private leaveForeground(): void {
    this.foregroundRevision++;
    this.foreground = false;
    this.wearCheck.fail('backgrounded');
    const { assistant } = this.o;
    assistant.handleExit();
    void assistant.flush();
    this.syncMotion();
  }

  private onEvent(e: HostEventLike): void {
    const { assistant, now } = this.o;
    const action = mapHostEvent(e);
    if (!action) return;
    switch (action.kind) {
      case 'imu': {
        if (!this.foreground || this.wearCheck.active) return;
        const raw = toRawSample(action.data, now());
        if (raw) assistant.handleImu(raw);
        return;
      }
      case 'touch':
        if (this.foreground && !this.wearCheck.active) assistant.handleTouch(action.touch, action.source);
        return;
      case 'foreground': {
        const revision = ++this.foregroundRevision;
        this.foreground = false;
        assistant.lockDisplay(true);
        // Check wear before resending content that might predate a removal.
        void this.readStatus().then(() => {
          if (this.closed || revision !== this.foregroundRevision) return;
          this.foreground = true;
          assistant.handleForeground();
          if (this.motionRequested && assistant.motionNeeded) void this.startImu();
          else this.syncMotion();
        });
        this.o.onForeground?.();
        return;
      }
      case 'background':
      case 'abnormalExit':
        this.leaveForeground();
        return;
      case 'exit':
        this.leaveForeground();
        this.dispose();
        return;
    }
  }

  /** Called by the app timer to recover missed status events or a quiet IMU. */
  tick(): void {
    const { assistant, now } = this.o;
    if (this.closed) return;
    this.wearCheck.tick(now());
    const s = assistant.snapshot();
    // The native display can sleep without delivering a status push to the
    // plug-in. Read while visible too: otherwise a missed removal leaves the
    // previous unlock alive for the whole session. These app status snapshots
    // are a fallback, not proof that the host supplies a live wear sensor.
    // During the sensor test, use pushes after the baseline to measure that
    // channel separately.
    const check = this.wearCheck.snapshot(now());
    const canReadStatus = !this.wearCheck.active || check.phase === 'baseline';
    if (this.foreground && canReadStatus && (assistant.settings.trustWearSensor || this.wearCheck.active) &&
      !this.checkingWear && now() - this.lastStatusCheck >= WEAR_CHECK_MS) {
      this.checkingWear = true;
      void this.readStatus(false).finally(() => { this.checkingWear = false; });
    }
    this.syncMotion();
    if (!this.motionRequested) return;
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
