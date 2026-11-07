import { CalibrationWizard } from './calibration.ts';
import { GestureEngine, type EngineStatus, type GestureEvent } from './gestureEngine.ts';
import { ImuAdapter, type AdapterStats, type RawSample } from './imuAdapter.ts';
import { ImuLogger } from './imuLogger.ts';
import { MAX_SCREEN_CHARS, Pager, approxMeasure, type Measure } from './paging.ts';
import { BLANK, type DisplayPlan } from './renderQueue.ts';
import { sanitizeSettings, type Settings } from './settings.ts';
import { bootState, contentAllowed, flatState, reduce, type AppState, type MachineEvent, type MachineState, type Wear } from './stateMachine.ts';
import { SessionWriter, loadSession, loadSettings, saveSettings, type KeyValueStore, type Session } from './storage.ts';
import { PressCounter } from './touchRecovery.ts';

export interface Answer { id: string; short: string; details: string }
export type Touch = 'press' | 'double' | 'swipeUp' | 'swipeDown';

export interface AssistantDeps {
  store: KeyValueStore;
  now(): number;
  /** Called on every display change. `force` resends even an unchanged plan. */
  onPlan(plan: DisplayPlan, force: boolean): void;
  onExitRequest?(): void;
  onChange?(): void;
  measure?: Measure;
}

// State for the phone panel. It carries no answer text on purpose, so a phone
// screen never shows what Hidden mode is hiding.
export interface Snapshot {
  state: AppState;
  wear: Wear;
  connected: boolean;
  unseen: boolean;
  topLine: number;
  lineCount: number;
  sensorStale: boolean;
  adapter: AdapterStats;
  engine: EngineStatus;
  shakes: number;
  lastGesture: string;
}

const WELCOME: Session = {
  docId: 'welcome',
  short: 'Assistant ready.',
  details: 'Take a photo with the camera button and the answer appears here. Tilt your head up or down to scroll. Shake your head to hide or show everything.',
  topLine: 0,
  unseen: false,
};

// Connects sensor input, the state machine and the content. Pure logic with an
// injected clock and store: the same code runs in tests and in the WebView.
export class Assistant {
  private readonly deps: AssistantDeps;
  private settingsValue: Settings;
  private machine: MachineState;
  private session: Session;
  private readonly writer: SessionWriter;
  private readonly adapter: ImuAdapter;
  private readonly engine: GestureEngine;
  private readonly pager: Pager;
  private readonly presses: PressCounter;
  private errorText = '';
  private connected: boolean | null = null; // null until the host first reports
  private lastReportedWear: boolean | undefined = undefined;
  private settleUntil = -Infinity;
  private clockOffset = 0;
  private lastClock = -Infinity;
  private lastSampleT: number | null = null;
  private sensorStale = false;
  private shakes = 0;
  private lastGesture = 'none';
  private wizard: CalibrationWizard | null = null;
  readonly logger = new ImuLogger();

  private constructor(deps: AssistantDeps, settings: Settings, session: Session | null) {
    this.deps = deps;
    this.settingsValue = settings;
    this.session = session ?? WELCOME;
    this.machine = bootState(this.session.unseen); // always Hidden, whatever was stored
    this.writer = new SessionWriter(deps.store);
    this.adapter = new ImuAdapter(settings);
    this.engine = new GestureEngine(settings);
    this.pager = new Pager(undefined, deps.measure ?? approxMeasure);
    this.pager.setText(this.docText(), this.session.topLine);
    this.presses = new PressCounter(() => this.settingsValue.recoveryPresses, () => this.settingsValue.recoveryWindowMs);
  }

  static async create(deps: AssistantDeps): Promise<Assistant> {
    const [settings, session] = await Promise.all([loadSettings(deps.store), loadSession(deps.store)]);
    return new Assistant(deps, settings, session);
  }

  get settings(): Readonly<Settings> { return this.settingsValue; }
  get state(): AppState { return flatState(this.machine); }
  get calibration(): CalibrationWizard | null { return this.wizard; }

  // The phone clock can step backwards. All deadlines here are measured on a
  // clock that never does, or they would stay in the future and block recovery.
  private clock(t: number = this.deps.now()): number {
    const v = t + this.clockOffset;
    if (v >= this.lastClock) {
      this.lastClock = v;
      return v;
    }
    this.clockOffset += this.lastClock - v;
    return this.lastClock;
  }

  private docText(): string {
    const { short, details } = this.session;
    return details ? `${short}\n\n${details}` : short;
  }

