import { copyFile, mkdir, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { atomicWrite, readJson } from './fsutil.ts';
import { TERMINAL, type CaptureMeta, type EventStatus, type FrameMeta, type Job, type JobStatus, type RetakeReason, type StoredFrame } from './types.ts';

export interface StoreOptions {
  appendMaxAgeMs: number;
  maxPages: number;
  appendWindowMs: number;
  imageMaxAgeMs: number;
  resultTtlMs: number;
}

export interface IncomingFrame {
  meta: FrameMeta;
  data: Buffer;
  width: number; // from the JPEG header, not from the camera's claim
  height: number;
  accepted: boolean;
  rejectReason?: RetakeReason;
}

export interface CaptureRequest {
  deviceId: string;
  key: string;
  meta: CaptureMeta;
  frames: IncomingFrame[];
}

export interface CaptureReply {
  jobId: string;
  status: JobStatus;
  duplicate: boolean;
}

export class CaptureError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function eventStatus(s: JobStatus): EventStatus {
  return s === 'queued' ? 'received' : s;
}

// What the glasses app receives for one job. Never contains server paths,
// device tokens or idempotency keys.
export function publicEvent(j: Job) {
  return {
    jobId: j.id,
    seq: j.eventSeq,
    status: eventStatus(j.status),
    photos: j.frames.length,
    pages: j.pages,
    ...(j.appendedTo ? { appendedTo: j.appendedTo } : {}),
    createdAt: new Date(j.createdAt).toISOString(),
    ...(j.result ? { result: j.result } : {}),
    ...(j.status === 'failed' ? { error: j.error ?? 'failed' } : {}),
  };
}
export type PublicEvent = ReturnType<typeof publicEvent>;

const idemKey = (deviceId: string, key: string) => `${deviceId}\u0000${key}`;

// Durable job store: one JSON file per job, written atomically, and one image
// directory per job. Every write bumps a global sequence number; changes the
// glasses app should see also set the job's eventSeq, so a client can resume
// with "everything after cursor N" after a reconnect or a cold start.
//
// In-memory state is changed synchronously before any disk write starts. That
// is what makes idempotency and page merging race-free inside one process.
export class JobStore extends EventEmitter {
  private jobs = new Map<string, Job>();
  private byIdem = new Map<string, string>();
  private pending = new Map<string, Promise<CaptureReply>>();
  private locks = new Map<string, number>();
  private seq = 0;
  private readonly jobsDir: string;
  private readonly imagesDir: string;
  private readonly seqFile: string;
  private readonly opts: StoreOptions;

  constructor(dataDir: string, opts: StoreOptions) {
    super();
    this.jobsDir = path.join(dataDir, 'jobs');
    this.imagesDir = path.join(dataDir, 'images');
    this.seqFile = path.join(dataDir, 'state', 'seq.json');
    this.opts = opts;
  }

  async open(): Promise<void> {
    await mkdir(this.jobsDir, { recursive: true });
    await mkdir(this.imagesDir, { recursive: true });
    this.seq = (await readJson<{ seq: number }>(this.seqFile))?.seq ?? 0;
    for (const f of await readdir(this.jobsDir)) {
      const file = path.join(this.jobsDir, f);
      if (f.endsWith('.tmp')) { await unlink(file).catch(() => {}); continue; }
      if (!f.endsWith('.json')) continue;
      let job: Job;
      try {
        job = JSON.parse(await readFile(file, 'utf8')) as Job;
        if (!job.id || !Array.isArray(job.frames)) throw new Error('bad job');
      } catch {
        // A corrupt record cannot be trusted; move it aside rather than crash.
        await writeFile(`${file}.corrupt`, await readFile(file)).catch(() => {});
        await unlink(file).catch(() => {});
        continue;
      }
      this.jobs.set(job.id, job);
      for (const k of job.idempotencyKeys) this.byIdem.set(idemKey(job.deviceId, k), job.id);
      this.seq = Math.max(this.seq, job.seq);
    }
    // Image directories without a job are leftovers from a crash mid-upload.
    for (const d of await readdir(this.imagesDir)) {
      if (!this.jobs.has(d)) await rm(path.join(this.imagesDir, d), { recursive: true, force: true });
    }
  }

  get(id: string): Job | undefined {
    const j = this.jobs.get(id);
    return j && structuredClone(j);
  }

  all(): Job[] {
    return [...this.jobs.values()].map((j) => structuredClone(j));
  }

  currentSeq(): number {
    return this.seq;
  }

  findByKey(deviceId: string, key: string): Job | undefined {
    const id = this.byIdem.get(idemKey(deviceId, key));
    return id ? this.get(id) : undefined;
  }

  // ---------- writes ----------

  // Applies a patch in memory now, then persists it. A status change, or
  // `event: true`, makes the change visible on the results stream.
  update(id: string, patch: Partial<Job>, opts: { event?: boolean } = {}): Promise<Job> {
    const cur = this.jobs.get(id);
    if (!cur) return Promise.reject(new Error(`job ${id} not found`));
    const next: Job = { ...cur, ...patch, updatedAt: Date.now() };
    const event = opts.event ?? (patch.status !== undefined && patch.status !== cur.status);
    return this.save(next, event);
  }

  private async save(job: Job, event: boolean): Promise<Job> {
    job.seq = ++this.seq;
    if (event) job.eventSeq = job.seq;
    this.jobs.set(job.id, job);
    const snapshot = structuredClone(job);
    await atomicWrite(path.join(this.jobsDir, `${job.id}.json`), JSON.stringify(snapshot));
    if (event) this.emit('event', snapshot);
    return structuredClone(snapshot);
  }

  // ---------- captures ----------

  // Idempotent: the same (device, key) always yields the same job, including
  // when two attempts arrive at the same time. The reservation is taken
  // synchronously, before the first await, so no second job can be created.
  capture(req: CaptureRequest): Promise<CaptureReply> {
    const k = idemKey(req.deviceId, req.key);
    const existing = this.byIdem.get(k);
    if (existing) {
      const j = this.jobs.get(existing)!;
      return Promise.resolve({ jobId: j.id, status: j.status, duplicate: true });
    }
    const inflight = this.pending.get(k);
    if (inflight) return inflight.then((r) => ({ ...r, status: this.jobs.get(r.jobId)?.status ?? r.status, duplicate: true }));
    const p = this.doCapture(req).finally(() => this.pending.delete(k));
    this.pending.set(k, p);
    return p;
  }

  private resolveParent(deviceId: string, appendTo: string | undefined): Job | undefined {
    if (!appendTo) return undefined;
    if (appendTo === 'previous') {
      let best: Job | undefined;
      const now = Date.now();
      for (const j of this.jobs.values()) {
        if (j.deviceId !== deviceId || now - j.createdAt > this.opts.appendMaxAgeMs) continue;
        if (!best || j.createdAt > best.createdAt) best = j;
      }
      return best; // none: the press starts a new question
    }
    // An unknown id (purged, data reset), another device's id, or a question older
    // than the append limit: start a new question, exactly as 'previous' does when
    // nothing recent exists. A 404 would make the camera discard the photos.
    const j = this.jobs.get(appendTo);
    if (!j || j.deviceId !== deviceId || Date.now() - j.createdAt > this.opts.appendMaxAgeMs) return undefined;
    return j;
  }

  private async doCapture(req: CaptureRequest): Promise<CaptureReply> {
    const { deviceId, key, meta } = req;
    let parent = this.resolveParent(deviceId, meta.appendTo);
    // Another page is being merged into the same question: wait for it, then decide.
    while (parent && this.locks.has(parent.id)) {
      const pid = parent.id;
      await new Promise<void>((resolve) => {
        const on = (id: string) => { if (id === pid && !this.locks.has(pid)) { this.off('unlocked', on); resolve(); } };
        this.on('unlocked', on);
      });
      parent = this.jobs.get(pid);
    }
    if (parent && parent.pages >= this.opts.maxPages) throw new CaptureError(409, `a question can have at most ${this.opts.maxPages} pages`);

    // Merge into a parent the worker has not started yet: one AI call instead of two.
    if (parent && parent.status === 'queued' && !this.locks.has(parent.id)) {
      this.lock(parent.id);
      try {
        const page = parent.pages + 1;
        const frames = await this.writeFrames(parent.id, page, req.frames);
        const cur = this.jobs.get(parent.id)!;
        const updated = await this.update(parent.id, {
          frames: [...cur.frames, ...frames],
          pages: page,
          idempotencyKeys: [...cur.idempotencyKeys, key],
        }, { event: true });
        this.byIdem.set(idemKey(deviceId, key), parent.id);
        return { jobId: updated.id, status: updated.status, duplicate: false };
      } finally {
        this.unlock(parent.id);
      }
    }

    const id = randomUUID();
    const now = Date.now();
    let frames: StoredFrame[] = [];
    let pages = 1;
    let carriedText: string | undefined;
    // The job is visible to the worker only after save(), so lock it until its images are on disk.
    this.lock(id);
    try {
      if (parent) {
        pages = parent.pages + 1;
        frames = await this.copyFrames(parent, id);
        const parts: string[] = [];
        if (parent.carriedText) parts.push(parent.carriedText);
        // Judge by what was really copied: the parent's record can still list files
        // that a sweep or a disk problem removed while the copy ran.
        const anyFiles = frames.some((f) => f.file);
        if (!anyFiles && parent.result?.question) parts.push(`Pages 1-${parent.pages}, as read earlier: ${parent.result.question}`);
        if (parts.length) carriedText = parts.join('\n');
      }
      frames.push(...await this.writeFrames(id, pages, req.frames));
      const job: Job = {
        id, seq: 0, eventSeq: 0, status: 'queued', deviceId, idempotencyKeys: [key],
        mode: meta.mode, capturedAt: meta.capturedAt, ...(meta.battery !== undefined ? { battery: meta.battery } : {}),
        pages, ...(parent ? { appendedTo: parent.id } : {}), frames, ...(carriedText ? { carriedText } : {}),
        attempts: 0, createdAt: now, updatedAt: now, nextAttemptAt: now,
      };
      const saved = await this.save(job, true);
      this.byIdem.set(idemKey(deviceId, key), id);
      return { jobId: id, status: saved.status, duplicate: false };
    } catch (err) {
      if (!this.jobs.has(id)) await rm(path.join(this.imagesDir, id), { recursive: true, force: true });
      throw err;
    } finally {
      this.unlock(id);
    }
  }

  private lock(id: string): void { this.locks.set(id, (this.locks.get(id) ?? 0) + 1); }
  private unlock(id: string): void {
    const n = (this.locks.get(id) ?? 1) - 1;
    if (n <= 0) this.locks.delete(id); else this.locks.set(id, n);
    this.emit('unlocked', id);
  }

  // Only accepted frames are written to disk. Rejected ones are recorded
  // (name, score, reason) but their pixels are dropped at once.
  private async writeFrames(jobId: string, page: number, incoming: IncomingFrame[]): Promise<StoredFrame[]> {
    const dir = path.join(this.imagesDir, jobId);
    if (incoming.some((f) => f.accepted)) await mkdir(dir, { recursive: true });
    const out: StoredFrame[] = [];
    for (const f of incoming) {
      const stored: StoredFrame = {
        page, name: f.meta.name, score: f.meta.score, width: f.width, height: f.height, bytes: f.data.length, accepted: f.accepted,
        ...(f.rejectReason ? { rejectReason: f.rejectReason } : {}),
        bornAt: Date.now(),
      };
      if (f.accepted) {
        const file = `p${page}-${randomBytes(6).toString('hex')}.jpg`;
        await writeFile(path.join(dir, file), f.data);
        stored.file = file;
      }
      out.push(stored);
    }
    return out;
  }

  private async copyFrames(parent: Job, childId: string): Promise<StoredFrame[]> {
    const dir = path.join(this.imagesDir, childId);
    await mkdir(dir, { recursive: true });
    const out: StoredFrame[] = [];
    for (const f of parent.frames) {
      const copy: StoredFrame = { ...f, bornAt: f.bornAt ?? parent.createdAt };
      delete copy.file;
      if (f.file) {
        try {
          await copyFile(path.join(this.imagesDir, parent.id, f.file), path.join(dir, f.file));
          copy.file = f.file;
        } catch {
          // Deleted in the meantime: the page text is carried instead, if known.
        }
      }
      out.push(copy);
    }
    return out;
  }

  readFrame(jobId: string, frame: StoredFrame): Promise<Buffer> {
    if (!frame.file) return Promise.reject(new Error('frame image already deleted'));
    return readFile(path.join(this.imagesDir, jobId, frame.file));
  }

  // ---------- worker support ----------

  // Picks the oldest due job and marks it processing, synchronously. A job
  // is skipped while a page is being merged into it, and a continuation
  // waits for its parent to finish so results arrive in order.
  claimNext(now = Date.now()): { job: Job; attempt: number; written: Promise<Job> } | { nextAt: number } | undefined {
    let due: Job | undefined;
    let nextAt = Infinity;
    for (const j of this.jobs.values()) {
      if (j.status !== 'queued' || this.locks.has(j.id)) continue;
      if (j.appendedTo) {
        const p = this.jobs.get(j.appendedTo);
        if (p && !TERMINAL.has(p.status)) continue;
      }
      if (j.nextAttemptAt > now) { nextAt = Math.min(nextAt, j.nextAttemptAt); continue; }
      if (!due || j.createdAt < due.createdAt) due = j;
    }
    if (!due) return Number.isFinite(nextAt) ? { nextAt } : undefined;
    const attempt = due.attempts + 1;
    const written = this.update(due.id, { status: 'processing', attempts: attempt });
    return { job: structuredClone(this.jobs.get(due.id)!), attempt, written };
  }

  // Applies a final or retry patch only if the job is still in the attempt
  // that produced it. A job expired by the sweep meanwhile is left alone.
  // A retry (back to 'queued') is not shown to the glasses: they keep showing "Reading".
  async settle(id: string, attempt: number, patch: Partial<Job>): Promise<Job | undefined> {
    const cur = this.jobs.get(id);
    if (!cur || cur.status !== 'processing' || cur.attempts !== attempt) return undefined;
    const final = patch.status !== undefined && TERMINAL.has(patch.status);
    const job = await this.update(id, final ? { ...patch, finishedAt: Date.now() } : patch, { event: final });
    if (final && this.opts.appendWindowMs <= 0) await this.deleteImages(id);
    return job;
  }

  async deleteImages(id: string): Promise<void> {
    const cur = this.jobs.get(id);
    if (!cur) return;
    await rm(path.join(this.imagesDir, id), { recursive: true, force: true });
    if (cur.frames.some((f) => f.file) || !cur.imagesDeletedAt) {
      const frames = cur.frames.map((f) => { const c = { ...f }; delete c.file; return c; });
      await this.update(id, { frames, imagesDeletedAt: Date.now() });
    }
  }

  private async deleteFrameFiles(id: string, files: string[]): Promise<void> {
    for (const f of files) await unlink(path.join(this.imagesDir, id, f)).catch(() => {});
    const cur = this.jobs.get(id);
    if (!cur) return;
    const gone = new Set(files);
    const frames = cur.frames.map((f) => { const c = { ...f }; if (c.file && gone.has(c.file)) delete c.file; return c; });
    if (frames.some((f) => f.file)) await this.update(id, { frames });
    else await this.deleteImages(id);
  }

  // Requeues work that was in flight when the process stopped.
  async recover(): Promise<void> {
    for (const j of this.jobs.values()) {
      if (j.status === 'processing') await this.update(j.id, { status: 'queued', nextAttemptAt: Date.now() }, { event: false });
    }
  }

  // Retention. Safe to run often.
  //  - finished jobs keep images only for the append window
  //  - no image is kept longer than imageMaxAgeMs; unfinished jobs that old fail
  //  - results are kept for resultTtlMs, then the whole record goes
  async sweep(now = Date.now()): Promise<{ deleted: number; expired: number; purged: number }> {
    let deleted = 0, expired = 0, purged = 0;
    for (const j of [...this.jobs.values()]) {
      const hasImages = j.frames.some((f) => f.file) || !j.imagesDeletedAt;
      const old = now - j.createdAt >= this.opts.imageMaxAgeMs;
      if (!TERMINAL.has(j.status) && old && !this.locks.has(j.id)) {
        await this.update(j.id, { status: 'failed', error: 'expired', finishedAt: now });
        await this.deleteImages(j.id);
        expired++;
        continue;
      }
      if (TERMINAL.has(j.status) && hasImages && (old || now - (j.finishedAt ?? j.updatedAt) >= this.opts.appendWindowMs)) {
        await this.deleteImages(j.id);
        deleted++;
      } else if (!this.locks.has(j.id)) {
        // A continuation holds copies of earlier pages. The hard limit counts from
        // when each photo arrived, not from when this job was created.
        const stale = j.frames.filter((f) => f.file && now - (f.bornAt ?? j.createdAt) >= this.opts.imageMaxAgeMs);
        if (stale.length) { await this.deleteFrameFiles(j.id, stale.map((f) => f.file!)); deleted++; }
      }
      if (TERMINAL.has(j.status) && now - (j.finishedAt ?? j.updatedAt) >= this.opts.resultTtlMs) {
        await this.remove(j.id);
        purged++;
      }
    }
    return { deleted, expired, purged };
  }

  private async remove(id: string): Promise<void> {
    const j = this.jobs.get(id);
    if (!j) return;
    // Persist the counter first, so cursors never go backwards after the record is gone.
    await atomicWrite(this.seqFile, JSON.stringify({ seq: this.seq }));
    await rm(path.join(this.imagesDir, id), { recursive: true, force: true });
    await unlink(path.join(this.jobsDir, `${id}.json`)).catch(() => {});
    this.jobs.delete(id);
    for (const k of j.idempotencyKeys) this.byIdem.delete(idemKey(j.deviceId, k));
  }

  async close(): Promise<void> {
    await atomicWrite(this.seqFile, JSON.stringify({ seq: this.seq }));
  }

  // ---------- results stream ----------

  eventsSince(cursor: number, limit = 50): { events: PublicEvent[]; cursor: number; more: boolean } {
    // A cursor from the future means the server's data was reset: start over.
    // The client de-duplicates by jobId.
    const after = cursor > this.seq ? 0 : cursor;
    const list = [...this.jobs.values()].filter((j) => j.eventSeq > after).sort((a, b) => a.eventSeq - b.eventSeq);
    const page = list.slice(0, limit);
    return {
      events: page.map((j) => publicEvent(j)),
      cursor: page.length ? page[page.length - 1].eventSeq : Math.min(cursor, this.seq),
      more: list.length > page.length,
    };
  }

  hasEventsAfter(cursor: number): boolean {
    if (cursor > this.seq) return this.jobs.size > 0;
    for (const j of this.jobs.values()) if (j.eventSeq > cursor) return true;
    return false;
  }

  lastJobFor(deviceId: string): Job | undefined {
    let best: Job | undefined;
    for (const j of this.jobs.values()) if (j.deviceId === deviceId && (!best || j.createdAt > best.createdAt)) best = j;
    return best && structuredClone(best);
  }
}
