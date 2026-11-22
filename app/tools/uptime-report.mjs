#!/usr/bin/env node
// Reads the dev log the glasses app sends to the Mac (app/.devlog/session.jsonl)
// and reports whether the app stayed alive and connected over a period, for
// example a long test with the phone locked in a pocket.
//
//   node tools/uptime-report.mjs [since HH:MM[:SS] UTC] [until HH:MM[:SS] UTC]
//
// What it shows: the app's once-a-second status line (gaps mean the app was
// paused or the phone's network dropped), app restarts, glasses connection and
// wear changes, server connection changes, and motion-sensor gaps.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LOG = fileURLToPath(new URL('../.devlog/session.jsonl', import.meta.url));
const today = new Date().toISOString().slice(0, 10);
const at = (hm) => (hm ? Date.parse(`${today}T${hm.length === 5 ? `${hm}:00` : hm}Z`) : NaN);
const since = at(process.argv[2]) || Date.now() - 60 * 60_000;
const until = at(process.argv[3]) || Date.now();
const hms = (t) => new Date(t).toISOString().slice(11, 19);
const dur = (ms) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)} min ${Math.floor((ms % 60_000) / 1000)} s` : `${Math.round(ms / 1000)} s`);

const rows = [];
for (const line of readFileSync(LOG, 'utf8').split('\n')) {
  if (!line.startsWith('{"at":"')) continue;
  const t = Date.parse(line.slice(7, 31));
  if (t < since || t > until) continue;
  try { rows.push({ t, ...JSON.parse(line) }); } catch { /* partial line */ }
}
if (!rows.length) { console.log(`No log lines between ${hms(since)} and ${hms(until)} UTC.`); process.exit(0); }

const status = rows.filter((r) => r.kind === 'status');
const imu = rows.filter((r) => r.kind === 'imu');
const gaps = (list, minMs) => {
  const out = [];
  for (let i = 1; i < list.length; i++) if (list[i].t - list[i - 1].t >= minMs) out.push([list[i - 1].t, list[i].t]);
  return out;
};

console.log(`Window ${hms(rows[0].t)} to ${hms(rows.at(-1).t)} UTC (${dur(rows.at(-1).t - rows[0].t)})`);
console.log(`App status lines: ${status.length} (one a second when alive)`);
const statusGaps = gaps(status, 5000);
console.log(statusGaps.length ? `App silent ${statusGaps.length}x:` : 'App never went silent for 5 s or more.');
for (const [a, b] of statusGaps) console.log(`  ${hms(a)} -> ${hms(b)}  (${dur(b - a)})`);

const restarts = rows.filter((r) => r.kind === 'boot');
console.log(restarts.length ? `App restarted ${restarts.length}x: ${restarts.map((r) => hms(r.t)).join(', ')}` : 'No app restarts.');

let prev = '';
const changes = [];
for (const r of status) {
  const k = `glasses ${r.connected ? 'connected' : 'NOT connected'}, wear ${r.wear}, ${r.state}`;
  if (k !== prev) changes.push(`  ${hms(r.t)}  ${k}`);
  prev = k;
}
console.log('Glasses state changes:');
console.log(changes.join('\n'));

const backend = rows.filter((r) => r.kind === 'console' && /^BACKEND /.test(r.text ?? ''));
console.log(backend.length ? 'Server connection changes:' : 'Server connection: no changes logged.');
for (const r of backend) console.log(`  ${hms(r.t)}  ${r.text}`);

if (imu.length) {
  const imuGaps = gaps(imu, 2000);
  console.log(`Motion samples: ${imu.length}; gaps of 2 s or more: ${imuGaps.length}`);
  for (const [a, b] of imuGaps.slice(0, 10)) console.log(`  ${hms(a)} -> ${hms(b)}  (${dur(b - a)})`);
} else {
  console.log('Motion samples: none (sensor off, which is normal while the text is hidden and tilt is off).');
}
