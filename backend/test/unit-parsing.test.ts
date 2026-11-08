import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundaryFrom, MultipartError, parseMultipart } from '../src/multipart.ts';
import { JpegError, readJpeg } from '../src/jpeg.ts';
import { makeTestJpeg } from '../src/testing/jpeg.ts';
import { parseCapture, RequestError, validateMeta } from '../src/captureRequest.ts';
import { loadConfig } from '../src/config.ts';
import { captureBody, multipart, testEnv } from './helpers.ts';

const cfg = loadConfig(testEnv('/tmp/unused'));

test('boundary: quoted, unquoted, missing, wrong type', () => {
  assert.equal(boundaryFrom('multipart/form-data; boundary=abc'), 'abc');
  assert.equal(boundaryFrom('multipart/form-data; charset=utf-8; boundary="a b"'), 'a b');
  assert.throws(() => boundaryFrom('multipart/form-data'), MultipartError);
  assert.throws(() => boundaryFrom('image/jpeg'), MultipartError);
  assert.throws(() => boundaryFrom(undefined), MultipartError);
  assert.throws(() => boundaryFrom(`multipart/form-data; boundary=${'x'.repeat(71)}`), MultipartError);
});

test('multipart: parses parts with binary data containing CRLF and dashes', () => {
  const bin = Buffer.from([0x0d, 0x0a, 0x2d, 0x2d, 0xff, 0x00, 0x0d, 0x0a]);
  const { body, contentType } = multipart([{ name: 'meta', type: 'application/json', data: '{"a":1}' }, { name: 'frame0', type: 'image/jpeg', data: bin }], 'BOUND');
  const parts = parseMultipart(body, boundaryFrom(contentType));
  assert.equal(parts.length, 2);
  assert.equal(parts[0].name, 'meta');
  assert.equal(parts[0].data.toString(), '{"a":1}');
  assert.equal(parts[1].filename, 'frame0.jpg');
  assert.equal(parts[1].contentType, 'image/jpeg');
  assert.deepEqual([...parts[1].data], [...bin]);
});

test('multipart: preamble is allowed; truncation and garbage are rejected', () => {
  const { body } = multipart([{ name: 'meta', type: 'text/plain', data: 'x' }], 'B');
  assert.equal(parseMultipart(Buffer.concat([Buffer.from('preamble\r\n'), body]), 'B').length, 1);
  assert.throws(() => parseMultipart(body.subarray(0, body.length - 9), 'B'), /truncated/);
  assert.throws(() => parseMultipart(Buffer.from('no boundary here'), 'B'), MultipartError);
  assert.throws(() => parseMultipart(Buffer.from('--B\r\nbad header line\r\n\r\nx\r\n--B--'), 'B'), MultipartError);
  assert.throws(() => parseMultipart(Buffer.from('--B\r\nContent-Type: text/plain\r\n\r\nx\r\n--B--'), 'B'), /without a name/);
  assert.throws(() => parseMultipart(Buffer.from('--Bjunk\r\n'), 'B'), /malformed boundary/);
  const many = multipart(Array.from({ length: 9 }, (_, i) => ({ name: `p${i}`, type: 'text/plain', data: 'x' })), 'B');
  assert.throws(() => parseMultipart(many.body, 'B'), /too many parts/);
});

test('jpeg: reads dimensions and comments from the header', () => {
  const j = makeTestJpeg({ width: 2048, height: 1536, comment: 'mock:unsure' });
  const info = readJpeg(j);
  assert.equal(info.width, 2048);
  assert.equal(info.height, 1536);
  assert.deepEqual(info.comments, ['mock:unsure']);
  assert.equal(info.progressive, false);
});

test('jpeg: rejects non-JPEG, truncated and headerless data', () => {
  assert.throws(() => readJpeg(Buffer.from('hello world, not an image')), JpegError);
  const j = makeTestJpeg();
  assert.throws(() => readJpeg(j.subarray(0, j.length - 2)), /truncated/);
  assert.throws(() => readJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0, 0, 0, 0])), JpegError);
  // Segment length pointing past the end.
  const broken = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x7f, 0xff, 0x08, 0, 0, 0, 0, 0xff, 0xd9]);
  assert.throws(() => readJpeg(broken), JpegError);
  // Trailing zero padding after EOI is accepted.
  assert.equal(readJpeg(Buffer.concat([j, Buffer.alloc(10)])).width, 1600);
});

