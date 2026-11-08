// Shared types. The public API shapes are documented in docs/API.md and must
// stay in step with this file.

export type CaptureMode = 'single' | 'burst' | 'clip';

// Internal and device-facing job status. The glasses-facing event stream uses
// 'received' where this says 'queued' (see eventStatus in store.ts).
export type JobStatus = 'queued' | 'processing' | 'ready' | 'retake' | 'failed';
export type EventStatus = 'received' | 'processing' | 'ready' | 'retake' | 'failed';
export const TERMINAL: ReadonlySet<JobStatus> = new Set(['ready', 'retake', 'failed']);

export type Label = 'CHECKED' | 'LIKELY' | 'UNSURE' | 'RETAKE';

// Short reasons the camera LED and the lens can show. Fixed set so that the
// camera firmware and the glasses app can map them without parsing prose.
export const RETAKE_REASONS = ['too dark', 'blurry', 'page cut off', 'glare', 'too far', 'no text found'] as const;
export type RetakeReason = (typeof RETAKE_REASONS)[number];

// What the camera says about one frame, from the multipart "meta" part.
export interface FrameMeta {
  name: string;
  score: number; // 0..1, camera's overall quality score (higher is better)
  width: number;
  height: number;
  // Optional raw measurements. Used only to pick a better retake reason.
  sharpness?: number; // raw Laplacian variance or proxy, resolution dependent
  brightness?: number; // mean luma 0..255
  clipped?: number; // fraction 0..1 of near-white pixels
  // The camera's own verdict from decoding the pixels (Linux client). The server
  // cannot decode, so a frame the camera flagged is not sent to the AI.
  issues?: CameraIssue[];
}

export const CAMERA_ISSUES = ['too dark', 'too bright', 'glare', 'blurry'] as const;
export type CameraIssue = (typeof CAMERA_ISSUES)[number];

export interface CaptureMeta {
  mode: CaptureMode;
  appendTo?: string; // jobId or 'previous'
  capturedAt: string; // ISO 8601 from the camera clock (informational only)
  battery?: number; // 0..100
  frames: FrameMeta[];
}

// One stored frame of a job. `file` is a server path and never leaves the server.
export interface StoredFrame {
  page: number; // 1-based page within the question
  name: string;
  score: number;
  width: number;
  height: number;
  bytes: number;
  accepted: boolean;
  rejectReason?: RetakeReason;
  file?: string; // basename inside the job's image directory; absent once deleted
  bornAt?: number; // ms epoch when the photo reached the server; kept when copied into a continuation
}

export interface CheckResult {
  lhs: string;
  rhs: string;
  status: 'verified' | 'mismatch' | 'unverified';
}

export interface DetailItem {
  text: string;
  check: CheckResult | null;
}

// Result as delivered to the glasses app.
export interface JobResult {
  short: string;
  detail: string[];
  label: Label;
  caveats: string[];
  pages: number;
  usedFrames: number;
  retakeReason?: RetakeReason;
  question: string;
}

export interface Job {
  id: string;
  seq: number; // bumped on every write
  eventSeq: number; // bumped only on changes the glasses app should see
  status: JobStatus;
  deviceId: string;
  idempotencyKeys: string[]; // a merged page adds its key here
  mode: CaptureMode;
  capturedAt: string;
  battery?: number;
  pages: number;
  appendedTo?: string; // parent job when this job continues an earlier question
  frames: StoredFrame[];
  // Text of earlier pages, used when their images were already deleted.
  carriedText?: string;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  nextAttemptAt: number;
  finishedAt?: number;
  imagesDeletedAt?: number;
  result?: JobResult;
  checks?: CheckResult[];
  error?: string;
  receivedAt?: number;
  displayedAt?: number;
  timings?: { queuedMs?: number; aiMs?: number; totalMs?: number };
  provider?: string;
  model?: string;
}

// ---------- AI provider boundary ----------

export interface FusionImage {
  page: number;
  index: number; // position in the request, 1-based, as the model sees it
  name: string;
  score: number;
  data: Buffer;
  mediaType: 'image/jpeg';
}

export interface FusionInput {
  images: FusionImage[];
  // Text of earlier pages whose images were already deleted.
  carriedText?: string;
  pages: number;
  language: string;
}

export interface FusionStep {
  text: string;
  check: { lhs: string; rhs: string } | null;
}

// What every provider must return. The backend, not the model, turns this into a label.
export interface FusionOutput {
  readable: boolean;
  retakeReason: RetakeReason | null;
  question: string;
  short: string;
  detail: FusionStep[];
  reading: 'clear' | 'partial' | 'unclear';
  reasoning: 'sure' | 'likely' | 'unsure';
  unreadableParts: string[];
  caveats: string[];
  // Places where the photos of one page disagreed (a word, digit or sign).
  // Optional so older fixtures stay valid; the Anthropic schema always asks for it.
  // An unresolved conflict makes the answer UNSURE (docs/CAPTURE-STRATEGY.md section 8).
  frameConflicts?: Array<{ where: string; resolved: boolean }>;
}

export class ProviderError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

export interface FusionProvider {
  readonly name: string;
  readonly model: string;
  read(input: FusionInput, signal: AbortSignal): Promise<FusionOutput>;
}
