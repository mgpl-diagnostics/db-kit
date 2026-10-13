import { randomBytes } from "node:crypto";
import type { Redis } from "ioredis";

/**
 * Distributed lock: SET key token NX PX ttl, released only by the holder (compare-and-delete in
 * Lua, so an expired lock re-taken by someone else is never deleted by the old holder).
 */
const UNLOCK = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

export async function acquireLock(redis: Redis, key: string, ttlMs: number): Promise<string | null> {
  const token = randomBytes(12).toString("base64url");
  const ok = await redis.set(key, token, "PX", ttlMs, "NX");
  return ok === "OK" ? token : null;
}

export async function releaseLock(redis: Redis, key: string, token: string): Promise<boolean> {
  return (await redis.eval(UNLOCK, 1, key, token)) === 1;
}

export interface LockOptions {
  /** Lock lifetime; the work must finish within it. Default 10 s. */
  ttlMs?: number;
  /** How long to keep trying to acquire. Default 5 s. */
  waitMs?: number;
  /** Delay between attempts. Default 50 ms. */
  retryMs?: number;
}

export class LockTimeoutError extends Error {
  constructor(key: string) {
    super(`Could not acquire lock ${key}`);
    this.name = "LockTimeoutError";
  }
}

/** Runs fn while holding the lock (e.g. one nightly job across many servers). */
export async function withLock<T>(redis: Redis, key: string, fn: () => Promise<T>, o: LockOptions = {}): Promise<T> {
  const ttl = o.ttlMs ?? 10_000;
  const deadline = Date.now() + (o.waitMs ?? 5_000);
  let token: string | null;
  while (!(token = await acquireLock(redis, key, ttl))) {
    if (Date.now() >= deadline) throw new LockTimeoutError(key);
    await new Promise((r) => setTimeout(r, o.retryMs ?? 50));
  }
  try {
    return await fn();
  } finally {
    await releaseLock(redis, key, token);
  }
}
