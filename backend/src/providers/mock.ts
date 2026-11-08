import { createHash } from 'node:crypto';
import { readJpeg } from '../jpeg.ts';
import { isRetakeReason } from '../fusion.ts';
import { ProviderError, type FusionInput, type FusionOutput, type FusionProvider } from '../types.ts';

// Deterministic provider for tests, the simulator and the fake camera. It
// never looks at pixels. The outcome is chosen by a JPEG comment segment in
// any of the frames (the first marker found wins):
//
//   mock:ready            clear, sure, two checkable steps -> CHECKED (LIKELY if SymPy is off)
//   mock:likely           clear, sure, no checkable step   -> LIKELY
//   mock:partial          part of the page unreadable      -> LIKELY with "Could not read" caveat
//   mock:unsure           unclear reading                  -> UNSURE
//   mock:mismatch         a step that SymPy rejects        -> UNSURE
//   mock:conflict         photos disagree, not settled     -> UNSURE with "Photos disagree" caveat
//   mock:retake:<reason>  unreadable, e.g. mock:retake:glare -> RETAKE
//   mock:fail             non-retryable provider error     -> failed
//   mock:flaky            retryable error on the first call for these frames, then ready
//   mock:slow             like ready, after MOCK_SLOW_MS (default 2000 ms)
//
// Frames without a marker behave like mock:ready.
export class MockProvider implements FusionProvider {
  readonly name = 'mock';
  readonly model = 'mock-2';
  delayMs = Number(process.env.MOCK_DELAY_MS ?? 50);
  slowMs = Number(process.env.MOCK_SLOW_MS ?? 2000);
  calls = 0;
  lastInput: FusionInput | null = null;
  private seen = new Set<string>();

  async read(input: FusionInput, signal: AbortSignal): Promise<FusionOutput> {
    this.calls++;
    this.lastInput = input;
    const marker = findMarker(input);
    await sleep(marker === 'slow' ? this.slowMs : this.delayMs, signal);

    const n = input.images.length;
    const base: FusionOutput = {
      readable: true,
      retakeReason: null,
      question: `${input.carriedText ? '[earlier pages included] ' : ''}Solve for x: 2x + 6 = 14`,
      short: `x = 4. Subtract 6, then divide by 2. (${n} photo${n === 1 ? '' : 's'}, ${input.pages} page${input.pages === 1 ? '' : 's'})`,
      detail: [
        { text: 'Subtract 6 from both sides: 2x = 8.', check: { lhs: '14 - 6', rhs: '8' } },
        { text: 'Divide both sides by 2: x = 4.', check: { lhs: '8/2', rhs: '4' } },
      ],
      reading: 'clear',
      reasoning: 'sure',
      unreadableParts: [],
      caveats: [],
      frameConflicts: [],
    };

    if (marker === 'fail') throw new ProviderError('mock: permanent failure', false);
    if (marker === 'flaky') {
      const key = createHash('sha256').update(input.images.map((i) => i.data.length).join(',')).update(input.images[0]?.data ?? Buffer.alloc(0)).digest('hex');
      if (!this.seen.has(key)) {
        this.seen.add(key);
        throw new ProviderError('mock: temporary failure', true);
      }
    }
    if (marker?.startsWith('retake')) {
      const reason = marker.slice('retake:'.length);
      return { ...base, readable: false, retakeReason: isRetakeReason(reason) ? reason : 'blurry', short: '', detail: [], reading: 'unclear', reasoning: 'unsure' };
    }
    if (marker === 'likely') return { ...base, detail: base.detail.map((d) => ({ ...d, check: null })) };
    if (marker === 'partial') return { ...base, reading: 'partial', reasoning: 'likely', unreadableParts: ['the last line of the page'] };
    if (marker === 'unsure') return { ...base, reading: 'unclear', reasoning: 'unsure', caveats: ['The handwriting is hard to read.'] };
    if (marker === 'conflict') return { ...base, frameConflicts: [{ where: 'the sign before 6', resolved: false }], unreadableParts: ['the sign before 6'] };
    if (marker === 'mismatch') return { ...base, detail: [{ text: 'Divide by 2: x = 5.', check: { lhs: '8/2', rhs: '5' } }] };
    return base;
  }
}

function findMarker(input: FusionInput): string | undefined {
  for (const img of input.images) {
    try {
      for (const c of readJpeg(img.data).comments) {
        const m = /mock:([a-z]+(?::[a-z ]+)?)/.exec(c);
        if (m) return m[1];
      }
    } catch {
      // not our fixture; ignore
    }
  }
  return undefined;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
