import { describe, expect, it } from "vitest";
import { SlidingWindowRateLimiter } from "./rateLimit.ts";

describe("api/rateLimit", () => {
  it("allows up to max hits in the window, then blocks, freeing a slot as the window rolls", () => {
    const limiter = new SlidingWindowRateLimiter(3, 60_000);
    expect(limiter.allow("ip-a", 1_000)).toMatchObject({ allowed: true });
    expect(limiter.allow("ip-a", 2_000)).toMatchObject({ allowed: true });
    expect(limiter.allow("ip-a", 3_000)).toMatchObject({ allowed: true });
    const blocked = limiter.allow("ip-a", 4_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    // 61s after the first hit it has rolled out — a slot is free again.
    expect(limiter.allow("ip-a", 62_000)).toMatchObject({ allowed: true });
  });

  it("keys are independent", () => {
    const limiter = new SlidingWindowRateLimiter(1, 60_000);
    expect(limiter.allow("ip-a", 0).allowed).toBe(true);
    expect(limiter.allow("ip-b", 1).allowed).toBe(true);
    expect(limiter.allow("ip-a", 2).allowed).toBe(false);
  });

  it("reports retryAfterSeconds until the earliest slot frees", () => {
    const limiter = new SlidingWindowRateLimiter(1, 10_000);
    limiter.allow("ip-a", 5_000);
    const blocked = limiter.allow("ip-a", 6_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(9); // 15_000 - 6_000 = 9s
  });

  it("ignores windowMs ≤ 0 as a degenerate config rather than crashing", () => {
    const limiter = new SlidingWindowRateLimiter(1, 0);
    expect(limiter.allow("ip-a", 1_000).allowed).toBe(true); // no window → every hit retained
  });
});