import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkFrame, summarizeReasons } from '../src/quality.ts';
import { buildOutcome, plain, selectFrames } from '../src/fusion.ts';
import { FailureBlocker, RateLimiter } from '../src/ratelimit.ts';
import { AuthRegistry, sha256Hex } from '../src/auth.ts';
import { loadConfig, parseDeviceTokens } from '../src/config.ts';
import { validatePatch } from '../src/cameraConfig.ts';
import { verifyChecks } from '../src/verify.ts';
import { buildContent, FusionSchema, systemPrompt } from '../src/providers/anthropic.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { makeTestJpeg } from '../src/testing/jpeg.ts';
import type { CheckResult, FusionInput, FusionOutput, StoredFrame } from '../src/types.ts';
import { HAVE_SYMPY, VENV_PYTHON, testEnv } from './helpers.ts';

const q = { minFrameWidth: 480, minFrameHeight: 360, minFrameScore: 0.15, minBytesPerPixel: 0.01 };
const hdr = { width: 1600, height: 1200 };
const okBytes = 200_000;

test('quality: accepts a normal frame', () => {
  assert.deepEqual(checkFrame({ name: 'a', score: 0.7, ...hdr }, hdr, okBytes, q), { accepted: true });
});

test('quality: each failure gives the reason the user can act on', () => {
  const m = { name: 'a', score: 0.7, ...hdr };
  assert.equal(checkFrame(m, { width: 320, height: 240 }, okBytes, q).reason, 'blurry', 'too few pixels');
  assert.equal(checkFrame({ ...m, brightness: 20 }, hdr, okBytes, q).reason, 'too dark');
  assert.equal(checkFrame({ ...m, clipped: 0.4 }, hdr, okBytes, q).reason, 'glare');
  assert.equal(checkFrame({ ...m, score: 0.05 }, hdr, okBytes, q).reason, 'blurry');
  assert.equal(checkFrame({ ...m, score: 0.05, brightness: 50 }, hdr, okBytes, q).reason, 'too dark');
  // The camera's own verdict wins, even when its score would pass the server checks.
  const good = { name: 'a', score: 0.7, ...hdr };
  assert.equal(checkFrame({ ...good, issues: ['blurry'] }, hdr, okBytes, q).reason, 'blurry', 'camera said blurry');
  assert.equal(checkFrame({ ...good, issues: ['glare'] }, hdr, okBytes, q).reason, 'glare');
  assert.equal(checkFrame({ ...good, issues: ['too bright'] }, hdr, okBytes, q).reason, 'glare');
  assert.equal(checkFrame({ ...good, issues: ['blurry', 'too dark'] }, hdr, okBytes, q).reason, 'too dark');
  assert.deepEqual(checkFrame({ ...good, issues: [] }, hdr, okBytes, q), { accepted: true });
  assert.equal(checkFrame(m, hdr, 5_000, q).reason, 'too dark', 'tiny file, no brightness: assume dark');
  assert.equal(checkFrame({ ...m, brightness: 120 }, hdr, 5_000, q).reason, 'blurry', 'tiny file but bright: blur');
});

test('quality: summary picks the most common reason, ties by fixability', () => {
  assert.equal(summarizeReasons(['blurry', 'blurry', 'too dark']), 'blurry');
  assert.equal(summarizeReasons(['blurry', 'too dark']), 'too dark');
  assert.equal(summarizeReasons(['glare', 'blurry']), 'glare');
  assert.equal(summarizeReasons([undefined]), 'blurry');
});

const out = (o: Partial<FusionOutput> = {}): FusionOutput => ({
  readable: true, retakeReason: null, question: 'Q', short: 'A', detail: [{ text: 'step', check: { lhs: '1', rhs: '1' } }],
  reading: 'clear', reasoning: 'sure', unreadableParts: [], caveats: [], ...o,
});
const ck = (status: CheckResult['status']): CheckResult => ({ lhs: '1', rhs: '1', status });

