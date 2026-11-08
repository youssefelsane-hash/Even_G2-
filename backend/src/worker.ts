import type { Config } from './config.ts';
import type { JobStore } from './store.ts';
import { verifyChecks } from './verify.ts';
import { buildOutcome, retakeOutcome, selectFrames } from './fusion.ts';
import { summarizeReasons } from './quality.ts';
import { ProviderError, type CheckResult, type FusionImage, type FusionProvider, type Job } from './types.ts';

export type Log = (msg: string, extra?: Record<string, unknown>) => void;

type WorkerConfig = Pick<Config, 'aiTimeoutMs' | 'maxAttempts' | 'retryBaseMs' | 'verifyMath' | 'pythonBin' | 'maxAiImages' | 'maxAiBytes' | 'answerLanguage' | 'sweepIntervalMs'>;

// Processes one job at a time. All frames of a press, plus earlier pages of
// the same question, go to the provider in a single request. A retryable
// failure goes back to the queue with exponential backoff; after maxAttempts
// the job fails, so the glasses always get a final state.
//
// There is no notification path: the glasses app's long-poll is the only way
// a result leaves the server.
export class Worker {
  private timer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private busy = false;
  private stopped = false;
  private current: AbortController | null = null;
  private idleWaiters: Array<() => void> = [];
  private readonly store: JobStore;
  private readonly provider: FusionProvider;
  private readonly cfg: WorkerConfig;
  private readonly log: Log;
  private readonly onEvent = (j: Job) => { if (j.status === 'queued') this.kick(); };
  private readonly onUnlock = () => this.kick();

  constructor(store: JobStore, provider: FusionProvider, cfg: WorkerConfig, log: Log = () => {}) {
    this.store = store;
    this.provider = provider;
    this.cfg = cfg;
    this.log = log;
  }

  async start(): Promise<void> {
    await this.store.recover();
    await this.sweep();
    this.store.on('event', this.onEvent);
    this.store.on('unlocked', this.onUnlock);
    this.sweepTimer = setInterval(() => void this.sweep(), this.cfg.sweepIntervalMs);
    this.sweepTimer.unref();
    this.kick();
  }

  async sweep(): Promise<void> {
    try {
      const r = await this.store.sweep();
      if (r.deleted || r.expired || r.purged) this.log('sweep', r);
    } catch (err) {
      this.log('sweep.error', { error: (err as Error).message });
    }
  }

  // Stops taking work and aborts the AI call in flight. The interrupted job
  // stays 'processing' on disk and is requeued by recover() on next start.
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.store.off('event', this.onEvent);
    this.store.off('unlocked', this.onUnlock);
    this.current?.abort(new Error('worker stopped'));
    if (this.busy) await new Promise<void>((r) => this.idleWaiters.push(r));
  }

  kick(delay = 0): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), delay);
  }

  private async tick(): Promise<void> {
    if (this.busy || this.stopped) return;
    const claim = this.store.claimNext();
    if (!claim) return;
    if ('nextAt' in claim) { this.kick(Math.max(20, claim.nextAt - Date.now())); return; }
    this.busy = true;
    try {
      await claim.written;
      await this.process(claim.job, claim.attempt);
    } catch (err) {
      this.log('worker.error', { id: claim.job.id, error: (err as Error).message });
    } finally {
      this.busy = false;
      for (const w of this.idleWaiters.splice(0)) w();
      this.kick();
    }
  }

  private async process(job: Job, attempt: number): Promise<void> {
    const started = Date.now();
    this.log('job.start', { id: job.id, attempt, frames: job.frames.length, pages: job.pages });

    const usable = job.frames.filter((f) => f.accepted && f.file);
    if (usable.length === 0) {
      // Every frame failed the server checks: tell the camera to retake without paying for an AI call.
      const reason = summarizeReasons(job.frames.map((f) => f.rejectReason));
      const { status, result } = retakeOutcome(reason, job.pages);
      await this.store.settle(job.id, attempt, { status, result, error: undefined, timings: { totalMs: Date.now() - job.createdAt } });
      this.log('job.retake', { id: job.id, reason, source: 'quality' });
      return;
    }

    const chosen = selectFrames(job.frames, this.cfg.maxAiImages, this.cfg.maxAiBytes);
    this.current = new AbortController();
    const signal = AbortSignal.any([this.current.signal, AbortSignal.timeout(this.cfg.aiTimeoutMs)]);
    try {
      const images: FusionImage[] = [];
      for (const f of chosen) {
        images.push({ page: f.page, index: images.length + 1, name: f.name, score: f.score, data: await this.store.readFrame(job.id, f), mediaType: 'image/jpeg' });
      }
      const out = await this.provider.read({ images, carriedText: job.carriedText, pages: job.pages, language: this.cfg.answerLanguage }, signal);
      const aiMs = Date.now() - started;
      const steps = out.detail.slice(0, 8);
      const raw = steps.map((s) => s.check).filter((c) => c !== null);
      const verified = this.cfg.verifyMath
        ? await verifyChecks(raw, this.cfg.pythonBin)
        : { results: raw.map(() => 'unverified' as const) };
      const checks: CheckResult[] = raw.map((c, i) => ({ lhs: c.lhs, rhs: c.rhs, status: verified.results[i] ?? 'unverified' }));
      const outcome = buildOutcome({ ...out, detail: steps }, checks, job.pages, images.length);
      // Pages whose photos were all unusable are named, so the user can retake just that page.
      if (outcome.status === 'ready') {
        for (let p = 1; p <= job.pages; p++) {
          const pf = job.frames.filter((f) => f.page === p);
          if (pf.length && !pf.some((f) => f.accepted)) {
            outcome.result.caveats.unshift(`Page ${p} photos were unusable (${summarizeReasons(pf.map((f) => f.rejectReason))}). Retake that page.`);
          }
        }
        outcome.result.caveats = outcome.result.caveats.slice(0, 6);
      }
      await this.store.settle(job.id, attempt, {
        status: outcome.status, result: outcome.result, checks, error: undefined,
        provider: this.provider.name, model: this.provider.model,
        timings: { queuedMs: started - job.createdAt, aiMs, totalMs: Date.now() - job.createdAt },
      });
      this.log(`job.${outcome.status}`, { id: job.id, attempt, label: outcome.result.label, images: images.length, totalMs: Date.now() - job.createdAt });
    } catch (err) {
      if (this.stopped) return; // leave it 'processing'; recover() requeues it
      const retryable = err instanceof ProviderError ? err.retryable : true;
      const message = (err as Error)?.message ?? String(err);
      if (retryable && attempt < this.cfg.maxAttempts) {
        const backoff = this.cfg.retryBaseMs * 2 ** (attempt - 1);
        await this.store.settle(job.id, attempt, { status: 'queued', error: message, nextAttemptAt: Date.now() + backoff });
        this.log('job.retry', { id: job.id, attempt, backoff, error: message });
      } else {
        // The glasses only see a short, fixed reason. The detail stays in the server log.
        await this.store.settle(job.id, attempt, { status: 'failed', error: retryable ? 'AI unavailable, try again' : 'AI could not process this capture' });
        this.log('job.failed', { id: job.id, attempt, error: message });
      }
    } finally {
      this.current = null;
    }
  }
}
