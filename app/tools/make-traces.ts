// Writes the SYNTHETIC sample traces in test/traces, in the exact CSV format of
// the raw IMU logger, with "mark ..." notes like a user would press during a
// Phase 0 session. They are generated, not recorded: nothing here comes from
// real glasses. Run again after changing synth.ts: node tools/make-traces.ts
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { ImuLogger } from '../src/core/imuLogger.ts';
import { DEFAULT_SETTINGS, sanitizeSettings, type Settings } from '../src/core/settings.ts';
import { lookSide, nod, sequence, shake, still, stream, talking, tilt, walking, type Motion, type StreamOptions } from '../src/core/synth.ts';

const dir = path.join(import.meta.dirname, '..', 'test', 'traces');

interface Part { mark: string; motion: Motion }

function write(name: string, parts: Part[], o: StreamOptions & { settings: Settings }, settingsFile = false): void {
  const log = new ImuLogger();
  log.start();
  let t = 1_731_000_000_000; // wall-clock style arrival times, as on a phone
  log.note(t, 'log start, SYNTHETIC trace');
  for (const p of parts) {
    log.note(t, `mark ${p.mark}`);
    let last = t;
    // Rounded to keep the files small. A real log keeps full precision.
    const r = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
    for (const s of stream(p.motion, { ...o, startT: t })) { log.push({ t: r(s.t, 1), x: r(s.x, 4), y: r(s.y, 4), z: r(s.z, 4) }); last = s.t; }
    t = last + 1000 / (o.hz ?? 50);
  }
  writeFileSync(path.join(dir, `${name}.csv`), log.toCsv());
  if (settingsFile) writeFileSync(path.join(dir, `${name}.settings.json`), `${JSON.stringify(o.settings, null, 1)}\n`);
  console.log(`${name}.csv: ${log.length} rows`);
}

const base = sanitizeSettings(DEFAULT_SETTINGS);
const pad = (m: Motion) => sequence(m, still(1200));
const session: Part[] = [
  { mark: 'still', motion: still(4000) },
  { mark: 'tilt up', motion: pad(tilt(24)) },
  { mark: 'tilt down', motion: pad(tilt(-26)) },
  { mark: 'still', motion: still(1500) },
  // Quick left-right looks with a short rest at each side: the old false fire.
  { mark: 'glance', motion: pad(sequence(...[[35, 150, 100], [35, 160, 120], [30, 150, 100], [35, 150, 150]].flatMap(([deg, turn, hold]) => [lookSide({ deg: -deg, turnMs: turn, holdMs: hold, backMs: turn }), lookSide({ deg, turnMs: turn, holdMs: hold, backMs: turn }), still(1500)]))) },
  { mark: 'shake', motion: pad(shake({ ampDeg: 22 })) },
  { mark: 'turn left', motion: pad(lookSide({ deg: -45 })) },
  { mark: 'turn right', motion: pad(lookSide({ deg: 45 })) },
  { mark: 'shake', motion: pad(shake({ ampDeg: 26, hz: 2.5, startSign: -1 })) },
  { mark: 'nodding', motion: pad(nod({ ampDeg: 12, cycles: 3 })) },
  { mark: 'reading', motion: pad(tilt(-30, { rampMs: 1500, holdMs: 8000, backMs: 1200 })) },
  { mark: 'talking', motion: talking(30_000, 5) },
  { mark: 'walking', motion: walking(30_000, 6) },
];

write('synthetic-session-50hz', session, { hz: 50, jitterMs: 8, dropRate: 0.02, seed: 1, settings: base });
write('synthetic-session-15hz-batched', session, { hz: 15, jitterMs: 10, batch: 2, seed: 2, settings: base });
const rate = sanitizeSettings({ ...base, imuMode: 'rate', pitchAxis: 'z', yawAxis: 'x', pitchSign: -1, imuScale: 0.01 });
write('synthetic-rate-remapped', session, { hz: 50, jitterMs: 5, seed: 3, settings: rate }, true);
