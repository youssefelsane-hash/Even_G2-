import type { DisplayMode, JobEvent } from './backend.ts';
import { CalibrationWizard } from './calibration.ts';
import { GestureEngine, type EngineStatus, type GestureEvent } from './gestureEngine.ts';
import { ImuAdapter, type AdapterStats, type RawSample } from './imuAdapter.ts';
import { ImuLogger } from './imuLogger.ts';
import { Inbox, answerText, type AnswerRecord } from './inbox.ts';
import { MAX_SCREEN_CHARS, Pager, approxMeasure, type Measure } from './paging.ts';
import { BLANK, type DisplayPlan } from './renderQueue.ts';
import { sanitizeSettings, type Settings } from './settings.ts';
import { bootState, contentAllowed, flatState, reduce, type AppState, type MachineEvent, type MachineState, type Wear } from './stateMachine.ts';
import { SessionWriter, loadSession, loadSettings, saveSettings, type KeyValueStore, type Session } from './storage.ts';
import { PressCounter } from './touchRecovery.ts';
import { ExampleRecorder, analyseExamples, type ExampleLabel, type PersonalResult } from './personal.ts';

export interface Answer { id: string; short: string; details: string }
export type Touch = 'press' | 'double' | 'swipeUp' | 'swipeDown';

export interface AssistantDeps {
  store: KeyValueStore;
  now(): number;
  /** Called on every display change. `force` resends even an unchanged plan. */
  onPlan(plan: DisplayPlan, force: boolean): void;
  onExitRequest?(): void;
  onChange?(): void;
  /** The answer of this job was on the lens, so the user could see it. */
  onDisplayed?(jobId: string): void;
  /** What the lens may show changed. For the backend's presence report. */
  onPresence?(mode: DisplayMode): void;
  measure?: Measure;
}

