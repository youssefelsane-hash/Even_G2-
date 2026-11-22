import manifest from '../app.json' with { type: 'json' };
import type { Assistant } from './core/assistant.ts';
import { RESOLUTIONS, clearBackendSettings, loadBackendSettings, saveBackendSettings, type CameraConfig, type CameraPatch, type JobEvent, type ResultClient, type SyncKV } from './core/backend.ts';
import { EXAMPLE_TEXT, type ExampleLabel, type ExampleScore } from './core/personal.ts';
import { STEP_TEXT, stepTitle } from './core/calibration.ts';
import type { DisplayTimings } from './core/renderQueue.ts';
import type { WearCheckStatus } from './core/wearCheck.ts';
import { SCENARIOS } from './core/scenarios.ts';
import { isUnlockGesture, isUnlockTouchpad, type Settings } from './core/settings.ts';
import { playMotion } from './motionPlayer.ts';
import { sampleAnswer } from './sampleAnswer.ts';

export interface PanelHost {
  assistant: Assistant;
  client: ResultClient;
  kv: SyncKV;
  previousLog: string | null;
  boots: number[];
  hasBridge: boolean;
  simulateInput: boolean;
  revision: string;
  pageReady(): boolean;
  lensStatus(): string;
  lensTimings(): Readonly<DisplayTimings>;
  now(): number;
  syncMotion(): void;
  restartImu(): Promise<boolean>;
  wearCheckStatus(): WearCheckStatus | null;
  startWearCheck(): void;
  cancelWearCheck(): void;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// The settings the user is expected to touch. Everything else is in stored
// settings too, and is changed by the wizard or by "Advanced JSON".
const FIELDS: { key: keyof Settings; label: string }[] = [
  { key: 'tiltUpDeg', label: 'Tilt up threshold (deg)' },
  { key: 'tiltDownDeg', label: 'Tilt down threshold (deg)' },
  { key: 'tiltMaxDeg', label: 'Tilt upper limit (deg)' },
  { key: 'tiltMinDurationMs', label: 'Minimum tilt duration (ms)' },
  { key: 'tiltMaxHoldMs', label: 'Longest scroll per tilt (ms)' },
  { key: 'scrollLinesPerSec', label: 'Scroll speed at a small tilt (lines/s)' },
  { key: 'scrollMaxLinesPerSec', label: 'Scroll speed at a deep tilt (lines/s)' },
  { key: 'shakeSensitivity', label: 'Shake sensitivity' },
  { key: 'smoothingMs', label: 'Smoothing (ms)' },
  { key: 'shakeCooldownMs', label: 'Shake cooldown (ms)' },
  { key: 'tiltCooldownMs', label: 'Tilt cooldown (ms)' },
  { key: 'shakeMaxPlateauMs', label: 'Longest rest at each side of a shake (ms)' },
  { key: 'undoHideMs', label: 'Double-tap undo after a shake in combined mode (ms, 0 = off)' },
];

/** Origins the Even app lets this plugin reach, from app.json. */
export function whitelist(): string[] {
  const perms = (manifest as { permissions?: { name: string; whitelist?: string[] }[] }).permissions ?? [];
  return perms.filter((p) => p.name === 'network').flatMap((p) => p.whitelist ?? []);
}

const pct = (s: { hit: number; of: number }): string => `${s.hit}/${s.of}`;
export function scoreText(s: ExampleScore): string {
  return `shake ${pct(s.shake)}, tilt up ${pct(s.tiltUp)}, tilt down ${pct(s.tiltDown)}, ordinary movement that fired ${pct(s.otherFired)}`;
}

function saveFile(name: string, text: string, type: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

// Goes by the state, not the wear value: a disconnect turns wear to unknown while
// the app stays Removed, and that is exactly when the user needs this help.
export function wearHelpHidden(s: { state: string }): boolean { return s.state !== 'REMOVED'; }

export function wearCheckText(check: WearCheckStatus | null): string {
  if (!check) return 'Open this app through Even Realities to read the glasses sensor.';
  if (check.phase === 'idle') return 'The test checks six removal and re-wear cycles using device reports.';
  const progress = `${check.completed}/${check.required} cycles`;
  if (check.phase === 'complete') return `${progress}. The sensor reported removal and re-wear each time. The lens stays locked until your selected unlock gesture.`;
  if (check.phase === 'failed') {
    const failures = {
      'no-removal-report': 'No removal report reached this preview. Repeat with both arms open and Wear Detection enabled.',
      'no-wear-report': 'No worn report reached this preview. Put the glasses on and keep this preview open.',
      'case-reported': 'The device reported folded arms or the case. Repeat with both arms open.',
      disconnected: 'The glasses disconnected. Reconnect them before repeating the test.',
      backgrounded: 'The preview left the foreground. Keep it open during the test.',
    };
    return `${progress}. ${failures[check.failure ?? 'no-removal-report']}`;
  }
  const instruction = check.phase === 'remove'
    ? 'Take the glasses off. Keep both arms open and wait for a removal report.'
    : 'Put the glasses on and wait for a worn report.';
  return `${progress}. ${instruction} ${check.secondsLeft} seconds left.`;
}

export function initPanel(host: PanelHost): () => void {
  const { assistant, client, now } = host;
  let playing = false;
  $('revision').textContent = `Build ${host.revision}`;

  // Status
  const refresh = (): void => {
    const s = assistant.snapshot();
    const check = host.wearCheckStatus();
    const checkingWear = check?.phase === 'baseline' || check?.phase === 'remove' || check?.phase === 'wear';
    $('wearCheckStatus').textContent = wearCheckText(check);
    $('wearReport').textContent = check?.latest
      ? `Device report · wearing ${String(check.latest.wearing)} · in case ${String(check.latest.inCase)} · connected ${check.latest.connected}`
      : 'Waiting for a device report.';
    $<HTMLButtonElement>('wearCheckStart').disabled = checkingWear || !host.hasBridge;
    $('wearCheckCancel').hidden = !checkingWear;
    $('state').textContent = s.state;
    $('state').dataset.state = s.state;
    const hint = $('unlockHint');
    const settings = assistant.settings;
    const side = settings.unlockTouchpad === 'either' ? '' : `${settings.unlockTouchpad} `;
    const tap = `Tap the ${side}touchpad ${settings.recoveryPresses} times within ${settings.recoveryWindowMs / 1000} seconds`;
    $('lockDisplay').hidden = s.presence !== 'VISIBLE';
    hint.hidden = s.state !== 'HIDDEN' || checkingWear;
    if (s.wear !== 'worn') hint.textContent = 'Waiting for the glasses to report that they are on.';
    else if (settings.unlockGesture === 'shake') hint.textContent = 'Shake your head left and right to unlock.';
    else if (settings.unlockGesture === 'either') hint.textContent = `${tap} or shake your head left and right to unlock.`;
    else hint.textContent = `${tap} to unlock.`;
    const tapStatus = $('tapStatus');
    tapStatus.hidden = checkingWear || s.state !== 'HIDDEN' || s.wear !== 'worn' || settings.unlockGesture === 'shake';
    const tapSources = { left: 'left', right: 'right', ring: 'ring', unknown: 'side unavailable' };
    tapStatus.textContent = `Touches ${s.tapCount}/${settings.recoveryPresses} · Last tap: ${s.lastTap ? tapSources[s.lastTap] : '—'}`;
    const hz = s.adapter.hz === null ? 'no data' : `${s.adapter.hz.toFixed(1)} Hz`;
    const dev = s.engine.deviation === null ? 'n/a' : s.engine.deviation.toFixed(1);
    const timings = host.lensTimings();
    const ms = (value: number | null): string => value === null ? '—' : `${value} ms`;
    $('detail').textContent = [
      `Wear: ${s.wear}  Connected: ${s.connected}  Bridge: ${host.hasBridge}`,
      host.hasBridge
        ? `Lens startup: ${host.pageReady() ? 'ready' : 'failed, retrying every 3 s (motion sensor waits for it)'}  Lens update: ${host.lensStatus()}`
        : 'Lens startup: no bridge',
      ...(host.hasBridge ? [`Lens timing (SDK reply): blank ${ms(timings.blankMs)} · text ${ms(timings.textMs)}`] : []),
      assistant.motionNeeded
        ? `IMU: ${hz}  samples ${s.adapter.accepted}  gaps ${s.adapter.gaps}  batched ${s.adapter.batched}${s.sensorStale ? '  SENSOR LOST' : ''}`
        : 'IMU: idle',
      assistant.calibration
        ? 'GESTURES PAUSED: calibration is open. Press Save gestures or Cancel to use tilt and shake.'
        : `Tilt: ${s.engine.phase}  deviation ${dev}  shake suspect ${s.engine.shakeSuspect}`,
      `Line ${s.topLine + 1} of ${s.lineCount}  unseen result ${s.unseen}  last gesture ${s.lastGesture}  shakes ${s.shakes}`,
      `Background ${s.engine.activity.label} (yaw ${s.engine.activity.yaw.toFixed(1)}, pitch ${s.engine.activity.pitch.toFixed(1)}, shake x${s.engine.activity.shakeBoost.toFixed(2)})  last shake reject ${s.engine.shakeReject}${s.undoAvailable ? '  undo available' : ''}`,
      `Answers stored ${s.stored}, never shown ${s.unseenAnswers}  camera ${s.camera ? `${s.camera.stage} ${s.camera.photos} photos` : 'idle'}  presence ${s.presence}`,
      `Boots recorded: ${host.boots.length}`,
    ].join('\n');
    $('wearHelp').hidden = wearHelpHidden(s);
    $('logStatus').textContent = assistant.logger.recording ? `Recording: ${assistant.logger.length} rows` : `Stopped: ${assistant.logger.length} rows`;
    $<HTMLButtonElement>('imuRestart').disabled = !assistant.motionNeeded;
    const cfg = loadBackendSettings(host.kv);
    $('backendStatus').textContent = cfg
      ? `${cfg.serverUrl}: ${client.connState}${client.lastError && client.connState !== 'online' ? ` (${client.lastError})` : ''}  cursor ${client.cursor}  acks waiting ${client.pendingAcks}  polls ${client.polls}`
      : 'Not set up. Answers come only from the fake buttons.';
    const ex = s.examples;
    $('exampleStatus').textContent = `${s.recordingExample ? `Recording ${s.recordingExample}: ${EXAMPLE_TEXT[s.recordingExample]} ` : ''}Examples: shake ${ex.shake}, tilt up ${ex.tiltUp}, tilt down ${ex.tiltDown}, ordinary ${ex.other}`;
  };
  setInterval(refresh, 500);

  // Simulator tools
  const click = (id: string, fn: () => void): void => { $(id).addEventListener('click', fn); };
  click('lockDisplay', () => assistant.lockDisplay());
  click('wearCheckStart', () => { host.startWearCheck(); refresh(); });
  click('wearCheckCancel', () => { host.cancelWearCheck(); refresh(); });
  if (host.simulateInput) {
    $('simulatedInput').hidden = false;
    $('touchPress').hidden = false;
    click('wearOn', () => assistant.handleWear(true));
    click('wearOff', () => assistant.handleWear(false));
    click('wearUnknown', () => assistant.handleWear(undefined));
    click('connOn', () => assistant.handleConnection(true));
    click('connOff', () => assistant.handleConnection(false));
    click('touchPress', () => {
      const side = assistant.settings.unlockTouchpad;
      assistant.handleTouch('press', side === 'either' ? 'unknown' : side);
    });
  }
  click('aiStart', () => assistant.aiStarted());
  click('aiResult', () => assistant.aiResult(sampleAnswer()));
  click('aiError', () => assistant.aiError('The photo could not be read. Take another one.'));

  // Fake backend events, through the same entry point the real client uses.
  let fakeJob = 0;
  let fakeSeq = 0;
  const job = (status: JobEvent['status'], extra: Partial<JobEvent> = {}) => void assistant.handleJobEvent({ jobId: `fake-job-${fakeJob}`, seq: ++fakeSeq, status, photos: 3, pages: 1, ...extra });
  click('jobReceived', () => { fakeJob++; job('received'); });
  click('jobProcessing', () => job('processing'));
  click('jobReady', () => {
    const a = sampleAnswer();
    job('ready', { result: { short: a.short, detail: a.details.split('\n'), label: 'LIKELY', caveats: ['This is a fake answer from the phone panel.'], pages: 1, usedFrames: 2 } });
  });
  click('jobRetake', () => job('retake', { result: { short: '', detail: [], label: 'RETAKE', caveats: [], pages: 1, usedFrames: 0, retakeReason: 'too dark' } }));

  // Backend connection. The token field is never filled back in.
  const backendForm = $<HTMLFormElement>('backendForm');
  const savedBackend = loadBackendSettings(host.kv);
  if (savedBackend) $<HTMLInputElement>('serverUrl').value = savedBackend.serverUrl;
  backendForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const serverUrl = $<HTMLInputElement>('serverUrl').value;
    const typed = $<HTMLInputElement>('clientToken').value;
    const token = typed || loadBackendSettings(host.kv)?.token || '';
    const err = saveBackendSettings(host.kv, { serverUrl, token });
    $<HTMLInputElement>('clientToken').value = '';
    if (err) { $('backendMsg').textContent = err; return; }
    const cfg = loadBackendSettings(host.kv)!;
    const listed = whitelist().includes(cfg.serverUrl);
    $('backendMsg').textContent = listed ? 'Saved. Connecting.' : `Saved, but ${cfg.serverUrl} is not in the app.json whitelist, so the Even app will block it. Add it and rebuild.`;
    client.start(cfg);
    refresh();
  });
  click('backendForget', () => {
    clearBackendSettings(host.kv);
    void client.stop().then(refresh);
    $<HTMLInputElement>('serverUrl').value = '';
    $('backendMsg').textContent = 'Forgotten. Polling stopped.';
  });

