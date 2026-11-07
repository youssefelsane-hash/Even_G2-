// Every tunable lives here, so behaviour changes through stored settings and
// never through code. All "Deg" values are degree-equivalents after imuScale:
// the real unit of the IMU values is not documented (see app/README.md).
export type Axis = 'x' | 'y' | 'z';
export type ImuMode = 'orientation' | 'rate';

export interface Settings {
  // IMU adapter
  imuMode: ImuMode;
  pitchAxis: Axis;
  yawAxis: Axis;
  pitchSign: 1 | -1;
  yawSign: 1 | -1;
  imuScale: number;
  rateBiasPitch: number;
  rateBiasYaw: number;
  wrapPeriod: number;
  maxGapMs: number;
  batchGapMs: number;
  imuPace: number;
  // Neutral pose
  neutralPitch: number | null;
  neutralMaxShiftDeg: number;
  neutralAcquireMs: number;
  stillnessDeg: number;
  driftTauMs: number;
  driftWindowDeg: number;
  smoothingMs: number;
  // Tilt to scroll
  tiltEnabled: boolean;
  deadZoneDeg: number;
  tiltUpDeg: number;
  tiltDownDeg: number;
  tiltHysteresisDeg: number;
  tiltMaxDeg: number;
  tiltEntryMaxMs: number;
  tiltMinDurationMs: number;
  tiltMaxHoldMs: number;
  tiltCooldownMs: number;
  scrollLinesPerSec: number;
  // Shake to hide or show
  shakeSensitivity: number;
  shakeSwings: number;
  shakeMinAmpDeg: number;
  shakeMaxAmpDeg: number;
  shakeReversalDeg: number;
  shakeSuspectDeg: number;
  shakeMinSwingMs: number;
  shakeMaxSwingMs: number;
  shakeMaxDwellMs: number;
  shakeMaxTotalMs: number;
  shakeMinRateDps: number;
  shakeMaxPitchRatio: number;
  shakeAmpRatio: number;
  shakeGuardMs: number;
  shakeCooldownMs: number;
  // Wear and recovery
  trustWearSensor: boolean;
  wearSettleMs: number;
  recoveryPresses: number;
  recoveryWindowMs: number;
  sensorStaleMs: number;
}

// Starting values only. They were chosen against synthetic motion, not against
// real G2 data, and must be replaced by the Phase 0 results and the wizard.
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  imuMode: 'orientation',
  pitchAxis: 'x',
  yawAxis: 'y',
  pitchSign: 1,
  yawSign: 1,
  imuScale: 1,
  rateBiasPitch: 0,
  rateBiasYaw: 0,
  wrapPeriod: 360,
  maxGapMs: 400,
  batchGapMs: 4,
  imuPace: 100,

  neutralPitch: null,
  neutralMaxShiftDeg: 15,
  neutralAcquireMs: 800,
  stillnessDeg: 3,
  driftTauMs: 60_000,
  driftWindowDeg: 12,
  smoothingMs: 60,

  tiltEnabled: true,
  deadZoneDeg: 6,
  tiltUpDeg: 16,
  tiltDownDeg: 18,
  tiltHysteresisDeg: 4,
  tiltMaxDeg: 38,
  tiltEntryMaxMs: 250,
  tiltMinDurationMs: 350,
  tiltMaxHoldMs: 6000,
  tiltCooldownMs: 300,
  scrollLinesPerSec: 3,

  shakeSensitivity: 1,
  shakeSwings: 3,
  shakeMinAmpDeg: 26,
  shakeMaxAmpDeg: 90,
  shakeReversalDeg: 6,
  shakeSuspectDeg: 12,
  shakeMinSwingMs: 60,
  shakeMaxSwingMs: 420,
  shakeMaxDwellMs: 180,
  shakeMaxTotalMs: 1600,
  shakeMinRateDps: 80,
  shakeMaxPitchRatio: 0.6,
  shakeAmpRatio: 3,
  shakeGuardMs: 300,
  shakeCooldownMs: 1200,

  trustWearSensor: true,
  wearSettleMs: 1500,
  recoveryPresses: 4,
  recoveryWindowMs: 3000,
  sensorStaleMs: 3000,
});

