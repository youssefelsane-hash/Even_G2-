import type { Assistant } from './core/assistant.ts';
import { STEP_TEXT } from './core/calibration.ts';
import { SCENARIOS } from './core/scenarios.ts';
import type { Settings } from './core/settings.ts';
import { playMotion } from './motionPlayer.ts';
import { sampleAnswer } from './sampleAnswer.ts';

export interface PanelHost {
  assistant: Assistant;
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
];

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
  const { assistant, now } = host;
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
      `Boots recorded: ${host.boots.length}`,
    ].join('\n');
    $('wearHelp').hidden = wearHelpHidden(s);
    $('logStatus').textContent = assistant.logger.recording ? `Recording: ${assistant.logger.length} rows` : `Stopped: ${assistant.logger.length} rows`;
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
    $<HTMLTextAreaElement>('advanced').value = JSON.stringify(s, null, 1);
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const patch: Record<string, unknown> = {};
    for (const [key, input] of inputs) patch[key] = Number(input.value);
    patch.tiltEnabled = $<HTMLInputElement>('tiltEnabled').checked;
    patch.trustWearSensor = $<HTMLInputElement>('trustWear').checked;
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
