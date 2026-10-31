/**
 * A token bucket: `capacity` actions at once, refilled at `perSecond`.
 * Used per socket, so one noisy client can't flood a channel.
 */
export class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(
    private readonly capacity: number,
    private readonly perSecond: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.updatedAt = now();
  }

  take(): boolean {
    const now = this.now();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + ((now - this.updatedAt) / 1000) * this.perSecond,
    );
    this.updatedAt = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