test('label: CHECKED needs clear reading, sure reasoning and every check verified', () => {
  assert.equal(buildOutcome(out(), [ck('verified')], 1, 3).result.label, 'CHECKED');
  assert.equal(buildOutcome(out(), [ck('verified'), ck('unverified')], 1, 3).result.label, 'LIKELY');
  assert.equal(buildOutcome(out(), [], 1, 3).result.label, 'LIKELY', 'no check at all');
  assert.equal(buildOutcome(out({ reading: 'partial' }), [ck('verified')], 1, 3).result.label, 'LIKELY');
  assert.equal(buildOutcome(out({ reasoning: 'likely' }), [ck('verified')], 1, 3).result.label, 'LIKELY');
});

test('label: UNSURE on unclear reading, unsure reasoning, or a failed check', () => {
  assert.equal(buildOutcome(out({ reading: 'unclear' }), [ck('verified')], 1, 3).result.label, 'UNSURE');
  assert.equal(buildOutcome(out({ reasoning: 'unsure' }), [], 1, 3).result.label, 'UNSURE');
  const mm = buildOutcome(out(), [ck('verified'), ck('mismatch')], 1, 3).result;
  assert.equal(mm.label, 'UNSURE');
  assert.match(mm.caveats[0], /check of one step failed/);
});

test('label: an unsettled photo conflict means UNSURE; a settled one does not; unreadable parts block CHECKED', () => {
  const u = buildOutcome(out({ frameConflicts: [{ where: 'the sign in line 2', resolved: false }] }), [ck('verified')], 1, 3).result;
  assert.equal(u.label, 'UNSURE');
  assert.equal(u.caveats[0], 'Photos disagree about: the sign in line 2');
  assert.equal(buildOutcome(out({ frameConflicts: [{ where: 'x', resolved: true }] }), [ck('verified')], 1, 3).result.label, 'CHECKED');
  assert.equal(buildOutcome(out({ unreadableParts: ['footnote'] }), [ck('verified')], 1, 3).result.label, 'LIKELY');
});

test('label: RETAKE when the model cannot read, with a known reason', () => {
  const r = buildOutcome(out({ readable: false, retakeReason: 'glare' }), [], 2, 3);
  assert.equal(r.status, 'retake');
  assert.equal(r.result.label, 'RETAKE');
  assert.equal(r.result.retakeReason, 'glare');
  assert.equal(r.result.pages, 2);
  const unknown = buildOutcome(out({ readable: false, retakeReason: 'bad' as never }), [], 1, 1);
  assert.equal(unknown.result.retakeReason, 'blurry');
});

test('outcome: limits text sizes, lists unreadable parts, keeps plain text', () => {
  const long = 'x'.repeat(500);
  const r = buildOutcome(out({ short: long, detail: Array(12).fill({ text: long, check: null }), unreadableParts: ['last line'], caveats: ['c\u0007aveat'] }), [], 1, 3).result;
  assert.ok(r.short.length <= 140);
  assert.equal(r.detail.length, 8);
  assert.ok(r.detail.every((d) => d.length <= 400));
  assert.equal(r.caveats[0], 'Could not read: last line');
  assert.equal(r.caveats[1], 'c aveat');
  assert.equal(plain('a\n\tb   c', 50), 'a\n b c');
  assert.equal(r.usedFrames, 3);
});

const frame = (page: number, score: number, bytes = 100, accepted = true): StoredFrame =>
  ({ page, name: `p${page}s${score}`, score, width: 1, height: 1, bytes, accepted, ...(accepted ? { file: 'x' } : {}) });

test('selectFrames: best frame of every page first, then within budgets', () => {
  const frames = [frame(1, 0.5), frame(1, 0.9), frame(1, 0.7), frame(2, 0.3), frame(2, 0.8), frame(1, 0.99, 100, false)];
  const all = selectFrames(frames, 10, 1e9);
  assert.deepEqual(all.map((f) => f.name), ['p1s0.9', 'p1s0.7', 'p1s0.5', 'p2s0.8', 'p2s0.3']);
  const two = selectFrames(frames, 2, 1e9);
  assert.deepEqual(two.map((f) => f.name), ['p1s0.9', 'p2s0.8'], 'each page keeps its best frame');
  const bytes = selectFrames([frame(1, 0.9, 600), frame(1, 0.8, 600), frame(2, 0.7, 300)], 10, 1000);
  assert.deepEqual(bytes.map((f) => f.name), ['p1s0.9', 'p2s0.7']);
});