  private header(): string {
    const stale = this.sensorStale ? '  ! sensor lost' : '';
    const label = { IDLE: 'ASSISTANT', PROCESSING: 'WORKING...', RESULT_READY: 'NEW ANSWER', ERROR: 'ERROR' }[this.machine.job];
    const p = this.pager;
    const range = p.lineCount > p.viewLines ? `  ${p.topLine + 1}-${Math.min(p.lineCount, p.topLine + p.viewLines)}/${p.lineCount}` : '';
    return `${label}${range}${stale}`;
  }

  /** The single place that decides what the lens shows. */
  plan(): DisplayPlan {
    if (!contentAllowed(this.machine)) return BLANK;
    const body = this.machine.job === 'ERROR'
      ? [...this.pager.wrap(this.errorText).slice(0, this.pager.viewLines - 2), '', 'Press to dismiss.']
      : this.pager.visible();
    return { kind: 'text', text: [this.header(), ...body].join('\n').slice(0, MAX_SCREEN_CHARS) };
  }

  private publish(force = false): void {
    this.deps.onPlan(this.plan(), force);
    this.deps.onChange?.();
  }

  private dispatch(e: MachineEvent, now: number): boolean {
    const before = flatState(this.machine);
    const { state, accepted } = reduce(this.machine, e);
    this.machine = state;
    const after = flatState(state);
    if (before !== after) this.logger.note(now, `state ${before} -> ${after} (${e.type})`);
    return accepted;
  }

  private persist(): void {
    // An error text is not stored, so after a restart only a result can be waiting.
    const { unseen, job } = this.machine;
    this.session = { ...this.session, topLine: this.pager.topLine, unseen: job === 'RESULT_READY' ? unseen : unseen && this.session.unseen };
    this.writer.queue(this.session);
  }

  // ---- Sensor input ----

  handleImu(raw: RawSample): void {
    this.logger.push(raw);
    const sample = Number.isFinite(raw.t) ? { ...raw, t: this.clock(raw.t) } : raw;
    if (this.wizard) {
      this.wizard.push(sample);
      if (Number.isFinite(sample.t)) this.sensorAlive(sample.t);
      return; // no gesture may fire while the user is told to tilt and shake
    }
    const signal = this.adapter.push(sample);
    if (!signal) return;
    this.sensorAlive(sample.t);
    if (this.machine.wear !== 'worn' || sample.t < this.settleUntil) return;
    for (const g of this.engine.push(signal)) this.onGesture(g);
  }

  private sensorAlive(t: number): void {
    this.lastSampleT = t;
    if (!this.sensorStale) return;
    this.sensorStale = false;
    this.logger.note(t, 'sensor back');
    this.publish();
  }

  private onGesture(g: GestureEvent): void {
    switch (g.type) {
      case 'shake':
        this.shakes++;
        this.lastGesture = 'shake';
        this.logger.note(g.t, 'gesture shake');
        if (this.dispatch({ type: 'SHAKE' }, g.t)) {
          this.persist();
          this.publish();
        }
        return;
      case 'scroll':
        this.lastGesture = `scroll ${g.direction}`;
        this.scroll(g.direction === 'up' ? -g.lines : g.lines, 'tilt', g.t);
        return;
      case 'tiltStart':
      case 'tiltStop':
      case 'neutral':
        this.logger.note(g.t, `gesture ${g.type}`);
        return;
    }
  }

  private scroll(lines: number, source: 'tilt' | 'touch', now: number): void {
    if (!this.dispatch({ type: 'SCROLL', source }, now)) return;
    if (this.machine.job === 'ERROR') return;
    const moved = this.pager.scrollBy(lines);
    const acked = this.dispatch({ type: 'ACK' }, now);
    if (!moved && !acked) return;
    this.persist();
    this.publish();
  }

  /** `undefined` means the host gave no value. */
  handleWear(isWearing: boolean | undefined): void {
    const now = this.clock();
    this.lastReportedWear = isWearing;
    this.logger.note(now, `wear ${String(isWearing)}`);
    this.applyWear(now);
  }

  private applyWear(now: number): void {
    const v = this.lastReportedWear;
    // With the sensor distrusted the user has chosen to treat the glasses as always worn.
    const wear: Wear = !this.settingsValue.trustWearSensor ? 'worn' : v === true ? 'worn' : v === false ? 'removed' : 'unknown';
    if (!this.dispatch({ type: 'WEAR', wear }, now)) return;
    this.presses.clear();
    for (const g of this.engine.reset()) this.onGesture(g);
    if (wear === 'worn') {
      // Putting glasses on looks like wild head motion, so wait before listening.
      this.settleUntil = now + this.settingsValue.wearSettleMs;
      this.adapter.reset();
      this.engine.reacquireNeutral();
    }
    this.persist();
    this.publish();
  }