/** What the camera is doing, shown on the lens only while VISIBLE. */
export interface CameraStatus { jobId: string; stage: 'received' | 'processing'; photos: number; pages: number }

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
  /** Answers stored on the phone, and how many of them were never on the lens. */
  stored: number;
  unseenAnswers: number;
  camera: CameraStatus | null;
  presence: DisplayMode;
  undoAvailable: boolean;
  recordingExample: ExampleLabel | null;
  examples: Record<ExampleLabel, number>;
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
  readonly examples = new ExampleRecorder();
  private readonly inbox: Inbox;
  private camera: CameraStatus | null = null;
  private errorKind: 'error' | 'retake' = 'error';
  private readonly finished = new Map<string, true>(); // jobs with a final event, newest last
  private presence: DisplayMode = 'UNKNOWN';
  private undo: { until: number; text: string } | null = null;

  private constructor(deps: AssistantDeps, settings: Settings, session: Session | null, answers: AnswerRecord[]) {
    this.deps = deps;
    this.inbox = new Inbox(deps.store, answers);
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
    const [settings, session, answers] = await Promise.all([loadSettings(deps.store), loadSession(deps.store), Inbox.load(deps.store)]);
    return new Assistant(deps, settings, session, answers);
  }

  get settings(): Readonly<Settings> { return this.settingsValue; }
  get state(): AppState { return flatState(this.machine); }
  /** Job id of the answer the lens shows or would show. No answer text. */
  get docId(): string { return this.session.docId; }
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

  private cameraText(): string | null {
    const c = this.camera;
    if (!c) return null;
    const page = c.pages > 1 ? ` (page ${c.pages})` : '';
    if (c.stage === 'processing') return `READING...${page}`;
    return c.photos > 0 ? `RECEIVED ${c.photos} PHOTO${c.photos === 1 ? '' : 'S'}${page}` : `RECEIVED${page}`;
  }

  private header(): string {
    const stale = this.sensorStale ? '  ! sensor lost' : '';
    const job = this.machine.job;
    const docLabel = this.session.label ? `${this.session.label}${(this.session.pages ?? 1) > 1 ? ` ${this.session.pages}p` : ''}` : null;
    const label = job === 'ERROR' ? (this.errorKind === 'retake' ? 'RETAKE' : 'ERROR')
      : this.cameraText() ?? (job === 'PROCESSING' ? 'WORKING...' : docLabel ?? (job === 'RESULT_READY' ? 'NEW ANSWER' : 'ASSISTANT'));
    const p = this.pager;
    const range = job !== 'ERROR' && p.lineCount > p.viewLines ? `  ${p.topLine + 1}-${Math.min(p.lineCount, p.topLine + p.viewLines)}/${p.lineCount}` : '';
    const more = this.inbox.unseenCount(this.session.docId);
    const queued = job !== 'ERROR' && more > 0 ? `  +${more} new` : '';
    return `${label}${range}${queued}${stale}`;
  }

  /** What the lens would show if content were allowed. */
  private visibleText(): string {
    const body = this.machine.job === 'ERROR'
      ? [...this.pager.wrap(this.errorText).slice(0, this.pager.viewLines - 2), '', 'Press to dismiss.']
      : this.pager.visible();
    return [this.header(), ...body].join('\n').slice(0, MAX_SCREEN_CHARS);
  }

  /** The single place that decides what the lens shows. */
  plan(): DisplayPlan {
    if (!contentAllowed(this.machine)) return BLANK;
    return { kind: 'text', text: this.visibleText() };
  }

  private presenceMode(): DisplayMode {
    const m = this.machine;
    if (m.mode === 'VISIBLE') return 'VISIBLE';
    if (m.mode === 'REMOVED') return 'REMOVED';
    return this.connected === true && m.wear !== 'unknown' ? 'HIDDEN' : 'UNKNOWN';
  }

  private publish(force = false): void {
    this.deps.onPlan(this.plan(), force);
    // The answer is on the lens now, so the user could see it.
    if (contentAllowed(this.machine) && this.machine.job !== 'ERROR' && this.inbox.markSeen(this.session.docId)) {
      void this.inbox.save();
      this.deps.onDisplayed?.(this.session.docId);
    }
    const presence = this.presenceMode();
    if (presence !== this.presence) {
      this.presence = presence;
      this.deps.onPresence?.(presence);
    }
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
    // Answers waiting in the inbox also count, so a restart still says something new is there.
    const waiting = this.inbox.unseenCount() > 0 && this.machine.mode !== 'VISIBLE';
    this.session = { ...this.session, topLine: this.pager.topLine, unseen: job === 'RESULT_READY' ? unseen || waiting : (unseen && this.session.unseen) || waiting };
    this.writer.queue(this.session);
  }

  // ---- Sensor input ----

  handleImu(raw: RawSample): void {
    this.logger.push(raw);
    const sample = Number.isFinite(raw.t) ? { ...raw, t: this.clock(raw.t) } : raw;
    if (this.wizard || this.examples.recording) {
      this.wizard?.push(sample);
      this.examples.push(sample);
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
      case 'shake': {
        this.shakes++;
        this.lastGesture = `shake ${g.confidence.toFixed(2)}`;
        this.logger.note(g.t, `gesture shake confidence ${g.confidence.toFixed(2)}`);
        const wasVisible = this.machine.mode === 'VISIBLE';
        const shown = wasVisible ? this.visibleText() : '';
        this.undo = null;
        if (this.dispatch({ type: 'SHAKE' }, g.t)) {
          // An accidental hide can be undone for a few seconds, but only back to
          // exactly the screen that was just hidden.
          if (wasVisible && this.settingsValue.undoHideMs > 0) this.undo = { until: g.t + this.settingsValue.undoHideMs, text: shown };
          this.persist();
          this.publish();
        }
        return;
      }
      case 'scroll':
        this.lastGesture = `scroll ${g.direction}`;
        this.scroll(g.direction === 'up' ? -g.lines : g.lines, 'tilt', g.t);
        return;
      case 'tiltStart':
        this.logger.note(g.t, `gesture tiltStart ${g.direction} confidence ${g.confidence.toFixed(2)}`);
        return;
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
    this.undo = null;
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
    this.undo = null;
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
      if (touch === 'double' && this.tryUndo(now)) return;
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
      case 'press': {
        // More answers arrived while hidden: a press opens the next one.
        const next = this.machine.job !== 'ERROR' ? this.inbox.nextUnseen(this.session.docId) : undefined;
        if (next) {
          this.open(next);
          this.persist();
          this.publish();
          return;
        }
        if (this.dispatch({ type: 'ACK' }, now)) this.publish();
        return;
      }
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

  // Undo works only within the time limit, while worn, and only if the screen
  // would be exactly what was hidden. A new answer, a wear or connection change,
  // an exit or a restart all cancel it, so it can never show anything new.
  private tryUndo(now: number): boolean {
    const u = this.undo;
    this.undo = null;
    if (!u || now > u.until || this.machine.wear !== 'worn' || this.visibleText() !== u.text) return false;
    if (!this.dispatch({ type: 'UNDO_HIDE' }, now)) return false;
    this.logger.note(now, 'undo hide');
    this.presses.clear();
    for (const g of this.engine.reset()) this.onGesture(g);
    this.persist();
    this.publish();
    return true;
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
    this.undo = null;
    for (const g of this.engine.reset()) this.onGesture(g);
    this.persist();
    this.publish();
  }

  // ---- AI pipeline ----

  aiStarted(): void {
    this.dispatch({ type: 'AI_STARTED' }, this.clock());
    this.publish();
  }

  /** A local answer (sample or test). Backend answers come through handleJobEvent. */
  aiResult(answer: Answer): void {
    this.undo = null;
    this.dispatch({ type: 'AI_RESULT' }, this.clock());
    this.session = { docId: answer.id, short: answer.short, details: answer.details, topLine: 0, unseen: this.machine.unseen };
    this.pager.setText(this.docText());
    this.persist();
    this.publish(); // blank while Hidden or Removed: the plan decides, not this method
  }

  aiError(message: string, kind: 'error' | 'retake' = 'error'): void {
    this.undo = null;
    this.errorText = message;
    this.errorKind = kind;
    this.dispatch({ type: 'AI_ERROR' }, this.clock());
    this.persist();
    this.publish();
  }

  private open(r: AnswerRecord): void {
    this.session = { docId: r.jobId, short: r.short, details: answerText(r).slice(r.short.length).replace(/^\n+/, ''), topLine: 0, unseen: this.machine.unseen, label: r.label, pages: r.pages };
    this.pager.setText(this.docText());
  }

  private finish(jobId: string): void {
    this.finished.set(jobId, true);
    if (this.finished.size > 200) this.finished.delete(this.finished.keys().next().value as string);
    if (this.camera?.jobId === jobId) this.camera = null;
  }

  /**
   * One event from the backend. Resolves once a result is stored, so the
   * client acknowledges "received" only for what the phone really keeps.
   * Nothing here can reveal: every path ends in publish(), and plan() decides.
   */
  async handleJobEvent(e: JobEvent): Promise<void> {
    const now = this.clock();
    if (this.finished.has(e.jobId) || this.inbox.has(e.jobId)) return; // late or repeated
    if (e.history) {
      // An old job from a catch-up (lost cursor, reinstall, reset server). It is
      // not news: no camera status, no retake, and an answer is kept as seen.
      if (e.status === 'ready' || e.status === 'retake' || e.status === 'failed') this.finished.set(e.jobId, true);
      const r = e.result;
      if (e.status === 'ready' && r && this.inbox.addHistory({ jobId: e.jobId, short: r.short, detail: r.detail, label: r.label, caveats: r.caveats, pages: r.pages, usedFrames: r.usedFrames, at: now, seen: true, seq: e.seq })) {
        this.deps.onChange?.();
        await this.inbox.save();
      }
      return;
    }
    switch (e.status) {
      case 'received':
      case 'processing': {
        const first = this.camera?.jobId !== e.jobId;
        this.camera = { jobId: e.jobId, stage: e.status, photos: e.photos ?? this.camera?.photos ?? 0, pages: e.pages ?? 1 };
        this.logger.note(now, `job ${e.status}`);
        if (first || this.machine.job !== 'PROCESSING') this.dispatch({ type: 'AI_STARTED' }, now);
        this.publish();
        return;
      }
      case 'ready': {
        const r = e.result;
        if (!r) return;
        this.finish(e.jobId);
        this.undo = null;
        const rec: AnswerRecord = { jobId: e.jobId, short: r.short, detail: r.detail, label: r.label, caveats: r.caveats, pages: r.pages, usedFrames: r.usedFrames, at: now, seen: false, seq: e.seq };
        // A new page of an earlier question replaces that answer.
        if (!this.inbox.add(rec, e.appendedTo)) return;
        this.logger.note(now, `job ready ${r.label}`);
        this.dispatch({ type: 'AI_RESULT' }, now);
        this.open(rec);
        this.persist();
        this.publish();
        await this.inbox.save();
        return;
      }
      case 'retake': {
        this.finish(e.jobId);
        const reason = e.result?.retakeReason ?? 'photo unclear';
        this.logger.note(now, `job retake ${reason}`);
        this.aiError(`Retake: ${reason}. Press the camera button again.`, 'retake');
        return;
      }
      case 'failed':
        this.finish(e.jobId);
        this.logger.note(now, 'job failed');
        this.aiError('The answer could not be made. Take the photo again.');
        return;
    }
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
    this.undo = null;
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

  // ---- Personal calibration: the user's own examples ----

  startExample(label: ExampleLabel): void {
    this.undo = null;
    for (const g of this.engine.reset()) this.onGesture(g);
    this.examples.start(label);
    this.deps.onChange?.();
  }

  stopExample(): boolean {
    const ok = this.examples.stop();
    this.engine.reacquireNeutral();
    this.deps.onChange?.();
    return ok;
  }

  analysePersonal(): PersonalResult {
    return analyseExamples(this.examples.examples, this.settingsValue);
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
      stored: this.inbox.size,
      unseenAnswers: this.inbox.unseenCount(),
      camera: this.camera,
      presence: this.presenceMode(),
      undoAvailable: this.undo !== null && this.clock() <= this.undo.until,
      recordingExample: this.examples.recording,
      examples: { shake: this.examples.count('shake'), tiltUp: this.examples.count('tiltUp'), tiltDown: this.examples.count('tiltDown'), other: this.examples.count('other') },
    };
  }
}
