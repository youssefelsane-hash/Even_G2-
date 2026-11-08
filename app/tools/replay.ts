// Replays a raw IMU log (CSV or JSON from the phone panel's logger) through the
// gesture engine and compares the gestures with the marks pressed while
// recording. Usage:
//   node tools/replay.ts <log.csv|log.json> [settings.json]
// Without a settings file the defaults are used. Real logs stay on your
// computer: the .gitignore keeps imu-log-* files out of the repository.
import { readFileSync } from 'node:fs';
import { parseImuLog, replayLog } from '../src/core/imuReplay.ts';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/core/settings.ts';

const [file, settingsFile] = process.argv.slice(2);
if (!file) {
  console.error('usage: node tools/replay.ts <log.csv|log.json> [settings.json]');
  process.exit(2);
}
const settings = sanitizeSettings(settingsFile ? JSON.parse(readFileSync(settingsFile, 'utf8')) : DEFAULT_SETTINGS);
const log = parseImuLog(readFileSync(file, 'utf8'));
const report = replayLog(log, settings);
console.log(`${report.samples} samples, ${log.notes.length} notes, ${log.badLines} unreadable lines`);
for (const s of report.segments) {
  console.log(`${s.ok ? 'ok  ' : 'FAIL'} ${s.mark.padEnd(14)} ${((s.end - s.start) / 1000).toFixed(1).padStart(6)} s  shakes ${s.shakes}  up ${s.up}  down ${s.down}  (expected ${s.expect})`);
}
for (const e of report.events) {
  if (e.type === 'shake' || e.type === 'tiltStart') console.log(`  ${e.type}${e.type === 'tiltStart' ? ` ${e.direction}` : ''} at ${((e.t - (log.samples[0]?.t ?? 0)) / 1000).toFixed(2)} s, confidence ${e.confidence.toFixed(2)}`);
}
console.log(`${report.passed} segments as expected, ${report.failed} not`);
process.exit(report.failed ? 1 : 0);
