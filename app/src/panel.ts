import manifest from '../app.json' with { type: 'json' };
import type { Assistant } from './core/assistant.ts';
import { RESOLUTIONS, clearBackendSettings, loadBackendSettings, saveBackendSettings, type CameraConfig, type CameraPatch, type JobEvent, type ResultClient, type SyncKV } from './core/backend.ts';
import { EXAMPLE_TEXT, type ExampleLabel, type ExampleScore } from './core/personal.ts';
import { STEP_TEXT } from './core/calibration.ts';
import { SCENARIOS } from './core/scenarios.ts';
import type { Settings } from './core/settings.ts';
import { playMotion } from './motionPlayer.ts';
import { sampleAnswer } from './sampleAnswer.ts';

export interface PanelHost {
  assistant: Assistant;
  client: ResultClient;
  kv: SyncKV;
  previousLog: string | null;
  boots: number[];
  hasBridge: boolean;
  now(): number;
  restartImu(): Promise<boolean>;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// The settings the user is expected to touch. Everything else is in stored
// settings too, and is changed by the wizard or by "Advanced JSON".
const FIELDS: { key: keyof Settings; label: string; step: number }[] = [
  { key: 'tiltUpDeg', label: 'Tilt up threshold (deg)', step: 1 },
  { key: 'tiltDownDeg', label: 'Tilt down threshold (deg)', step: 1 },
  { key: 'tiltMaxDeg', label: 'Tilt upper limit (deg)', step: 1 },
  { key: 'tiltMinDurationMs', label: 'Minimum tilt duration (ms)', step: 50 },
  { key: 'tiltMaxHoldMs', label: 'Longest scroll per tilt (ms)', step: 500 },
  { key: 'scrollLinesPerSec', label: 'Scroll speed (lines/s)', step: 0.5 },
  { key: 'shakeSensitivity', label: 'Shake sensitivity', step: 0.1 },
  { key: 'smoothingMs', label: 'Smoothing (ms)', step: 10 },
  { key: 'shakeCooldownMs', label: 'Shake cooldown (ms)', step: 100 },
  { key: 'tiltCooldownMs', label: 'Tilt cooldown (ms)', step: 50 },
  { key: 'shakeMaxPlateauMs', label: 'Longest rest at each side of a shake (ms)', step: 10 },
  { key: 'undoHideMs', label: 'Undo an accidental hide with a double press within (ms, 0 = off)', step: 500 },
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

export function initPanel(host: PanelHost): () => void {
  const { assistant, client, now } = host;
  let playing = false;

  // Status
  const refresh = (): void => {
    const s = assistant.snapshot();
    $('state').textContent = s.state;
    $('state').dataset.state = s.state;
    const hz = s.adapter.hz === null ? 'no data' : `${s.adapter.hz.toFixed(1)} Hz`;
    const dev = s.engine.deviation === null ? 'n/a' : s.engine.deviation.toFixed(1);
    $('detail').textContent = [
      `Wear: ${s.wear}  Connected: ${s.connected}  Bridge: ${host.hasBridge}`,
      `IMU: ${hz}  samples ${s.adapter.accepted}  gaps ${s.adapter.gaps}  batched ${s.adapter.batched}${s.sensorStale ? '  SENSOR LOST' : ''}`,
      `Tilt: ${s.engine.phase}  deviation ${dev}  shake suspect ${s.engine.shakeSuspect}`,
      `Line ${s.topLine + 1} of ${s.lineCount}  unseen result ${s.unseen}  last gesture ${s.lastGesture}  shakes ${s.shakes}`,
      `Background ${s.engine.activity.label} (yaw ${s.engine.activity.yaw.toFixed(1)}, pitch ${s.engine.activity.pitch.toFixed(1)}, shake x${s.engine.activity.shakeBoost.toFixed(2)})  last shake reject ${s.engine.shakeReject}${s.undoAvailable ? '  undo available' : ''}`,
      `Answers stored ${s.stored}, never shown ${s.unseenAnswers}  camera ${s.camera ? `${s.camera.stage} ${s.camera.photos} photos` : 'idle'}  presence ${s.presence}`,
      `Boots recorded: ${host.boots.length}`,
    ].join('\n');
    $('wearHelp').hidden = wearHelpHidden(s);
    $('logStatus').textContent = assistant.logger.recording ? `Recording: ${assistant.logger.length} rows` : `Stopped: ${assistant.logger.length} rows`;
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
  click('wearOn', () => assistant.handleWear(true));
  click('wearOff', () => assistant.handleWear(false));
  click('wearUnknown', () => assistant.handleWear(undefined));
  click('connOn', () => assistant.handleConnection(true));
  click('connOff', () => assistant.handleConnection(false));
  click('aiStart', () => assistant.aiStarted());
  click('aiResult', () => assistant.aiResult(sampleAnswer()));
  click('aiError', () => assistant.aiError('The photo could not be read. Take another one.'));
  click('touchPress', () => assistant.handleTouch('press'));

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
  for (const s of SCENARIOS) {
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
  const inputs = new Map<keyof Settings, HTMLInputElement>();
  for (const f of FIELDS) {
    const label = document.createElement('label');
    label.textContent = f.label;
    const input = document.createElement('input');
    input.type = 'number';
    input.step = String(f.step);
    label.append(input);
    form.insertBefore(label, $('settingsEnd'));
    inputs.set(f.key, input);
  }
  const fillSettings = (): void => {
    const s = assistant.settings;
    for (const [key, input] of inputs) input.value = String(s[key]);
    $<HTMLInputElement>('tiltEnabled').checked = s.tiltEnabled;
    $<HTMLInputElement>('trustWear').checked = s.trustWearSensor;
    $<HTMLInputElement>('activityAware').checked = s.activityAware;
    $<HTMLTextAreaElement>('advanced').value = JSON.stringify(s, null, 1);
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const patch: Record<string, unknown> = {};
    for (const [key, input] of inputs) patch[key] = Number(input.value);
    patch.tiltEnabled = $<HTMLInputElement>('tiltEnabled').checked;
    patch.trustWearSensor = $<HTMLInputElement>('trustWear').checked;
    patch.activityAware = $<HTMLInputElement>('activityAware').checked;
    void assistant.updateSettings(patch as Partial<Settings>).then(() => {
      fillSettings();
      $('settingsSaved').textContent = 'Saved';
    });
  });
  click('saveAdvanced', () => {
    try {
      const patch = JSON.parse($<HTMLTextAreaElement>('advanced').value) as Partial<Settings>;
      void assistant.updateSettings(patch).then(() => {
        fillSettings();
        $('settingsSaved').textContent = 'Saved';
      });
    } catch {
      $('settingsSaved').textContent = 'That is not valid JSON';
    }
  });
  fillSettings();

  // Calibration
  const showWizard = (message = ''): void => {
    const w = assistant.calibration;
    $('calText').textContent = message || (w ? STEP_TEXT[w.step] : 'Not running.');
    $('calStart').hidden = w !== null;
    $('calNext').hidden = !w || w.step === 'review';
    $('calAccept').hidden = w?.step !== 'review';
    $('calCancel').hidden = !w;
    const p = w?.proposal();
    $('calProposal').textContent = p
      ? `Mode ${p.imuMode}, pitch ${p.pitchSign > 0 ? '+' : '-'}${p.pitchAxis}, yaw ${p.yawAxis}, scale ${p.imuScale.toPrecision(3)}\nTilt up ${p.tiltUpDeg.toFixed(1)}, down ${p.tiltDownDeg.toFixed(1)}, dead zone ${p.deadZoneDeg.toFixed(1)}\nShake swing at least ${p.shakeMinAmpDeg.toFixed(1)}, rate at least ${p.shakeMinRateDps.toFixed(0)}`
      : '';
  };
  click('calStart', () => { assistant.startCalibration(); showWizard(); });
  click('calNext', () => {
    const r = assistant.calibration?.next();
    showWizard(r && !r.ok ? `${r.error ?? 'Try again.'} ${STEP_TEXT[assistant.calibration!.step]}` : '');
  });
  click('calAccept', () => void assistant.finishCalibration(true).then(() => { fillSettings(); showWizard(STEP_TEXT.done); }));
  click('calCancel', () => void assistant.finishCalibration(false).then(() => showWizard(STEP_TEXT.cancelled)));
  showWizard();

  // Personal calibration
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-example]')) {
    b.addEventListener('click', () => { assistant.startExample(b.dataset.example as ExampleLabel); refresh(); });
  }
  click('exampleStop', () => {
    const ok = assistant.stopExample();
    $('personalOut').textContent = ok ? 'Example kept.' : 'Too short, not kept.';
    refresh();
  });
  let personal: ReturnType<Assistant['analysePersonal']> | null = null;
  click('personalAnalyse', () => {
    personal = assistant.analysePersonal();
    const p = personal;
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
    if (!personal?.ok || !personal.proposal) return;
    void assistant.updateSettings(personal.proposal).then(() => { fillSettings(); $('personalOut').textContent = 'Saved.'; $('personalAccept').hidden = true; });
  });
  click('personalClear', () => { assistant.examples.clear(); $('personalOut').textContent = 'Examples cleared.'; refresh(); });

  // Raw logger
  const log = assistant.logger;
  click('logStart', () => { log.start(); log.note(now(), `log start, boots so far ${host.boots.length}`); refresh(); });
  click('logStop', () => { log.stop(); $('logSummary').textContent = JSON.stringify(log.summary(), null, 1); refresh(); });
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
