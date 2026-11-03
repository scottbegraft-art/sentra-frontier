/**
 * Small per-key sliding-window rate limiter (Phase 1C, Priority 2).
 * Pure in-memory, no dependencies. Used for billable endpoints only.
 * Returns false when the caller has exceeded `limit` calls in `windowMs`.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number = 60_000,
  ) {}

  allow(key: string, nowMs: number = Date.now()): boolean {
    const cutoff = nowMs - this.windowMs;
    const kept = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (kept.length >= this.limit) {
      this.hits.set(key, kept);
      return false;
    }
    kept.push(nowMs);
    this.hits.set(key, kept);
    return true;
  }
}
