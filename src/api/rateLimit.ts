/**
 * Sliding-window rate limiter — in-memory, deterministic, dependency-free.
 *
 * Each key (client IP) may make at most `max` requests per rolling `windowMs`;
 * a hit older than the window rolls out before a new one is admitted. Protects
 * the operator-facing API from accidental or abusive load within a single
 * process. Pure logic — no Fastify coupling — so it is unit-testable and its
 * verdicts can be reproduced exactly.
 */
export interface RateLimitVerdict {
  allowed: boolean;
  /** Seconds until a slot frees; > 0 only when blocked, else 0. */
  retryAfterSeconds: number;
}

export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;

  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }

  allow(key: string, now: number = Date.now()): RateLimitVerdict {
    const cutoff = now - this.windowMs;
    const retained = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (retained.length >= this.max) {
      // The oldest surviving hit + the window is the earliest a slot frees.
      this.hits.set(key, retained);
      const earliestSlot = (retained[0] ?? now) + this.windowMs;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((earliestSlot - now) / 1000)) };
    }
    retained.push(now);
    this.hits.set(key, retained);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}