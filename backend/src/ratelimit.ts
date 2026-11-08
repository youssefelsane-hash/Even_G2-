// Small in-memory limiters. They reset on restart, which is acceptable for a
// single-user server: their job is to stop a stuck button or a token-guessing
// script, not to bill anyone.

// Token bucket: `perMinute` requests per minute, with bursts up to `perMinute`.
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  private readonly perMinute: number;
  private readonly now: () => number;

  constructor(perMinute: number, now: () => number = Date.now) {
    this.perMinute = perMinute;
    this.now = now;
  }

  // Returns 0 when allowed, otherwise the number of seconds to wait.
  take(key: string): number {
    if (this.perMinute <= 0) return 0;
    const t = this.now();
    const rate = this.perMinute / 60_000; // tokens per ms
    const b = this.buckets.get(key) ?? { tokens: this.perMinute, at: t };
    b.tokens = Math.min(this.perMinute, b.tokens + (t - b.at) * rate);
    b.at = t;
    this.buckets.set(key, b);
    if (this.buckets.size > 10_000) this.prune(t);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil((1 - b.tokens) / rate / 1000));
  }

  private prune(t: number): void {
    for (const [k, b] of this.buckets) if (t - b.at > 120_000) this.buckets.delete(k);
  }
}

// Counts failed logins per address. After `limit` failures inside a minute the
// address is blocked for `blockMs`, even with a correct token.
export class FailureBlocker {
  private entries = new Map<string, { count: number; windowStart: number; blockedUntil: number }>();
  private readonly limit: number;
  private readonly blockMs: number;
  private readonly now: () => number;

  constructor(limit: number, blockMs: number, now: () => number = Date.now) {
    this.limit = limit;
    this.blockMs = blockMs;
    this.now = now;
  }

  // Seconds the address must still wait, or 0.
  blocked(key: string): number {
    const e = this.entries.get(key);
    if (!e) return 0;
    const left = e.blockedUntil - this.now();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  fail(key: string): void {
    if (this.limit <= 0) return;
    const t = this.now();
    let e = this.entries.get(key);
    if (!e || t - e.windowStart > 60_000) {
      e = { count: 0, windowStart: t, blockedUntil: e?.blockedUntil ?? 0 };
      this.entries.set(key, e);
    }
    e.count++;
    if (e.count >= this.limit) e.blockedUntil = t + this.blockMs;
    if (this.entries.size > 10_000) {
      for (const [k, v] of this.entries) if (t - v.windowStart > 60_000 && v.blockedUntil < t) this.entries.delete(k);
    }
  }
}
