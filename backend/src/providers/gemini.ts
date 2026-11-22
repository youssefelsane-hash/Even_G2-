import { z } from 'zod';
import { ProviderError, type FusionInput, type FusionOutput, type FusionProvider } from '../types.ts';
import { FusionSchema, systemPrompt } from './anthropic.ts';

// Google Gemini through its REST API (generateContent), with no extra
// dependency. Same prompt, same output schema and same checks as the Anthropic
// provider, so the rest of the backend cannot tell them apart.
// The key is sent in the x-goog-api-key header, never in the URL.

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

interface Part { text?: string; inlineData?: { mimeType: string; data: string } }

/** One user turn with every frame, each preceded by its page and rank label. */
export function buildParts(input: FusionInput): Part[] {
  const parts: Part[] = [];
  if (input.carriedText) parts.push({ text: `Earlier pages, as read earlier (photos deleted):\n${input.carriedText}` });
  const perPage = new Map<number, number>();
  for (const img of input.images) perPage.set(img.page, (perPage.get(img.page) ?? 0) + 1);
  const seen = new Map<number, number>();
  for (const img of input.images) {
    const k = (seen.get(img.page) ?? 0) + 1;
    seen.set(img.page, k);
    parts.push({ text: `Page ${img.page} of ${input.pages}, photo ${k} of ${perPage.get(img.page)} (camera rank ${k}, score ${img.score.toFixed(2)}; a hint only):` });
    parts.push({ inlineData: { mimeType: img.mediaType, data: img.data.toString('base64') } });
  }
  const tail = 'Say which parts no photo showed clearly, and never guess text that no photo shows clearly.';
  parts.push({ text: input.pages > 1 ? `Read all pages together as one question and explain it. ${tail}` : `Read this and explain it. ${tail}` });
  return parts;
}

const RESPONSE_SCHEMA = (() => {
  const s = z.toJSONSchema(FusionSchema) as Record<string, unknown>;
  delete s.$schema;
  return s;
})();

type FetchLike = typeof fetch;

// Seen working or busy on 2026-11-22: 3.5 answered in ~9-16 s; the "latest"
// alias and 3.8 returned 503 (busy) at times. GEMINI_MODEL overrides, comma-separated.
const DEFAULT_MODELS = 'gemini-3.5-flash,gemini-flash-latest,gemini-3.8-flash';

export class GeminiProvider implements FusionProvider {
  readonly name = 'gemini';
  readonly model: string;
  /** Tried in order: when one is busy (429, 5xx) or unavailable, the next one gets the same request. */
  readonly models: string[];
  private readonly key: string;
  private readonly fetch: FetchLike;

  constructor(env: NodeJS.ProcessEnv, fetchImpl: FetchLike = fetch) {
    const key = env.GEMINI_API_KEY ?? '';
    if (!key) throw new Error('GEMINI_API_KEY is not set');
    this.key = key;
    const models = (env.GEMINI_MODEL ?? DEFAULT_MODELS).split(',').map((m) => m.trim()).filter(Boolean);
    this.models = models.length ? models : DEFAULT_MODELS.split(',');
    this.model = this.models[0];
    this.fetch = fetchImpl;
  }

  async read(input: FusionInput, signal: AbortSignal): Promise<FusionOutput> {
    let last: ProviderError | null = null;
    for (const model of this.models) {
      try {
        return await this.readWith(model, input, signal);
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        last = err;
        // Only problems of this model move on: busy, down, gone. A refusal, bad
        // credentials or the job's time limit would fail the same way on any model.
        const modelSpecific = err.retryable || /bad request: .*model/i.test(err.message);
        if (signal.aborted || !modelSpecific || err.message === 'AI call timed out') throw err;
      }
    }
    throw last ?? new ProviderError('no model configured', false);
  }

  private async readWith(model: string, input: FusionInput, signal: AbortSignal): Promise<FusionOutput> {
    let res: Response;
    try {
      res = await this.fetch(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt(input.language) }] },
          contents: [{ role: 'user', parts: buildParts(input) }],
          generationConfig: { responseMimeType: 'application/json', responseJsonSchema: RESPONSE_SCHEMA, maxOutputTokens: 16_000 },
        }),
      });
    } catch (err) {
      if (signal.aborted) throw new ProviderError('AI call timed out', true);
      throw new ProviderError(`network: ${(err as Error).message}`, true);
    }
    const body = await res.json().catch(() => null) as GeminiResponse | null;
    if (!res.ok) {
      const msg = body?.error?.message ?? `HTTP ${res.status}`;
      if (res.status === 429) throw new ProviderError('rate limited', true);
      if (res.status >= 500) throw new ProviderError(`server ${res.status}`, true);
      if (res.status === 401 || res.status === 403) throw new ProviderError('AI credentials rejected', false);
      throw new ProviderError(`bad request: ${msg}`, false);
    }
    if (body?.promptFeedback?.blockReason) throw new ProviderError(`model refused (${body.promptFeedback.blockReason})`, false);
    const cand = body?.candidates?.[0];
    if (!cand) throw new ProviderError('no answer returned', true);
    if (cand.finishReason === 'MAX_TOKENS') throw new ProviderError('model output was cut off (max_tokens)', true);
    if (cand.finishReason && !['STOP', 'FINISH_REASON_UNSPECIFIED'].includes(cand.finishReason)) {
      throw new ProviderError(`model refused (${cand.finishReason})`, false);
    }
    const text = (cand.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('');
    let json: unknown;
    try { json = JSON.parse(text); } catch { throw new ProviderError('model output was not JSON', true); }
    const parsed = FusionSchema.safeParse(json);
    if (!parsed.success) throw new ProviderError('model output did not match the schema', true);
    return parsed.data;
  }
}

interface GeminiResponse {
  error?: { message?: string };
  promptFeedback?: { blockReason?: string };
  candidates?: { finishReason?: string; content?: { parts?: { text?: string; thought?: boolean }[] } }[];
}