  // Camera settings, stored on the backend.
  const resSelect = $<HTMLSelectElement>('camResolution');
  for (const r of RESOLUTIONS) {
    const o = document.createElement('option');
    o.value = r;
    o.textContent = r;
    resSelect.append(o);
  }
  const fillCamera = (c: CameraConfig): void => {
    $<HTMLSelectElement>('camDefaultMode').value = c.defaultMode;
    $<HTMLInputElement>('camBurstFrames').value = String(c.burstFrames);
    $<HTMLInputElement>('camUploadFrames').value = String(c.uploadFrames);
    $<HTMLSelectElement>('camLongPress').value = c.longPressMode;
    resSelect.value = c.resolution;
  };
  click('camLoad', () => {
    $('camMsg').textContent = 'Loading...';
    client.getCameraConfig().then((c) => { fillCamera(c); $('camMsg').textContent = `Loaded, version ${c.version ?? '?'}.`; }, (e: Error) => { $('camMsg').textContent = `Could not load: ${e.message}`; });
  });
  $<HTMLFormElement>('cameraForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const patch: CameraPatch = {
      defaultMode: $<HTMLSelectElement>('camDefaultMode').value as CameraPatch['defaultMode'],
      burstFrames: Number($<HTMLInputElement>('camBurstFrames').value),
      uploadFrames: Number($<HTMLInputElement>('camUploadFrames').value),
      longPressMode: $<HTMLSelectElement>('camLongPress').value as CameraPatch['longPressMode'],
      resolution: resSelect.value as CameraPatch['resolution'],
    };
    $('camMsg').textContent = 'Saving...';
    client.putCameraConfig(patch).then((c) => { fillCamera(c); $('camMsg').textContent = `Saved, version ${c.version ?? '?'}. The camera picks it up at its next wake.`; }, (err: Error) => { $('camMsg').textContent = `Not saved: ${err.message}`; });
  });

  const motions = $('motions');
  for (const s of host.simulateInput ? SCENARIOS : []) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = s.label;
    b.addEventListener('click', () => {
      if (playing) return;
      playing = true;
      $('motionStatus').textContent = `Playing: ${s.label}`;
      void playMotion(assistant, s.motion(Math.floor(now()) % 1000), now).then(() => {
        playing = false;
        $('motionStatus').textContent = 'Idle';
      });
    });
    motions.append(b);
  }

  // Settings
  const form = $<HTMLFormElement>('settings');
  const unlock = $<HTMLSelectElement>('unlockGesture');
  const unlockTouchpad = $<HTMLSelectElement>('unlockTouchpad');
  const unlockTaps = $<HTMLInputElement>('unlockTaps');
  const showTouchSettings = (): void => {
    const disabled = unlock.value === 'shake';
    unlockTaps.disabled = unlockTouchpad.disabled = disabled;
    $('unlockTapsField').hidden = $('unlockTouchpadField').hidden = disabled;
  };
  unlock.addEventListener('change', showTouchSettings);
  const inputs = new Map<keyof Settings, HTMLInputElement>();
  for (const f of FIELDS) {
    const label = document.createElement('label');
    label.textContent = f.label;
    const input = document.createElement('input');
    input.type = 'number';
    input.step = 'any'; // calibration can save fractional thresholds and speeds
    label.append(input);
    $('settingsEnd').before(label);
    inputs.set(f.key, input);
  }
  const fillSettings = (): void => {
    const s = assistant.settings;
    for (const [key, input] of inputs) input.value = String(s[key]);
    unlock.value = s.unlockGesture;
    unlockTouchpad.value = s.unlockTouchpad;
    unlockTaps.value = String(s.recoveryPresses);
    showTouchSettings();
    $<HTMLInputElement>('tiltEnabled').checked = s.tiltEnabled;
    $<HTMLInputElement>('trustWear').checked = s.trustWearSensor;
    $<HTMLInputElement>('activityAware').checked = s.activityAware;
    $<HTMLTextAreaElement>('advanced').value = JSON.stringify(s, null, 1);
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const patch: Record<string, unknown> = {};
    for (const [key, input] of inputs) {
      if (Number.isFinite(input.valueAsNumber)) patch[key] = input.valueAsNumber;
    }
    if (isUnlockGesture(unlock.value)) patch.unlockGesture = unlock.value;
    if (!unlockTouchpad.disabled && isUnlockTouchpad(unlockTouchpad.value)) patch.unlockTouchpad = unlockTouchpad.value;
    const taps = unlockTaps.valueAsNumber;
    if (!unlockTaps.disabled && Number.isInteger(taps)) patch.recoveryPresses = taps;
    patch.tiltEnabled = $<HTMLInputElement>('tiltEnabled').checked;
    patch.trustWearSensor = $<HTMLInputElement>('trustWear').checked;
    patch.activityAware = $<HTMLInputElement>('activityAware').checked;
    const saving = assistant.updateSettings(patch as Partial<Settings>);
    host.syncMotion();
    void saving.then((saved) => {
      fillSettings();
      $('settingsSaved').textContent = saved ? 'Saved' : 'Applied for this session. Could not save.';
    });
  });
  click('saveAdvanced', () => {
    try {
      const patch = JSON.parse($<HTMLTextAreaElement>('advanced').value) as Partial<Settings>;
      const saving = assistant.updateSettings(patch);
      host.syncMotion();
      void saving.then((saved) => {
        fillSettings();
        $('settingsSaved').textContent = saved ? 'Saved' : 'Applied for this session. Could not save.';
      });
    } catch {
      $('settingsSaved').textContent = 'That is not valid JSON';
    }
  });
  fillSettings();

  // Calibration
  let calibrationTimer: ReturnType<typeof setInterval> | undefined;
  let calibrationMessage = '';
  let needsImuRestart = false;
  let savingCalibration = false;
  const showWizard = (): void => {
    host.syncMotion();
    const w = assistant.calibration;
    const step = w?.captureStep();
    const busy = calibrationTimer !== undefined;
    $('calTitle').hidden = !step;
    $('calTitle').textContent = step ? stepTitle(step) : '';
    $('calText').textContent = w ? STEP_TEXT[w.step] : calibrationMessage || 'Set up tilt to scroll and shake to hide or show.';
    $('calTimer').hidden = !busy;
    $('calMessage').hidden = !w || !calibrationMessage;
    $('calMessage').textContent = calibrationMessage;
    $('calStart').hidden = !!w;
    const capture = $<HTMLButtonElement>('calCapture');
    capture.hidden = !step;
    capture.disabled = busy;
    capture.textContent = calibrationMessage && !busy ? 'Try again' : "I'm ready";
    const save = $<HTMLButtonElement>('calAccept');
    save.hidden = w?.step !== 'review';
    save.disabled = savingCalibration;
    save.textContent = savingCalibration ? 'Saving…' : 'Save gestures';
    const cancel = $<HTMLButtonElement>('calCancel');
    cancel.hidden = !w;
    cancel.disabled = savingCalibration;
    $('calRetryUp').hidden = step !== 'tiltDown' || !calibrationMessage || busy || needsImuRestart;
    $('calRestartImu').hidden = !needsImuRestart || busy;
    const p = w?.proposal(assistant.settings);
    $('calMeasurements').hidden = !p;
    $('calProposal').textContent = p
      ? `Mode ${p.gravityAngles ? 'gravity (true degrees)' : p.imuMode}, pitch ${p.pitchSign > 0 ? '+' : '-'}${p.pitchAxis}, yaw ${p.yawAxis}, scale ${p.imuScale.toPrecision(3)}\nTilt up ${p.tiltUpDeg.toFixed(1)}, down ${p.tiltDownDeg.toFixed(1)}, dead zone ${p.deadZoneDeg.toFixed(1)}\nShake swing at least ${p.shakeMinAmpDeg.toFixed(1)}, rate at least ${p.shakeMinRateDps.toFixed(0)}`
      : '';
  };
  const stopCalibrationTimer = (): void => {
    clearInterval(calibrationTimer);
    calibrationTimer = undefined;
  };
  const updateCapture = (): void => {
    const wizard = assistant.calibration;
    const time = now();
    const result = wizard?.finishCapture(time);
    if (result) {
      stopCalibrationTimer();
      calibrationMessage = result.error ?? '';
      needsImuRestart = !!result.sensorIssue;
      showWizard();
      return;
    }
    const progress = wizard?.captureProgress(time);
    if (!progress) return;
    const label = progress.phase === 'countdown' ? 'Get ready' : 'Recording';
    const timer = $('calTimer');
    const text = `${label} · ${progress.seconds}s`;
    if (timer.textContent !== text) timer.textContent = text;
  };
  click('calStart', () => {
    calibrationMessage = '';
    assistant.startCalibration();
    showWizard();
  });
  click('calCapture', () => {
    if (!assistant.calibration?.captureStep() || calibrationTimer !== undefined) return;
    calibrationMessage = '';
    needsImuRestart = false;
    assistant.calibration.beginCapture(now());
    calibrationTimer = setInterval(updateCapture, 100);
    updateCapture();
    showWizard();
  });
  click('calRetryUp', () => {
    assistant.calibration?.retryTiltUp();
    calibrationMessage = '';
    showWizard();
  });
  click('calRestartImu', () => {
    const wizard = assistant.calibration;
    const button = $<HTMLButtonElement>('calRestartImu');
    button.disabled = true;
    void host.restartImu().then((ok) => {
      button.disabled = false;
      if (assistant.calibration !== wizard || !needsImuRestart || calibrationTimer !== undefined) return;
      needsImuRestart = !ok;
      calibrationMessage = ok ? 'Motion sensor restarted. Try this step again.' : 'The motion sensor did not restart. Check the glasses connection and reopen this preview.';
      showWizard();
    });
  });
  click('calAccept', () => {
    if (savingCalibration) return;
    savingCalibration = true;
    showWizard();
    void assistant.finishCalibration(true).then((saved) => {
      savingCalibration = false;
      calibrationMessage = saved ? STEP_TEXT.done : 'The settings could not be saved. Try saving again.';
      if (saved) fillSettings();
      showWizard();
    });
  });
  click('calCancel', () => {
    stopCalibrationTimer();
    needsImuRestart = false;
    calibrationMessage = STEP_TEXT.cancelled;
    void assistant.finishCalibration(false);
    showWizard();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden' || !assistant.calibration?.interruptCapture()) return;
    stopCalibrationTimer();
    calibrationMessage = 'Recording was interrupted. Keep this screen open and try again.';
    showWizard();
  });
  showWizard();

  // Personal calibration
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-example]')) {
    b.addEventListener('click', () => { assistant.startExample(b.dataset.example as ExampleLabel); host.syncMotion(); refresh(); });
  }
  click('exampleStop', () => {
    const ok = assistant.stopExample();
    host.syncMotion();
    $('personalOut').textContent = ok ? 'Example kept.' : 'Too short, not kept.';
    refresh();
  });
  let personalPatch: Partial<Settings> | null = null;
  click('personalAnalyse', () => {
    const base = assistant.settings;
    const p = assistant.analysePersonal();
    personalPatch = p.proposal ? Object.fromEntries(
      Object.entries(p.proposal).filter(([key, value]) => base[key as keyof Settings] !== value),
    ) : null;
    $('personalAccept').hidden = !p.ok;
    $('personalOut').textContent = !p.ok
      ? p.error ?? 'Could not propose thresholds.'
      : [
        `Current settings on your examples: ${scoreText(p.before)}`,
        `Proposal on your examples: ${p.after ? scoreText(p.after) : 'n/a'}`,
        `Shake swing at least ${p.proposal!.shakeMinAmpDeg.toFixed(1)}, tilt up ${p.proposal!.tiltUpDeg.toFixed(1)}, tilt down ${p.proposal!.tiltDownDeg.toFixed(1)}, entry within ${p.proposal!.tiltEntryMaxMs.toFixed(0)} ms`,
        ...p.warnings,
      ].join('\n');
  });
  click('personalAccept', () => {
    if (!personalPatch) return;
    void assistant.updateSettings(personalPatch).then(() => { fillSettings(); $('personalOut').textContent = 'Saved.'; $('personalAccept').hidden = true; });
  });
  click('personalClear', () => { assistant.examples.clear(); $('personalOut').textContent = 'Examples cleared.'; refresh(); });

  // Raw logger
  const log = assistant.logger;
  click('logStart', () => {
    log.start();
    log.note(now(), `log start, boots so far ${host.boots.length}`);
    host.syncMotion();
    refresh();
  });
  click('logStop', () => {
    log.stop();
    host.syncMotion();
    $('logSummary').textContent = JSON.stringify(log.summary(), null, 1);
    refresh();
  });
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-mark]')) {
    b.addEventListener('click', () => { log.note(now(), `mark ${b.dataset.mark}`); refresh(); });
  }
  click('logCsv', () => {
    const csv = log.toCsv();
    $<HTMLTextAreaElement>('logOut').value = csv;
    saveFile(`imu-log-${now()}.csv`, csv, 'text/csv');
  });
  click('logJson', () => {
    const json = log.toJson();
    $<HTMLTextAreaElement>('logOut').value = json;
    saveFile(`imu-log-${now()}.json`, json, 'application/json');
  });
  click('logPrev', () => { $<HTMLTextAreaElement>('logOut').value = host.previousLog ?? 'No log saved by an earlier session.'; });
  click('imuRestart', () => void host.restartImu());

  refresh();
  return refresh;
}
