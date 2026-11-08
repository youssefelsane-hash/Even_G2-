import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { expectationOf, parseImuLog, replayLog } from '../src/core/imuReplay.ts';
import { ImuLogger } from '../src/core/imuLogger.ts';
import { LEGACY_SETTINGS } from '../src/core/population.ts';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/core/settings.ts';
import { stream, tilt } from '../src/core/synth.ts';

// Replays recorded traces in the raw logger's format. The traces in
// test/traces are SYNTHETIC (tools/make-traces.ts). Real Phase 0 logs can be
// dropped in next to them, with an optional <name>.settings.json from the
// calibration, and the same test then checks them against their marks.

const dir = path.join(import.meta.dirname, 'traces');
const traces = readdirSync(dir).filter((f) => f.endsWith('.csv') || (f.endsWith('.json') && !f.endsWith('.settings.json')));

function settingsFor(file: string) {
  const side = path.join(dir, file.replace(/\.(csv|json)$/, '.settings.json'));
  try { return sanitizeSettings(JSON.parse(readFileSync(side, 'utf8'))); } catch { return sanitizeSettings(DEFAULT_SETTINGS); }
}

test('there are sample traces to replay', () => {
  assert.ok(traces.length >= 3, traces.join(', '));
});

for (const file of traces) {
  test(`replay ${file}: every marked segment shows the expected gestures`, () => {
    const log = parseImuLog(readFileSync(path.join(dir, file), 'utf8'));
    assert.equal(log.badLines, 0);
    assert.ok(log.samples.length > 500);
    const report = replayLog(log, settingsFor(file));
    const bad = report.segments.filter((s) => !s.ok).map((s) => `${s.mark}: shakes ${s.shakes} up ${s.up} down ${s.down}`);
    assert.deepEqual(bad, []);
    assert.ok(report.passed >= 10);
  });
}

test('replay catches a regression: the legacy settings fire a shake in the glance segment', () => {
  const log = parseImuLog(readFileSync(path.join(dir, 'synthetic-session-50hz.csv'), 'utf8'));
  const legacy = replayLog(log, LEGACY_SETTINGS);
  const glance = legacy.segments.find((s) => s.mark === 'glance');
  assert.ok(glance && glance.shakes > 0 && !glance.ok, 'the old weakness shows up in the replay');
});

test('logger CSV and JSON exports parse back to the same samples and notes', () => {
  const log = new ImuLogger();
  log.start();
  log.note(0, 'mark tilt down');
  for (const s of stream(tilt(-26), { seed: 4 })) log.push(s);
  log.note(5000, 'note with "quotes", and a comma');
  const csv = parseImuLog(log.toCsv());
  const json = parseImuLog(log.toJson());
  assert.equal(csv.samples.length, log.summary().samples);
  assert.deepEqual(csv.samples, json.samples);
  assert.deepEqual(csv.notes, json.notes);
  assert.equal(csv.notes[1].note, 'note with "quotes", and a comma');
});

test('unreadable lines are counted, not fatal', () => {
  const log = parseImuLog('t_ms,x,y,z,note\nabc,1,2,3,\n10,1,2,3,\n20,,,,\n');
  assert.equal(log.samples.length, 1);
  assert.equal(log.badLines, 2);
});

test('mark names map to expectations; unknown marks are ignored', () => {
  assert.equal(expectationOf('mark shake'), 'shake');
  assert.equal(expectationOf('mark tilt up'), 'up');
  assert.equal(expectationOf('mark walking'), 'none');
  assert.equal(expectationOf('mark phone locked'), 'ignore');
  assert.equal(expectationOf('wear true'), null);
});
