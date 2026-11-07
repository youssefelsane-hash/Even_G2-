import type { RawSample } from './imuAdapter.ts';

// Phase 0 tool: records exactly what the host delivers, with no processing, so
// the x/y/z meaning, the real sample rate and suspension gaps can be measured.
export interface LogRow { t: number; x?: number; y?: number; z?: number; note?: string }

export interface AxisSummary { min: number; max: number; mean: number }
export interface LogSummary {
  samples: number;
  notes: number;
  durationMs: number;
  meanHz: number | null;
  dtP50: number | null;
  dtP95: number | null;
  dtMax: number | null;
  gapsOver1s: number;
  discarded: number;
  x: AxisSummary | null;
  y: AxisSummary | null;
  z: AxisSummary | null;
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function axis(values: number[]): AxisSummary | null {
  if (!values.length) return null;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { min, max, mean: sum / values.length };
}

const csvText = (s: string): string => `"${s.replace(/"/g, '""')}"`;

export class ImuLogger {
  private rows: LogRow[] = [];
  private readonly maxRows: number;
  private discarded = 0;
  recording = false;

  constructor(maxRows = 200_000) {
    this.maxRows = maxRows;
  }

  start(): void {
    this.rows = [];
    this.discarded = 0;
    this.recording = true;
  }

  stop(): void {
    this.recording = false;
  }

  private add(row: LogRow): void {
    this.rows.push(row);
    if (this.rows.length > this.maxRows) {
      const cut = Math.ceil(this.maxRows / 10); // drop oldest in blocks, not one by one
      this.rows.splice(0, cut);
      this.discarded += cut;
    }
  }

  push(s: RawSample): void {
    if (this.recording) this.add({ t: s.t, x: s.x, y: s.y, z: s.z });
  }

  /** A marker such as "tilt up" or "wear false". */
  note(t: number, note: string): void {
    if (this.recording) this.add({ t, note });
  }

  get length(): number { return this.rows.length; }

  summary(): LogSummary {
    const imu = this.rows.filter((r) => r.x !== undefined);
    const dts: number[] = [];
    for (let i = 1; i < imu.length; i++) dts.push(imu[i].t - imu[i - 1].t);
    const sorted = [...dts].sort((a, b) => a - b);
    const durationMs = imu.length > 1 ? imu[imu.length - 1].t - imu[0].t : 0;
    return {
      samples: imu.length,
      notes: this.rows.length - imu.length,
      durationMs,
      meanHz: durationMs > 0 ? ((imu.length - 1) * 1000) / durationMs : null,
      dtP50: percentile(sorted, 0.5),
      dtP95: percentile(sorted, 0.95),
      dtMax: sorted.length ? sorted[sorted.length - 1] : null,
      gapsOver1s: dts.filter((d) => d > 1000).length,
      discarded: this.discarded,
      x: axis(imu.map((r) => r.x as number)),
      y: axis(imu.map((r) => r.y as number)),
      z: axis(imu.map((r) => r.z as number)),
    };
  }

  /** CSV of the whole log, or of only the newest `lastRows` rows. */
  toCsv(lastRows?: number): string {
    const lines = ['t_ms,x,y,z,note'];
    for (const r of lastRows === undefined ? this.rows : this.rows.slice(-lastRows)) {
      lines.push(r.note !== undefined ? `${r.t},,,,${csvText(r.note)}` : `${r.t},${r.x},${r.y},${r.z},`);
    }
    return `${lines.join('\n')}\n`;
  }

  toJson(): string {
    return JSON.stringify({ summary: this.summary(), rows: this.rows });
  }
}
