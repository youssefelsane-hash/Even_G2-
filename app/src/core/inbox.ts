import type { KeyValueStore } from './storage.ts';

// The answers kept on the phone: the newest 20, newest first. Answers that
// arrive while the lens is hidden wait here, marked unseen, and are shown one at
// a time after a restore, newest first. This file decides nothing about the lens.

export interface AnswerRecord {
  jobId: string;
  short: string;
  detail: string[];
  label: string;
  caveats: string[];
  pages: number;
  usedFrames: number;
  /** Clock time when the phone stored it. */
  at: number;
  /** Has been on the lens at least once. */
  seen: boolean;
  /** The server's sequence number of the result, for keeping old results in order. */
  seq?: number;
}

export const INBOX_KEY = 'g2a.inbox.v1';
export const INBOX_SIZE = 20;

function valid(r: unknown): r is AnswerRecord {
  if (!r || typeof r !== 'object') return false;
  const x = r as Record<string, unknown>;
  return typeof x.jobId === 'string' && typeof x.short === 'string' && Array.isArray(x.detail) &&
    x.detail.every((d) => typeof d === 'string') && typeof x.label === 'string' && Array.isArray(x.caveats) &&
    x.caveats.every((d) => typeof d === 'string') && typeof x.pages === 'number' && typeof x.usedFrames === 'number' &&
    typeof x.at === 'number' && typeof x.seen === 'boolean' && (x.seq === undefined || typeof x.seq === 'number');
}

/** Joins an answer into the one document the pager scrolls. */
export function answerText(r: Pick<AnswerRecord, 'short' | 'detail' | 'caveats' | 'pages'>): string {
  const parts = [r.short];
  if (r.detail.length) parts.push(r.detail.join('\n'));
  if (r.caveats.length) parts.push(r.caveats.map((c) => `Note: ${c}`).join('\n'));
  return parts.join('\n\n');
}

export class Inbox {
  private list: AnswerRecord[] = [];
  private readonly store: KeyValueStore;
  private writing: Promise<void> = Promise.resolve();

  constructor(store: KeyValueStore, initial: AnswerRecord[] = []) {
    this.store = store;
    this.list = initial.slice(0, INBOX_SIZE);
  }

  static async load(store: KeyValueStore): Promise<AnswerRecord[]> {
    try {
      const raw = await store.get(INBOX_KEY);
      const v = raw ? (JSON.parse(raw) as unknown) : [];
      if (!Array.isArray(v)) return [];
      const seen = new Set<string>();
      return v.filter(valid).filter((r) => !seen.has(r.jobId) && seen.add(r.jobId)).slice(0, INBOX_SIZE);
    } catch {
      return [];
    }
  }

  get records(): readonly AnswerRecord[] { return this.list; }
  get size(): number { return this.list.length; }

  has(jobId: string): boolean { return this.list.some((r) => r.jobId === jobId); }
  get(jobId: string): AnswerRecord | undefined { return this.list.find((r) => r.jobId === jobId); }

  /** Unseen answers other than `except`. */
  unseenCount(except?: string): number {
    return this.list.filter((r) => !r.seen && r.jobId !== except).length;
  }

  /** Newest unseen answer other than `except`. */
  nextUnseen(except?: string): AnswerRecord | undefined {
    return this.list.find((r) => !r.seen && r.jobId !== except);
  }

  /**
   * Adds a new answer at the front. A later page of the same question replaces
   * the earlier answer. Returns false for an answer that is already here, so a
   * re-delivered result after a restart is not shown again as new.
   */
  add(r: AnswerRecord, replaces?: string): boolean {
    if (this.has(r.jobId)) return false;
    this.list = [r, ...this.list.filter((x) => x.jobId !== replaces)].slice(0, INBOX_SIZE);
    return true;
  }

  /**
   * Adds an old result from a catch-up, already marked seen. It goes in by its
   * server sequence number, after every newer answer, so a catch-up delivered
   * oldest first can never push the answers the phone kept out of the list.
   * Returns false if it is already here or too old to keep.
   */
  addHistory(r: AnswerRecord): boolean {
    if (this.has(r.jobId)) return false;
    const rec = { ...r, seen: true };
    let i = this.list.findIndex((x) => x.seq !== undefined && rec.seq !== undefined && x.seq < rec.seq);
    if (i < 0) i = this.list.length;
    if (i >= INBOX_SIZE) return false;
    this.list = [...this.list.slice(0, i), rec, ...this.list.slice(i)].slice(0, INBOX_SIZE);
    return true;
  }

  markSeen(jobId: string): boolean {
    const r = this.get(jobId);
    if (!r || r.seen) return false;
    this.list = this.list.map((x) => (x.jobId === jobId ? { ...x, seen: true } : x));
    return true;
  }

  /** Writes are serialised; the promise resolves when this state is stored (or the write failed). */
  save(): Promise<void> {
    const snapshot = JSON.stringify(this.list);
    this.writing = this.writing.then(async () => {
      try { await this.store.set(INBOX_KEY, snapshot); } catch { /* kept in memory; written again on the next change */ }
    });
    return this.writing;
  }
}
