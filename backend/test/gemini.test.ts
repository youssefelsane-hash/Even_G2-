import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiProvider, buildParts } from '../src/providers/gemini.ts';
import { ProviderError, type FusionInput } from '../src/types.ts';

const input: FusionInput = {
  images: [{ page: 1, index: 1, name: 'f0', score: 0.9, data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), mediaType: 'image/jpeg' }],
  pages: 1,
  language: 'English',
};

const answer = {
  readable: true, retakeReason: null, question: '2x + 6 = 14', short: 'x = 4', detail: [{ text: '2x = 8', check: { lhs: '2*4 + 6', rhs: '14' } }],
  reading: 'clear', reasoning: 'sure', unreadableParts: [], caveats: [], frameConflicts: [],
};

function fakeFetch(status: number, body: unknown, seen: { url?: string; init?: RequestInit } = {}): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.url = String(url);
    seen.init = init;
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const env = { GEMINI_API_KEY: 'test-key-not-real', GEMINI_MODEL: 'gemini-test' };
const ok = (text: string, finishReason = 'STOP') => ({ candidates: [{ finishReason, content: { parts: [{ text, thought: false }] } }] });

test('sends the key in a header, never the URL, with every frame inline', async () => {
  const seen: { url?: string; init?: RequestInit } = {};
  const p = new GeminiProvider(env, fakeFetch(200, ok(JSON.stringify(answer)), seen));
  const out = await p.read(input, AbortSignal.timeout(1000));
  assert.equal(out.short, 'x = 4');
  assert.ok(!seen.url!.includes('test-key-not-real'));
  assert.equal((seen.init!.headers as Record<string, string>)['x-goog-api-key'], 'test-key-not-real');
  const body = JSON.parse(String(seen.init!.body));
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.ok(body.contents[0].parts.some((p: { inlineData?: unknown }) => p.inlineData));
  assert.equal(buildParts(input).filter((p) => p.inlineData).length, 1);
});

test('thought parts are ignored and a schema mismatch is a retryable error', async () => {
  const withThought = { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'thinking…', thought: true }, { text: JSON.stringify(answer) }] } }] };
  assert.equal((await new GeminiProvider(env, fakeFetch(200, withThought)).read(input, AbortSignal.timeout(1000))).short, 'x = 4');
  await assert.rejects(new GeminiProvider(env, fakeFetch(200, ok('{"short": 1}'))).read(input, AbortSignal.timeout(1000)),
    (e: ProviderError) => e.retryable && /schema/.test(e.message));
});

test('HTTP and finish reasons map to retryable or final errors', async () => {
  const cases: [number, unknown, boolean, RegExp][] = [
    [429, { error: { message: 'quota' } }, true, /rate limited/],
    [503, { error: { message: 'overloaded' } }, true, /server 503/],
    [403, { error: { message: 'denied' } }, false, /credentials/],
    [400, { error: { message: 'bad model' } }, false, /bad request: bad model/],
    [200, ok('{}', 'MAX_TOKENS'), true, /cut off/],
    [200, ok('{}', 'SAFETY'), false, /refused \(SAFETY\)/],
    [200, { promptFeedback: { blockReason: 'OTHER' } }, false, /refused \(OTHER\)/],
  ];
  for (const [status, body, retryable, message] of cases) {
    await assert.rejects(new GeminiProvider(env, fakeFetch(status, body)).read(input, AbortSignal.timeout(1000)),
      (e: ProviderError) => e instanceof ProviderError && e.retryable === retryable && message.test(e.message), `${status} ${message}`);
  }
});

test('a missing key fails at start-up, not on the first photo', () => {
  assert.throws(() => new GeminiProvider({}), /GEMINI_API_KEY/);
});
