import { randomBytes } from "node:crypto";
import type { Redis } from "ioredis";

export interface RateLimitResult {
  allowed: boolean;
  /** Requests left in the current window. */
  remaining: number;
  /** Milliseconds until another request is allowed (0 when allowed). */
  retryAfterMs: number;
}

/**
 * Sliding-window log: exact ("at most `limit` in any `windowMs`"), one sorted set per key.
 * Good for logins and OTPs, where precision matters more than memory.
 */
export function slidingWindowLimiter(redis: Redis, o: { limit: number; windowMs: number; prefix?: string }) {
  const prefix = o.prefix ?? "mgpl:__rl:";
  return async function hit(key: string): Promise<RateLimitResult> {
    const full = prefix + key;
    const now = Date.now();
    const member = `${now}:${randomBytes(4).toString("hex")}`;
    const res = await redis
      .multi()
      .zremrangebyscore(full, 0, now - o.windowMs)
      .zadd(full, now, member)
      .zcard(full)
      .zrange(full, 0, 0, "WITHSCORES")
      .pexpire(full, o.windowMs)
      .exec();
    const count = Number(res?.[2]?.[1] ?? 0);
    if (count <= o.limit) return { allowed: true, remaining: o.limit - count, retryAfterMs: 0 };
    await redis.zrem(full, member); // rejected attempts do not extend the block
    const oldest = Number((res?.[3]?.[1] as string[] | undefined)?.[1] ?? now);
    return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, oldest + o.windowMs - now) };
  };
}

/**
 * Fixed window: one counter per window (INCR + expiry). Cheapest; allows up to 2× `limit` across a
 * window boundary. Good for API quotas.
 */
export function fixedWindowLimiter(redis: Redis, o: { limit: number; windowMs: number; prefix?: string }) {
  const prefix = o.prefix ?? "mgpl:__rlf:";
  return async function hit(key: string): Promise<RateLimitResult> {
    const window = Math.floor(Date.now() / o.windowMs);
    const full = `${prefix}${key}:${window}`;
    const res = await redis.multi().incr(full).pexpire(full, o.windowMs).exec();
    const count = Number(res?.[0]?.[1] ?? 0);
    const resetIn = (window + 1) * o.windowMs - Date.now();
    return count <= o.limit
      ? { allowed: true, remaining: o.limit - count, retryAfterMs: 0 }
      : { allowed: false, remaining: 0, retryAfterMs: resetIn };
  };
}
