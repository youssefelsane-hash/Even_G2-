import type { GestureEvent } from './gestureEngine.ts';
import type { RawSample } from './imuAdapter.ts';
import type { LogRow } from './imuLogger.ts';
import { countGestures } from './scenarios.ts';
import type { Settings } from './settings.ts';

// Replays a log written by the raw IMU logger (ImuLogger.toCsv or toJson)
// through the adapter and gesture engine, and checks the gestures against the
// "mark ..." notes the user pressed while recording. Works on the synthetic
// traces in test/traces today, and on real Phase 0 logs once they exist.

export interface ParsedLog { samples: RawSample[]; notes: { t: number; note: string }[]; badLines: number }

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

function fromRows(rows: LogRow[]): ParsedLog {
  const log: ParsedLog = { samples: [], notes: [], badLines: 0 };
  for (const r of rows) {
    if (!Number.isFinite(r.t)) { log.badLines++; continue; }
    if (typeof r.note === 'string') log.notes.push({ t: r.t, note: r.note });
    else if ([r.x, r.y, r.z].every((v) => typeof v === 'number')) log.samples.push({ t: r.t, x: r.x!, y: r.y!, z: r.z! });
    else log.badLines++;
  }
  return log;
}

/** Accepts the CSV or the JSON export of the logger. */
export function parseImuLog(text: string): ParsedLog {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{')) {
    const j = JSON.parse(trimmed) as { rows?: LogRow[] };
    return fromRows(Array.isArray(j.rows) ? j.rows : []);
  }
  const rows: LogRow[] = [];
  let bad = 0;
  const lines = text.split(/\r?\n/);
  for (const [i, line] of lines.entries()) {
    if (!line.trim() || (i === 0 && line.startsWith('t_ms'))) continue;
    const [t, x, y, z, note] = parseCsvLine(line);
    const tn = Number(t);
    if (!Number.isFinite(tn)) { bad++; continue; }
    if (note) rows.push({ t: tn, note });
    else if (x !== '' && y !== '' && z !== '') rows.push({ t: tn, x: Number(x), y: Number(y), z: Number(z) });
    else bad++;
  }
  const log = fromRows(rows);
  log.badLines += bad;
  return log;
}

export type Expectation = 'shake' | 'up' | 'down' | 'none' | 'ignore';

/** What a mark name promises. Unknown marks are ignored. */
export function expectationOf(note: string): Expectation | null {
  const m = /^mark (.+)$/.exec(note.trim());
  if (!m) return null;
  const name = m[1].toLowerCase();
  if (name === 'shake') return 'shake';
  if (name === 'tilt up') return 'up';
  if (name === 'tilt down') return 'down';
  if (['still', 'walking', 'talking', 'turn left', 'turn right', 'glance', 'reading', 'nodding'].includes(name)) return 'none';
  return 'ignore';
}

export interface Segment { start: number; end: number; mark: string; expect: Expectation; shakes: number; up: number; down: number; ok: boolean }

export interface ReplayReport { segments: Segment[]; events: GestureEvent[]; passed: number; failed: number; samples: number }

/** Each mark opens a segment that runs to the next mark. */
export function replayLog(log: ParsedLog, settings: Settings): ReplayReport {
  const counts = countGestures(log.samples, settings, true);
  const marks = log.notes.map((n) => ({ ...n, expect: expectationOf(n.note) })).filter((n) => n.expect !== null);
  const last = log.samples.length ? log.samples[log.samples.length - 1].t : 0;
  const segments: Segment[] = marks.map((m, i) => {
    const start = m.t;
    const end = i + 1 < marks.length ? marks[i + 1].t : last + 1;
    const inside = counts.events.filter((e) => e.t >= start && e.t < end);
    const shakes = inside.filter((e) => e.type === 'shake').length;
    const up = inside.filter((e) => e.type === 'tiltStart' && e.direction === 'up').length;
    const down = inside.filter((e) => e.type === 'tiltStart' && e.direction === 'down').length;
    const expect = m.expect!;
    const ok = expect === 'ignore' ? true
      : expect === 'shake' ? shakes === 1 && up + down === 0
        : expect === 'up' ? up >= 1 && down === 0 && shakes === 0
          : expect === 'down' ? down >= 1 && up === 0 && shakes === 0
            : shakes === 0 && up + down === 0;
    return { start, end, mark: m.note.replace(/^mark /, ''), expect, shakes, up, down, ok };
  });
  const judged = segments.filter((s) => s.expect !== 'ignore');
  return { segments, events: counts.events, passed: judged.filter((s) => s.ok).length, failed: judged.filter((s) => !s.ok).length, samples: log.samples.length };
}