test('meta validation: accepts a good burst and rejects each bad field', () => {
  const good = { mode: 'burst', capturedAt: new Date().toISOString(), frames: [{ name: 'a', score: 0.5, width: 10, height: 10 }] };
  assert.equal(validateMeta(good, 3).mode, 'burst');
  assert.equal(validateMeta({ ...good, appendTo: 'previous' }, 3).appendTo, 'previous');
  const bads: Array<Record<string, unknown>> = [
    { ...good, mode: 'video' },
    { ...good, capturedAt: 'yesterday' },
    { ...good, battery: 101 },
    { ...good, appendTo: '../etc' },
    { ...good, frames: [] },
    { ...good, frames: Array(4).fill(good.frames[0]).map((f, i) => ({ ...f, name: `n${i}` })) },
    { ...good, mode: 'single', frames: [good.frames[0], { ...good.frames[0], name: 'b' }] },
    { ...good, frames: [{ ...good.frames[0], score: 2 }] },
    { ...good, frames: [{ ...good.frames[0], name: '../x' }] },
    { ...good, frames: [{ ...good.frames[0], width: 0 }] },
    { ...good, frames: [{ ...good.frames[0], brightness: 300 }] },
    { ...good, frames: [{ ...good.frames[0], clipped: -1 }] },
    { ...good, frames: [{ ...good.frames[0], issues: 'blurry' }] },
    { ...good, frames: [{ ...good.frames[0], issues: [3] }] },
    { ...good, frames: [good.frames[0], good.frames[0]] },
  ];
  for (const b of bads) assert.throws(() => validateMeta(b, 3), RequestError, JSON.stringify(b).slice(0, 80));
  // Camera issues: known names kept, unknown ones ignored, none means no field.
  assert.deepEqual(validateMeta({ ...good, frames: [{ ...good.frames[0], issues: ['blurry', 'shiny', 'glare'] }] }, 3).frames[0].issues, ['glare', 'blurry']);
  assert.equal(validateMeta({ ...good, frames: [{ ...good.frames[0], issues: ['shiny'] }] }, 3).frames[0].issues, undefined);
  assert.throws(() => validateMeta('string', 3), RequestError);
  assert.throws(() => validateMeta(null, 3), RequestError);
});

test('parseCapture: good body yields frames with header dimensions and verdicts', () => {
  const { body, contentType } = captureBody({ frames: [{}, { meta: { brightness: 10 } }] });
  const r = parseCapture(body, contentType, cfg);
  assert.equal(r.frames.length, 2);
  assert.equal(r.frames[0].accepted, true);
  assert.equal(r.frames[1].accepted, false);
  assert.equal(r.frames[1].rejectReason, 'too dark');
});

function statusOf(fn: () => unknown): number {
  try { fn(); } catch (e) { if (e instanceof RequestError) return e.status; throw e; }
  return 200;
}

test('parseCapture: malformed bodies map to 400, 413 and 415', () => {
  const meta = JSON.stringify({ mode: 'single', capturedAt: new Date().toISOString(), frames: [{ name: 'a', score: 0.5, width: 1600, height: 1200 }] });
  const jpeg = makeTestJpeg();
  const mp = (parts: Array<{ name: string; type: string; data: Buffer | string }>) => multipart(parts, 'X');
  const p = (parts: Array<{ name: string; type: string; data: Buffer | string }>) => { const m = mp(parts); return () => parseCapture(m.body, m.contentType, cfg); };
  assert.equal(statusOf(p([{ name: 'frame0', type: 'image/jpeg', data: jpeg }])), 400, 'missing meta');
  assert.equal(statusOf(p([{ name: 'meta', type: 'application/json', data: '{not json' }, { name: 'frame0', type: 'image/jpeg', data: jpeg }])), 400, 'bad json');
  assert.equal(statusOf(p([{ name: 'meta', type: 'application/json', data: meta }, { name: 'meta', type: 'application/json', data: meta }])), 400, 'two metas');
  assert.equal(statusOf(p([{ name: 'meta', type: 'application/json', data: meta }])), 400, 'no frames');
  assert.equal(statusOf(p([{ name: 'meta', type: 'application/json', data: meta }, { name: 'frame1', type: 'image/jpeg', data: jpeg }])), 400, 'wrong frame index');
  assert.equal(statusOf(p([{ name: 'meta', type: 'application/json', data: meta }, { name: 'frame0', type: 'image/jpeg', data: jpeg }, { name: 'frame0', type: 'image/jpeg', data: jpeg }])), 400, 'duplicate frame');
  assert.equal(statusOf(p([{ name: 'meta', type: 'application/json', data: meta }, { name: 'audio', type: 'audio/wav', data: 'x' }])), 400, 'unknown part');
  assert.equal(statusOf(p([{ name: 'meta', type: 'application/json', data: meta }, { name: 'frame3', type: 'image/jpeg', data: jpeg }])), 400, 'frame3 not allowed');
  assert.equal(statusOf(p([{ name: 'meta', type: 'application/json', data: meta }, { name: 'frame0', type: 'image/png', data: jpeg }])), 415, 'png type');
  assert.equal(statusOf(p([{ name: 'meta', type: 'application/json', data: meta }, { name: 'frame0', type: 'image/jpeg', data: 'GIF89a not a jpeg' }])), 415, 'not jpeg bytes');
  assert.equal(statusOf(p([{ name: 'meta', type: 'application/json', data: meta }, { name: 'frame0', type: 'image/jpeg', data: makeTestJpeg({ width: 800, height: 600 }) }])), 400, 'dimension mismatch');
  const big = makeTestJpeg({ bytes: cfg.maxFrameBytes + 1 });
  assert.equal(statusOf(p([{ name: 'meta', type: 'application/json', data: meta }, { name: 'frame0', type: 'image/jpeg', data: big }])), 413, 'frame too big');
  assert.equal(statusOf(() => parseCapture(Buffer.from('x'), 'application/json', cfg)), 400, 'not multipart');
});
