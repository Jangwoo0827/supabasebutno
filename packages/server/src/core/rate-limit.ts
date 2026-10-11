/**
 * In-memory sliding-window rate limiter.
 *
 * Limits: state lives in this process only, so it resets on restart and is not shared
 * between multiple server instances. That is fine for the single-container deployment
 * this project targets; use a shared store if you ever scale out.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private sinceSweep = 0;

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 50_000,
  ) {}

  /** Number of recorded hits for `key` inside the window. */
  count(key: string): number {
    const list = this.hits.get(key);
    if (!list) return 0;
    const cutoff = this.now() - this.windowMs;
    while (list.length && list[0]! <= cutoff) list.shift();
    if (list.length === 0) this.hits.delete(key);
    return list.length;
  }

  /** True while `key` is still under the limit (does not record anything). */
  allowed(key: string): boolean {
    return this.count(key) < this.limit;
  }

  /** Records one hit. Returns false if the key was already at its limit (the hit is then not recorded). */
  hit(key: string): boolean {
    if (!this.allowed(key)) return false;
    const list = this.hits.get(key);
    if (list) list.push(this.now());
    else {
      this.hits.set(key, [this.now()]);
      this.sweepIfNeeded();
    }
    return true;
  }

  /** Seconds until the oldest hit leaves the window (for Retry-After). */
  retryAfterSeconds(key: string): number {
    const list = this.hits.get(key);
    if (!list?.length) return 0;
    return Math.max(1, Math.ceil((list[0]! + this.windowMs - this.now()) / 1000));
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  /** Bounds memory: drops expired keys and, if still too many, the oldest keys. */
  private sweepIfNeeded(): void {
    if (++this.sinceSweep < 1000 && this.hits.size < this.maxKeys) return;
    this.sinceSweep = 0;
    const cutoff = this.now() - this.windowMs;
    for (const [key, list] of this.hits) {
      if (list.length === 0 || list[list.length - 1]! <= cutoff) this.hits.delete(key);
    }
    for (const key of this.hits.keys()) {
      if (this.hits.size <= this.maxKeys) break;
      this.hits.delete(key); // Map iterates in insertion order: oldest first
    }
  }
}