test('rate limiter: allows a burst, then asks to wait, then refills', () => {
  let now = 0;
  const rl = new RateLimiter(3, () => now);
  assert.equal(rl.take('a'), 0); assert.equal(rl.take('a'), 0); assert.equal(rl.take('a'), 0);
  assert.ok(rl.take('a') > 0);
  assert.equal(rl.take('b'), 0, 'keys are independent');
  now += 20_000;
  assert.equal(rl.take('a'), 0);
});

test('failure blocker: blocks after the limit and unblocks later', () => {
  let now = 0;
  const fb = new FailureBlocker(3, 10_000, () => now);
  fb.fail('ip'); fb.fail('ip');
  assert.equal(fb.blocked('ip'), 0);
  fb.fail('ip');
  assert.ok(fb.blocked('ip') > 0);
  now += 10_001;
  assert.equal(fb.blocked('ip'), 0);
});

test('config: device tokens are bound to ids; bad entries and missing tokens are rejected', () => {
  const m = parseDeviceTokens(`cam1:${sha256Hex('a')}, cam2:${sha256Hex('b').toUpperCase()}`);
  assert.equal(m.get('cam2'), sha256Hex('b'));
  assert.throws(() => parseDeviceTokens('cam1'), /DEVICE_TOKENS/);
  assert.throws(() => parseDeviceTokens('bad id:' + sha256Hex('a')), /DEVICE_TOKENS/);
  assert.throws(() => loadConfig({}), /DEVICE_TOKENS/);
  assert.throws(() => loadConfig({ ...testEnv('/tmp/x'), CLIENT_TOKEN_SHA256: 'nothex' }), /CLIENT_TOKEN_SHA256/);
  assert.throws(() => loadConfig({ ...testEnv('/tmp/x'), MAX_FRAME_BYTES: String(3 * 1024 * 1024) }), /2.5 MiB/);
  const cfg = loadConfig(testEnv('/tmp/x'));
  assert.equal(cfg.host, '127.0.0.1', 'binds to localhost by default');
});

