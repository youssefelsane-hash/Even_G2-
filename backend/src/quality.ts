import type { Config } from './config.ts';
import type { FrameMeta, RetakeReason } from './types.ts';

// Server-side frame checks. They use only the JPEG header, the file size and
// the camera's own measurements, so they need no image decoder. They are a
// cheap first filter; the AI makes the final call on readability.

export type QualityConfig = Pick<Config, 'minFrameWidth' | 'minFrameHeight' | 'minFrameScore' | 'minBytesPerPixel'>;

export interface FrameVerdict {
  accepted: boolean;
  reason?: RetakeReason;
}

const DARK_LUMA = 35;
const GLARE_CLIPPED = 0.2;

export function checkFrame(meta: FrameMeta, header: { width: number; height: number }, bytes: number, q: QualityConfig): FrameVerdict {
  const { width, height } = header;
  // Too few pixels to read print, whatever else is true.
  if (width < q.minFrameWidth || height < q.minFrameHeight) return { accepted: false, reason: 'blurry' };
  // The camera decoded the pixels and flagged this frame. It is the only part
  // of the system that saw them, so its verdict wins over the cheap checks below.
  // Without this, a press the camera judged blurry in every frame still went to
  // the AI (found by tools/e2e-system). Thresholds: camera/linux/evencam/scoring.py.
  const flagged = meta.issues ?? [];
  if (flagged.includes('too dark')) return { accepted: false, reason: 'too dark' };
  if (flagged.includes('glare') || flagged.includes('too bright')) return { accepted: false, reason: 'glare' };
  if (flagged.includes('blurry')) return { accepted: false, reason: 'blurry' };
  if (meta.brightness !== undefined && meta.brightness < DARK_LUMA) return { accepted: false, reason: 'too dark' };
  if (meta.clipped !== undefined && meta.clipped > GLARE_CLIPPED) return { accepted: false, reason: 'glare' };
  if (meta.score < q.minFrameScore) {
    return { accepted: false, reason: meta.brightness !== undefined && meta.brightness < 60 ? 'too dark' : 'blurry' };
  }
  // A dark or very blurred frame compresses to almost nothing. ASSUMPTION:
  // the threshold must be tuned on real camera output (EXPERIMENT NEEDED).
  if (bytes / (width * height) < q.minBytesPerPixel) {
    return { accepted: false, reason: meta.brightness !== undefined && meta.brightness >= 60 ? 'blurry' : 'too dark' };
  }
  return { accepted: true };
}

const PRIORITY: RetakeReason[] = ['too dark', 'glare', 'blurry', 'page cut off', 'too far', 'no text found'];

// One reason for a press where every frame failed: the most common one, ties
// broken by what the user can most easily fix.
export function summarizeReasons(reasons: Array<RetakeReason | undefined>): RetakeReason {
  const counts = new Map<RetakeReason, number>();
  for (const r of reasons) if (r) counts.set(r, (counts.get(r) ?? 0) + 1);
  let best: RetakeReason = 'blurry';
  let bestN = 0;
  for (const r of PRIORITY) {
    const n = counts.get(r) ?? 0;
    if (n > bestN) { best = r; bestN = n; }
  }
  return best;
}
