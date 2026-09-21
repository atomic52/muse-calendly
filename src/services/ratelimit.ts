export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

interface Bucket {
  windowStart: number;
  count: number;
}

/** Fixed-window per-key rate limiter. */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  check(key: string): RateLimitDecision {
    const current = this.now();
    const windowStart = Math.floor(current / this.windowMs) * this.windowMs;
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.windowStart !== windowStart) {
      this.buckets.set(key, { windowStart, count: 1 });
      return { allowed: true, remaining: this.limit - 1, retryAfterSeconds: 0 };
    }
    if (bucket.count >= this.limit) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((windowStart + this.windowMs - current) / 1000),
      );
      return { allowed: false, remaining: 0, retryAfterSeconds };
    }
    bucket.count += 1;
    return { allowed: true, remaining: this.limit - bucket.count, retryAfterSeconds: 0 };
  }
}