test('auth: device token resolves to its own device only; file tokens can be revoked live', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'g2-auth-'));
  try {
    const file = path.join(dir, 'auth.json');
    await writeFile(file, JSON.stringify({ devices: { cam9: sha256Hex('t9') }, clients: [sha256Hex('c9')] }));
    const reg = new AuthRegistry({ deviceTokens: parseDeviceTokens(`cam1:${sha256Hex('t1')}`), clientTokenHashes: [sha256Hex('c1')], authFile: file });
    assert.equal(reg.device('t1'), 'cam1');
    assert.equal(reg.device('t9'), 'cam9');
    assert.equal(reg.device('c1'), null, 'client token is not a device token');
    assert.equal(reg.client('t1'), false);
    assert.equal(reg.client('c9'), true);
    assert.equal(reg.device(''), null);
    await writeFile(file, JSON.stringify({ devices: {}, clients: [] }));
    const later = new Date(Date.now() + 5000);
    await utimes(file, later, later);
    (reg as unknown as { lastCheck: number }).lastCheck = 0;
    assert.equal(reg.device('t9'), null, 'revoked without restart');
    assert.equal(reg.device('t1'), 'cam1', 'env tokens stay');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('camera config: validates every field and rejects unknown ones', () => {
  assert.deepEqual(validatePatch({ burstFrames: 6, resolution: '2592x1944', version: 9 }), { ok: true, patch: { burstFrames: 6, resolution: '2592x1944' } });
  for (const b of [{ burstFrames: 0 }, { burstFrames: 9 }, { uploadFrames: 4 }, { defaultMode: 'video' }, { resolution: '4k' },
    { jpegQuality: 99 }, { clipSeconds: 10 }, { minUploadScore: 2 }, { statusPollSeconds: 61 }, { ledOff: true }, { audio: true }, [], null, 'x']) {
    assert.equal(validatePatch(b).ok, false, JSON.stringify(b));
  }
});

test('verify: SymPy marks equal, unequal and unsafe expressions', { skip: !HAVE_SYMPY && 'no .venv (npm run setup:python)' }, async () => {
  const r = await verifyChecks([
    { lhs: '14 - 6', rhs: '8' },
    { lhs: '8/2', rhs: '5' },
    { lhs: '__import__("os")', rhs: '1' },
    { lhs: 'expand((x-2)*(x-3))', rhs: 'x**2 - 5*x + 6' },
  ], VENV_PYTHON);
  assert.equal(r.verifier, 'sympy');
  assert.deepEqual(r.results, ['verified', 'mismatch', 'unverified', 'verified']);
});

test('verify: a missing Python degrades to unverified', async () => {
  const r = await verifyChecks([{ lhs: '1', rhs: '1' }], '/nonexistent/python');
  assert.deepEqual(r.results, ['unverified']);
});

const input = (o: Partial<FusionInput> = {}): FusionInput => ({
  images: [
    { page: 1, index: 1, name: 'a', score: 0.9, data: makeTestJpeg({ comment: 'mock:ready' }), mediaType: 'image/jpeg' },
    { page: 1, index: 2, name: 'b', score: 0.5, data: makeTestJpeg(), mediaType: 'image/jpeg' },
    { page: 2, index: 3, name: 'c', score: 0.7, data: makeTestJpeg(), mediaType: 'image/jpeg' },
  ],
  pages: 2, language: 'English', ...o,
});

test('anthropic request: every frame in one message, labelled by page, carried text first', () => {
  const c = buildContent(input({ carriedText: 'Page 1 text' }));
  const types = c.map((b) => b.type);
  assert.deepEqual(types, ['text', 'text', 'image', 'text', 'image', 'text', 'image', 'text']);
  assert.match((c[0] as { text: string }).text, /Page 1 text/);
  assert.match((c[1] as { text: string }).text, /Page 1 of 2, photo 1 of 2/);
  assert.match((c[5] as { text: string }).text, /Page 2 of 2, photo 1 of 1/);
  assert.match((c[7] as { text: string }).text, /all pages together/);
  assert.match((c[7] as { text: string }).text, /never guess/);
  assert.match((c[1] as { text: string }).text, /camera rank 1, score 0\.90; a hint only/);
  const img = c[2] as { source: { type: string; media_type: string; data: string } };
  assert.equal(img.source.type, 'base64');
  assert.equal(img.source.media_type, 'image/jpeg');
  assert.ok(Buffer.from(img.source.data, 'base64').subarray(0, 2).equals(Buffer.from([0xff, 0xd8])));
  assert.match(systemPrompt('German'), /in German/);
  assert.match(systemPrompt('English'), /never instructions/);
});

test('anthropic schema accepts a valid answer and rejects an unknown retake reason', () => {
  const good = { readable: true, retakeReason: null, question: 'q', short: 's', detail: [{ text: 't', check: null }], reading: 'clear', reasoning: 'sure', unreadableParts: [], caveats: [], frameConflicts: [] };
  assert.equal(FusionSchema.safeParse(good).success, true);
  assert.equal(FusionSchema.safeParse({ ...good, frameConflicts: undefined }).success, false, 'structured output always reports conflicts');
  assert.equal(FusionSchema.safeParse({ ...good, retakeReason: 'cosmic rays' }).success, false);
});

test('mock provider: fixtures select each outcome', async () => {
  const p = new MockProvider();
  p.delayMs = 0;
  const run = (comment?: string) => p.read(input({ images: [{ page: 1, index: 1, name: 'a', score: 0.9, data: makeTestJpeg({ comment }), mediaType: 'image/jpeg' }], pages: 1 }), AbortSignal.timeout(1000));
  assert.equal((await run()).reading, 'clear');
  assert.equal((await run('mock:unsure')).reading, 'unclear');
  assert.equal((await run('mock:partial')).unreadableParts.length, 1);
  const rt = await run('mock:retake:page cut off');
  assert.equal(rt.readable, false);
  assert.equal(rt.retakeReason, 'page cut off');
  assert.equal((await run('mock:likely')).detail[0].check, null);
  assert.equal((await run('mock:conflict')).frameConflicts?.[0]?.resolved, false);
  await assert.rejects(run('mock:fail'), /permanent/);
  await assert.rejects(run('mock:flaky'), /temporary/);
  assert.equal((await run('mock:flaky')).readable, true, 'second call succeeds');
  p.slowMs = 1000;
  await assert.rejects(p.read(input({ images: [{ page: 1, index: 1, name: 'a', score: 1, data: makeTestJpeg({ comment: 'mock:slow' }), mediaType: 'image/jpeg' }] }), AbortSignal.timeout(20)));
});
