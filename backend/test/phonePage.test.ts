import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.ts';

test('the phone page is served without a token, holds no secret, and is locked down', async () => {
  const app = await startApp();
  try {
    const res = await fetch(`${app.base}/phone`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    const html = await res.text();
    assert.match(html, /\/v1\/captures/);
    assert.doesNotMatch(html, /Bearer [A-Za-z0-9_-]{20,}/, 'no token baked into the page');
    assert.equal((await fetch(`${app.base}/phone`, { method: 'POST' })).status, 404);
  } finally {
    await app.close();
  }
});