  handleConnection(connected: boolean): void {
    const now = this.clock();
    if (connected === this.connected) return;
    this.connected = connected;
    this.logger.note(now, `connection ${connected}`);
    this.dispatch({ type: 'CONNECTION', connected }, now);
    this.presses.clear();
    if (!connected) {
      this.lastReportedWear = undefined;
      for (const g of this.engine.reset('gap')) this.onGesture(g);
    }
    this.adapter.reset();
    this.engine.reacquireNeutral();
    this.lastSampleT = now; // so an IMU that never starts is also reported as lost
    this.publish(connected); // the lens may have lost its page, so redraw on reconnect
  }

  handleTouch(touch: Touch): void {
    const now = this.clock();
    if (this.machine.mode === 'REMOVED' || now < this.settleUntil) {
      this.presses.clear();
      return;
    }
    if (this.machine.mode === 'HIDDEN') {
      if (touch !== 'press' && touch !== 'double') return;
      if (this.presses.press(now, touch === 'double' ? 2 : 1) && this.dispatch({ type: 'TOUCH_RECOVERY' }, now)) {
        this.logger.note(now, 'touch recovery');
        // The engine kept running while hidden. A tilt in progress must not move the restored screen.
        for (const g of this.engine.reset()) this.onGesture(g);
        this.persist();
        this.publish();
      }
      return;
    }
    switch (touch) {
      case 'press':
        if (this.dispatch({ type: 'ACK' }, now)) this.publish();
        return;
      case 'double':
        this.deps.onExitRequest?.();
        return;
      case 'swipeUp':
        this.scroll(-(this.pager.viewLines - 1), 'touch', now);
        return;
      case 'swipeDown':
        this.scroll(this.pager.viewLines - 1, 'touch', now);
        return;
    }
  }

  /** The host brought the app back. Resend the plan: the lens may be out of date. */
  handleForeground(): void {
    this.publish(true);
  }

  /** The host closed or lost the app. If it comes back, nothing is revealed. */
  handleExit(): void {
    const now = this.clock();
    this.dispatch({ type: 'EXIT' }, now);
    this.presses.clear();
    for (const g of this.engine.reset()) this.onGesture(g);
    this.persist();
    this.publish();
  }

  // ---- AI pipeline ----

  aiStarted(): void {
    this.dispatch({ type: 'AI_STARTED' }, this.clock());
    this.publish();
  }

  aiResult(answer: Answer): void {
    this.dispatch({ type: 'AI_RESULT' }, this.clock());
    this.session = { docId: answer.id, short: answer.short, details: answer.details, topLine: 0, unseen: this.machine.unseen };
    this.pager.setText(this.docText());
    this.persist();
    this.publish(); // blank while Hidden or Removed: the plan decides, not this method
  }

  aiError(message: string): void {
    this.errorText = message;
    this.dispatch({ type: 'AI_ERROR' }, this.clock());
    this.persist();
    this.publish();
  }

  // ---- Timer, settings, calibration ----

  async tick(): Promise<void> {
    const now = this.clock();
    const s = this.settingsValue;
    if (!this.sensorStale && this.lastSampleT !== null && now - this.lastSampleT > s.sensorStaleMs) {
      this.sensorStale = true;
      this.logger.note(now, 'sensor lost');
      for (const g of this.engine.reset('gap')) this.onGesture(g);
      this.publish();
    }
    await this.writer.tick(now);
  }

  async flush(): Promise<void> {
    this.persist();
    await this.writer.flush(this.clock());
  }

  async updateSettings(patch: Partial<Settings>): Promise<void> {
    this.settingsValue = sanitizeSettings({ ...this.settingsValue, ...patch }, this.settingsValue);
    this.adapter.configure(this.settingsValue);
    this.engine.configure(this.settingsValue);
    this.applyWear(this.clock()); // before the save: a hung store must not hold back a safety change
    this.deps.onChange?.();
    await saveSettings(this.deps.store, this.settingsValue);
  }

  startCalibration(): CalibrationWizard {
    for (const g of this.engine.reset()) this.onGesture(g);
    this.wizard = new CalibrationWizard(this.settingsValue);
    return this.wizard;
  }

  async finishCalibration(accept: boolean): Promise<void> {
    const proposal = accept ? this.wizard?.accept() : null;
    if (!accept) this.wizard?.cancel();
    this.wizard = null;
    if (proposal) await this.updateSettings(proposal);
    else this.engine.reacquireNeutral();
    this.deps.onChange?.();
  }

  snapshot(): Snapshot {
    const m = this.machine;
    return {
      state: flatState(m),
      wear: m.wear,
      connected: this.connected === true,
      unseen: m.unseen,
      topLine: this.pager.topLine,
      lineCount: this.pager.lineCount,
      sensorStale: this.sensorStale,
      adapter: this.adapter.stats(),
      engine: this.engine.status(this.clock()),
      shakes: this.shakes,
      lastGesture: this.lastGesture,
    };
  }
}
