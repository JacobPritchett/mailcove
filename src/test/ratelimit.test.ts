import { describe, it, expect } from "vitest";
import { takeToken, type Bucket } from "../ratelimit";

describe("takeToken", () => {
  it("allows up to capacity, then blocks until refill", () => {
    const buckets = new Map<string, Bucket>();
    // 8 immediate calls at t=0 succeed (full bucket), 9th blocked.
    for (let i = 0; i < 8; i++) expect(takeToken(buckets, "u", 0)).toBe(true);
    expect(takeToken(buckets, "u", 0)).toBe(false);
    // After ~0.4s at 3 tokens/sec (~1.2 tokens), one more is allowed.
    expect(takeToken(buckets, "u", 400)).toBe(true);
    expect(takeToken(buckets, "u", 400)).toBe(false);
  });

  it("tracks buckets independently per key", () => {
    const buckets = new Map<string, Bucket>();
    for (let i = 0; i < 8; i++) takeToken(buckets, "a", 0);
    expect(takeToken(buckets, "a", 0)).toBe(false);
    expect(takeToken(buckets, "b", 0)).toBe(true); // separate bucket
  });

  it("caps refill at capacity (no unbounded accrual)", () => {
    const buckets = new Map<string, Bucket>();
    takeToken(buckets, "u", 0); // 7 left
    // A long gap refills to the cap, not beyond.
    for (let i = 0; i < 8; i++) expect(takeToken(buckets, "u", 100_000)).toBe(true);
    expect(takeToken(buckets, "u", 100_000)).toBe(false);
  });
});