type NumberKey = Exclude<{ [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings], 'pitchSign' | 'yawSign'>;

const RANGES: Record<NumberKey, [number, number]> = {
  imuScale: [1e-6, 1e6],
  rateBiasPitch: [-1e6, 1e6],
  rateBiasYaw: [-1e6, 1e6],
  wrapPeriod: [0, 1e6],
  maxGapMs: [50, 10_000],
  batchGapMs: [0, 50],
  imuPace: [100, 1000],
  neutralMaxShiftDeg: [1, 90],
  neutralAcquireMs: [100, 10_000],
  stillnessDeg: [0.1, 30],
  driftTauMs: [1000, 3_600_000],
  driftWindowDeg: [1, 45],
  smoothingMs: [0, 1000],
  deadZoneDeg: [0.5, 40],
  tiltUpDeg: [1, 80],
  tiltDownDeg: [1, 80],
  tiltHysteresisDeg: [0.5, 30],
  tiltMaxDeg: [5, 120],
  tiltEntryMaxMs: [50, 5000],
  tiltMinDurationMs: [0, 5000],
  tiltMaxHoldMs: [500, 120_000],
  tiltCooldownMs: [0, 10_000],
  scrollLinesPerSec: [0.2, 30],
  shakeSensitivity: [0.25, 4],
  shakeSwings: [2, 8],
  shakeMinAmpDeg: [1, 120],
  shakeMaxAmpDeg: [5, 360],
  shakeReversalDeg: [0.5, 60],
  shakeSuspectDeg: [0.5, 90],
  shakeMinSwingMs: [0, 2000],
  shakeMaxSwingMs: [50, 5000],
  shakeMaxDwellMs: [50, 5000],
  shakeMaxTotalMs: [200, 20_000],
  shakeMinRateDps: [1, 3000],
  shakeMaxPitchRatio: [0.05, 10],
  shakeAmpRatio: [1, 20],
  shakeGuardMs: [0, 5000],
  shakeCooldownMs: [0, 20_000],
  wearSettleMs: [0, 30_000],
  recoveryPresses: [3, 10],
  recoveryWindowMs: [500, 20_000],
  sensorStaleMs: [500, 60_000],
};

const MAX_NEUTRAL = 1e6;
const MIN_PRESS_MS = 400;

const isAxis = (v: unknown): v is Axis => v === 'x' || v === 'y' || v === 'z';
const isSign = (v: unknown): v is 1 | -1 => v === 1 || v === -1;

// Accepts anything (stored JSON may be old or corrupt) and always returns a
// complete, safe Settings object. Bad fields fall back to `base`. Values that
// are each in range can still make a gesture impossible together, and a shake
// or recovery that can never fire would trap the app, so those are repaired too.
export function sanitizeSettings(input: unknown, base: Readonly<Settings> = DEFAULT_SETTINGS): Settings {
  const src = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const out: Settings = { ...base };
  for (const key of Object.keys(RANGES) as NumberKey[]) {
    const v = src[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const [lo, hi] = RANGES[key];
    out[key] = Math.min(hi, Math.max(lo, v));
  }
  if (src.imuMode === 'orientation' || src.imuMode === 'rate') out.imuMode = src.imuMode;
  if (isAxis(src.pitchAxis)) out.pitchAxis = src.pitchAxis;
  if (isAxis(src.yawAxis)) out.yawAxis = src.yawAxis;
  if (isSign(src.pitchSign)) out.pitchSign = src.pitchSign;
  if (isSign(src.yawSign)) out.yawSign = src.yawSign;
  if (typeof src.tiltEnabled === 'boolean') out.tiltEnabled = src.tiltEnabled;
  if (typeof src.trustWearSensor === 'boolean') out.trustWearSensor = src.trustWearSensor;
  if (src.neutralPitch === null) out.neutralPitch = null;
  else if (typeof src.neutralPitch === 'number' && Math.abs(src.neutralPitch) <= MAX_NEUTRAL) out.neutralPitch = src.neutralPitch;

  out.imuPace = Math.round(out.imuPace / 100) * 100; // ImuReportPace only has steps of 100
  out.shakeSwings = Math.round(out.shakeSwings);
  out.recoveryPresses = Math.round(out.recoveryPresses);
  if (out.pitchAxis === out.yawAxis) {
    out.pitchAxis = DEFAULT_SETTINGS.pitchAxis;
    out.yawAxis = DEFAULT_SETTINGS.yawAxis;
  }
  // Keep the tilt bands ordered: dead zone < exit point < threshold < limit.
  const floor = out.deadZoneDeg + out.tiltHysteresisDeg + 1;
  out.tiltUpDeg = Math.max(out.tiltUpDeg, floor);
  out.tiltDownDeg = Math.max(out.tiltDownDeg, floor);
  out.tiltMaxDeg = Math.max(out.tiltMaxDeg, Math.max(out.tiltUpDeg, out.tiltDownDeg) + 1);
  // Drift tracking must stop before the point where a tilt still counts as held.
  out.driftWindowDeg = Math.min(out.driftWindowDeg, Math.min(out.tiltUpDeg, out.tiltDownDeg) - out.tiltHysteresisDeg);
  // Keep a shake reachable. Sensitivity divides the minimums.
  out.shakeMaxAmpDeg = Math.max(out.shakeMaxAmpDeg, out.shakeMinAmpDeg / out.shakeSensitivity + 1, out.shakeReversalDeg + 1);
  out.shakeMaxSwingMs = Math.max(out.shakeMaxSwingMs, out.shakeMinSwingMs + 1);
  out.shakeMaxTotalMs = Math.max(out.shakeMaxTotalMs, Math.ceil(out.shakeSwings * out.shakeMinSwingMs * 1.5));
  out.shakeMinRateDps = Math.min(out.shakeMinRateDps, (0.5 * out.shakeSensitivity * out.shakeMaxAmpDeg * 1000) / Math.max(out.shakeMinSwingMs, 1));
  // Keep touch recovery reachable by a person.
  out.recoveryWindowMs = Math.max(out.recoveryWindowMs, out.recoveryPresses * MIN_PRESS_MS);
  return out;
}
