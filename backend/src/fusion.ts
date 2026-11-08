import { RETAKE_REASONS, type CheckResult, type FusionOutput, type JobResult, type Label, type RetakeReason, type StoredFrame } from './types.ts';

export const LIMITS = { short: 140, detailItems: 8, detailChars: 400, caveats: 6, caveatChars: 200, question: 600 };

// The lens shows plain text. Strip control characters and collapse whitespace.
export function plain(s: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const t = String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').replace(/[ \t]+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 3).trimEnd()}...` : t;
}

export function isRetakeReason(v: unknown): v is RetakeReason {
  return typeof v === 'string' && (RETAKE_REASONS as readonly string[]).includes(v);
}

// Chooses which stored frames go to the AI. Every page gets its best frame
// first, then second-best frames, and so on, until the image count or byte
// budget is used. The result is ordered by page, then by score.
export function selectFrames(frames: StoredFrame[], maxImages: number, maxBytes: number): StoredFrame[] {
  const byPage = new Map<number, StoredFrame[]>();
  for (const f of frames) {
    if (!f.accepted || !f.file) continue;
    const list = byPage.get(f.page) ?? [];
    list.push(f);
    byPage.set(f.page, list);
  }
  for (const list of byPage.values()) list.sort((a, b) => b.score - a.score);
  const chosen: StoredFrame[] = [];
  let bytes = 0;
  for (let rank = 0; ; rank++) {
    let any = false;
    for (const page of [...byPage.keys()].sort((a, b) => a - b)) {
      const f = byPage.get(page)![rank];
      if (!f) continue;
      any = true;
      if (chosen.length >= maxImages || bytes + f.bytes > maxBytes) continue;
      chosen.push(f);
      bytes += f.bytes;
    }
    if (!any) break;
  }
  return chosen.sort((a, b) => a.page - b.page || b.score - a.score);
}

export interface Outcome {
  status: 'ready' | 'retake';
  result: JobResult;
}

// Turns the model's structured answer and the SymPy results into what the
// glasses show. The label is computed here, never written by the model.
//   RETAKE  - the model says the photos cannot be read
//   UNSURE  - reading unclear, reasoning unsure, a computer check failed, or
//             the photos disagreed somewhere the model could not settle
//   CHECKED - reading clear, reasoning sure, nothing unreadable, no unsettled
//             photo conflict, and at least one check, all verified
//   LIKELY  - everything else
export function buildOutcome(out: FusionOutput, checks: CheckResult[], pages: number, usedFrames: number): Outcome {
  const question = plain(out.question, LIMITS.question);
  if (!out.readable) {
    const reason: RetakeReason = isRetakeReason(out.retakeReason) ? out.retakeReason : 'blurry';
    return {
      status: 'retake',
      result: {
        short: `Retake: ${reason}`, detail: [], label: 'RETAKE', caveats: out.caveats.slice(0, LIMITS.caveats).map((c) => plain(c, LIMITS.caveatChars)).filter(Boolean),
        pages, usedFrames, retakeReason: reason, question,
      },
    };
  }
  const caveats: string[] = [];
  const mismatch = checks.some((c) => c.status === 'mismatch');
  if (mismatch) caveats.push('A computer check of one step failed. Do not rely on this answer without checking it.');
  const unresolved = (out.frameConflicts ?? []).filter((c) => !c.resolved);
  for (const c of unresolved) {
    const t = plain(c.where, LIMITS.caveatChars - 22);
    if (t) caveats.push(`Photos disagree about: ${t}`);
  }
  for (const p of out.unreadableParts) {
    const t = plain(p, LIMITS.caveatChars - 16);
    if (t) caveats.push(`Could not read: ${t}`);
  }
  for (const c of out.caveats) {
    const t = plain(c, LIMITS.caveatChars);
    if (t) caveats.push(t);
  }
  let label: Label;
  if (mismatch || unresolved.length > 0 || out.reading === 'unclear' || out.reasoning === 'unsure') label = 'UNSURE';
  else if (out.reading === 'clear' && out.reasoning === 'sure' && out.unreadableParts.length === 0 && checks.length > 0 && checks.every((c) => c.status === 'verified')) label = 'CHECKED';
  else label = 'LIKELY';
  return {
    status: 'ready',
    result: {
      short: plain(out.short, LIMITS.short),
      detail: out.detail.slice(0, LIMITS.detailItems).map((d) => plain(d.text, LIMITS.detailChars)).filter(Boolean),
      label,
      caveats: caveats.slice(0, LIMITS.caveats),
      pages,
      usedFrames,
      question,
    },
  };
}

export function retakeOutcome(reason: RetakeReason, pages: number): Outcome {
  return {
    status: 'retake',
    result: { short: `Retake: ${reason}`, detail: [], label: 'RETAKE', caveats: [], pages, usedFrames: 0, retakeReason: reason, question: '' },
  };
}
