/** In-memory token bucket per key (a hashed IP, or one site-wide key). Per server instance, which is enough to blunt click flooding. */
export class TokenBucket {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly maxKeys = 10_000
  ) {}

  take(key: string, nowMs: number): boolean {
    let bucket = this.buckets.get(key);
    if (bucket) {
      // Re-inserted so the map stays in least-recently-used order for prune().
      this.buckets.delete(key);
    } else {
      if (this.buckets.size >= this.maxKeys) this.prune(nowMs);
      bucket = { tokens: this.capacity, at: nowMs };
    }
    this.buckets.set(key, bucket);
    const elapsed = Math.max(0, nowMs - bucket.at) / 1000;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerSecond);
    bucket.at = nowMs;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** Seconds until the next token for this key. */
  retryAfter(key: string): number {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.tokens >= 1) return 0;
    return Math.ceil((1 - bucket.tokens) / this.refillPerSecond);
  }

  private prune(nowMs: number) {
    for (const [key, bucket] of this.buckets) {
      const refilled = bucket.tokens + (Math.max(0, nowMs - bucket.at) / 1000) * this.refillPerSecond;
      if (refilled >= this.capacity) this.buckets.delete(key);
    }
    for (const key of this.buckets.keys()) {
      if (this.buckets.size < this.maxKeys) break;
      this.buckets.delete(key);
    }
  }
}
