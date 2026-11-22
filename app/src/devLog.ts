// Development only (imported behind import.meta.env.DEV): sends console lines,
// a status line every second and every raw IMU sample to the dev server, which
// appends them to app/.devlog/session.jsonl. See vite.config.ts.
import type { Assistant } from './core/assistant.ts';
import type { RawSample } from './core/imuAdapter.ts';

type Line = Record<string, unknown>;

export function startDevLog(assistant: Assistant, extra: () => Line): void {
  let queue: Line[] = [];
  const t0 = Date.now();
  const push = (l: Line): void => { queue.push({ at: new Date().toISOString(), ms: Date.now() - t0, ...l }); if (queue.length > 5000) queue = queue.slice(-5000); };
  push({ kind: 'boot', ua: navigator.userAgent });

  for (const level of ['log', 'warn', 'error'] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig(...args);
      push({ kind: 'console', level, text: args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') });
    };
  }
  window.addEventListener('error', (e) => push({ kind: 'console', level: 'error', text: `${e.message} at ${e.filename}:${e.lineno}` }));
  window.addEventListener('unhandledrejection', (e) => push({ kind: 'console', level: 'error', text: `unhandled: ${String(e.reason)}` }));

  // The raw host message, before the SDK turns a missing isWearing into false.
  const w = window as unknown as Record<string, unknown>;
  const raw = w._listenEvenAppMessage;
  if (typeof raw === 'function') {
    w._listenEvenAppMessage = (m: unknown) => {
      const text = typeof m === 'string' ? m : JSON.stringify(m);
      if (!/imuData|iMUData/i.test(text)) push({ kind: 'raw', text: text.slice(0, 3000) });
      return (raw as (m: unknown) => unknown)(m);
    };
    push({ kind: 'console', level: 'log', text: 'DEVLOG raw host messages hooked' });
  } else {
    push({ kind: 'console', level: 'warn', text: `DEVLOG no _listenEvenAppMessage (${typeof raw})` });
  }

  const handle = assistant.handleImu.bind(assistant);
  assistant.handleImu = (raw: RawSample) => {
    push({ kind: 'imu', t: raw.t, x: raw.x, y: raw.y, z: raw.z });
    handle(raw);
  };

  setInterval(() => {
    const s = assistant.snapshot();
    const st = assistant.settings;
    push({
      kind: 'status', state: assistant.state, wear: s.wear, connected: s.connected, sensorStale: s.sensorStale,
      tilt: s.engine.phase, deviation: s.engine.deviation, neutral: s.engine.neutral, shakeReject: s.engine.shakeReject,
      lastGesture: s.lastGesture, shakes: s.shakes, line: s.topLine, lines: s.lineCount, imuAccepted: s.adapter.accepted,
      calibrating: assistant.calibration !== null, trustWear: st.trustWearSensor,
      unlockGesture: st.unlockGesture, unlockTouchpad: st.unlockTouchpad, unlockTaps: st.recoveryPresses,
      tapCount: s.tapCount, lastTap: s.lastTap,
      cfg: { gravityAngles: st.gravityAngles, wrapPeriod: st.wrapPeriod, neutralMaxShiftDeg: st.neutralMaxShiftDeg, pitchAxis: st.pitchAxis, yawAxis: st.yawAxis, pitchSign: st.pitchSign, imuScale: st.imuScale, imuMode: st.imuMode,
        neutralPitch: st.neutralPitch, deadZone: st.deadZoneDeg, up: st.tiltUpDeg, down: st.tiltDownDeg, max: st.tiltMaxDeg,
        hyst: st.tiltHysteresisDeg, shakeMinAmp: st.shakeMinAmpDeg, shakeMinRate: st.shakeMinRateDps, noise: st.sensorNoiseDeg },
      ...extra(),
    });
  }, 1000);

  setInterval(() => {
    if (!queue.length) return;
    const batch = queue;
    queue = [];
    fetch('./__devlog', { method: 'POST', body: JSON.stringify(batch), headers: { 'content-type': 'application/json' } })
      .catch(() => { queue = [...batch, ...queue].slice(-5000); });
  }, 1000);
}
