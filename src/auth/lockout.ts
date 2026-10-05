/**
 * Brute-force protection for the login page: after too many wrong passwords
 * within the window, a username (or client IP) is locked until the oldest
 * counted failure leaves the window. In memory only; a restart clears it.
 */

const WINDOW_MS = 15 * 60 * 1000;

export class Lockout {
  private failures = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = WINDOW_MS,
  ) {}

  private recent(key: string, now: number): number[] {
    const times = (this.failures.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (times.length) this.failures.set(key, times);
    else this.failures.delete(key);
    return times;
  }

  /** Milliseconds until the key may try again, or 0 if it is not locked. */
  lockedFor(key: string, now = Date.now()): number {
    const times = this.recent(key, now);
    if (times.length < this.limit) return 0;
    return times[times.length - this.limit] + this.windowMs - now;
  }

  /** Record a failure; returns true if the key is now locked. */
  fail(key: string, now = Date.now()): boolean {
    const times = this.recent(key, now);
    times.push(now);
    this.failures.set(key, times);
    return times.length >= this.limit;
  }

  clear(key: string): void {
    this.failures.delete(key);
  }
}
