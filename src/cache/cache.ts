import { randomBytes } from "node:crypto";
import type { Redis } from "ioredis";
import { acquireLock, releaseLock } from "./lock";
import { Lru } from "./lru";
import { decode, encode } from "./serialize";

/**
 * Cache toolkit on Redis. Techniques (each optional, per call):
 *
 *  cache-aside        getOrSet(key, loader): read cache, on miss load and store
 *  TTL jitter         ±10% on every TTL so keys written together do not expire together
 *  single-flight      concurrent misses for one key in this process share one load
 *  stampede lock      across processes, only the lock holder loads; others wait for its value
 *  stale-while-       after `ttl`, serve the stale value for up to `staleTtl` while one caller
 *  revalidate         refreshes it in the background
 *  negative caching   remember "not found" for `negativeTtl` so misses do not hit the database
 *  tags               invalidate groups of keys (e.g. everything about patient 42)
 *  namespaces         versioned prefixes: bump the version to drop a whole namespace in O(1)
 *  two-tier (L1+L2)   in-process LRU in front of Redis; pub/sub keeps L1s on all servers in sync
 */

export interface CacheOptions {
  /** Key prefix, e.g. "mgpl:". */
  prefix?: string;
  /** Default TTL in seconds. Default 300. */
  ttl?: number;
  /** Random TTL spread, 0–1. Default 0.1 (±10%). */
  jitter?: number;
  /** In-process L1 tier. Default off. */
  l1?: { max?: number; ttlMs?: number } | false;
  /**
   * A second Redis connection for subscriptions (e.g. redis.duplicate()). With it, writes and
   * invalidations on any server clear the L1 tier on every server.
   */
  subscriber?: Redis;
}

export interface GetOrSetOptions {
  /** Fresh for this many seconds. */
  ttl?: number;
  /** After `ttl`, serve stale for this many more seconds while refreshing. Default 0 (off). */
  staleTtl?: number;
  /** Cache null/undefined results for this many seconds. Default 0 (do not cache misses). */
  negativeTtl?: number;
  tags?: string[];
  /** Distributed stampede lock. Default true when the loader is likely slow (always safe). */
  lock?: boolean | { ttlMs?: number; waitMs?: number };
  /** Use the L1 tier for this key. Default true when L1 is enabled. */
  l1?: boolean;
}

interface Envelope<T> {
  /** value */
  v: T;
  /** fresh until (epoch ms) */
  f: number;
  /** negative entry */
  n?: 1;
}

export interface CacheStats {
  hits: number;
  misses: number;
  staleHits: number;
  l1Hits: number;
  loads: number;
  lockWaits: number;
}

export type Cache = ReturnType<typeof createCache>;

export function createCache(redis: Redis, options: CacheOptions = {}) {
  const prefix = options.prefix ?? "mgpl:";
  const defaultTtl = options.ttl ?? 300;
  const jitter = options.jitter ?? 0.1;
  const l1 = options.l1 ? new Lru<Envelope<unknown>>(options.l1.max ?? 1000) : null;
  const l1Ttl = options.l1 ? options.l1.ttlMs ?? 5000 : 0;
  const channel = `${prefix}__invalidate`;
  const nodeId = randomBytes(6).toString("hex");
  const inflight = new Map<string, Promise<unknown>>();
  const stats: CacheStats = { hits: 0, misses: 0, staleHits: 0, l1Hits: 0, loads: 0, lockWaits: 0 };

  const k = (key: string) => prefix + key;
  const tagKey = (tag: string) => `${prefix}__tag:${tag}`;
  const lockKey = (key: string) => `${prefix}__lock:${key}`;
  const spread = (seconds: number) => Math.max(1, Math.round(seconds * (1 + (Math.random() * 2 - 1) * jitter)));

  // ---- L1 invalidation across servers
  if (l1 && options.subscriber) {
    const sub = options.subscriber;
    void sub.subscribe(channel);
    sub.on("message", (ch: string, msg: string) => {
      if (ch !== channel) return;
      const { from, keys } = JSON.parse(msg) as { from: string; keys: string[] | "*" };
      if (from === nodeId) return;
      if (keys === "*") l1.clear();
      else for (const key of keys) l1.delete(key);
    });
  }
  const broadcast = async (keys: string[] | "*") => {
    if (l1 && options.subscriber && (keys === "*" || keys.length)) await redis.publish(channel, JSON.stringify({ from: nodeId, keys }));
  };

  async function readRaw<T>(full: string): Promise<Envelope<T> | null> {
    const text = await redis.get(full);
    return text ? decode<Envelope<T>>(text) : null;
  }

  async function write<T>(full: string, value: T, o: GetOrSetOptions, negative = false): Promise<void> {
    const fresh = negative ? (o.negativeTtl ?? 0) : spread(o.ttl ?? defaultTtl);
    if (fresh <= 0) return;
    const hard = fresh + (negative ? 0 : o.staleTtl ?? 0);
    const env: Envelope<T> = { v: value, f: Date.now() + fresh * 1000, ...(negative ? { n: 1 as const } : {}) };
    const multi = redis.multi().set(full, encode(env), "EX", hard);
    for (const tag of o.tags ?? []) multi.sadd(tagKey(tag), full).expire(tagKey(tag), Math.max(hard, 3600));
    await multi.exec();
    if (l1 && o.l1 !== false) l1.set(full, env, Math.min(l1Ttl, fresh * 1000));
    await broadcast([full]);
  }

  /**
   * Loads once per process (single-flight) and, optionally, once across processes (lock).
   * `background`: a stale refresh — when another process holds the lock, skip instead of waiting.
   */
  async function load<T>(full: string, loader: () => Promise<T>, o: GetOrSetOptions, background = false): Promise<T> {
    const running = inflight.get(full) as Promise<T> | undefined;
    if (running) return running;
    const p = (async () => {
      const lockOpt = o.lock ?? true;
      let token: string | null = null;
      if (lockOpt) {
        const lo = typeof lockOpt === "object" ? lockOpt : {};
        token = await acquireLock(redis, lockKey(full), lo.ttlMs ?? 10_000);
        if (!token && background) return undefined as T;
        if (!token) {
          // someone else is loading: wait for their value instead of hitting the database too
          stats.lockWaits++;
          const deadline = Date.now() + (lo.waitMs ?? 3000);
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 25));
            const env = await readRaw<T>(full);
            if (env) return env.v;
          }
        }
      }
      try {
        stats.loads++;
        const value = await loader();
        if (value === null || value === undefined) await write(full, value as T, o, true);
        else await write(full, value, o);
        return value;
      } finally {
        if (token) await releaseLock(redis, lockKey(full), token);
      }
    })();
    inflight.set(full, p);
    try {
      return await p;
    } finally {
      inflight.delete(full);
    }
  }

  async function getOrSet<T>(key: string, loader: () => Promise<T>, o: GetOrSetOptions = {}): Promise<T> {
    const full = k(key);
    const useL1 = l1 && o.l1 !== false;
    if (useL1) {
      const env = l1.get(full) as Envelope<T> | undefined;
      if (env && env.f > Date.now()) {
        stats.l1Hits++;
        return env.v;
      }
    }
    const env = await readRaw<T>(full);
    if (env) {
      if (env.f > Date.now()) {
        stats.hits++;
        if (useL1) l1.set(full, env, Math.min(l1Ttl, env.f - Date.now()));
        return env.v;
      }
      // stale but still stored: serve it, refresh in the background (one refresher thanks to the lock)
      stats.staleHits++;
      void load(full, loader, o, true).catch(() => {});
      return env.v;
    }
    stats.misses++;
    return load(full, loader, o);
  }

  return {
    getOrSet,

    async get<T>(key: string): Promise<T | undefined> {
      const env = await readRaw<T>(k(key));
      return env && env.f > Date.now() ? env.v : undefined;
    },

    /** Write-through: store a value you just saved to the database. */
    async set<T>(key: string, value: T, o: Omit<GetOrSetOptions, "lock" | "negativeTtl"> = {}): Promise<void> {
      await write(k(key), value, o);
    },

    async del(...keys: string[]): Promise<void> {
      if (!keys.length) return;
      const full = keys.map(k);
      await redis.del(...full);
      if (l1) for (const f of full) l1.delete(f);
      await broadcast(full);
    },

    /** Deletes every key stored with any of these tags. */
    async invalidateTags(...tags: string[]): Promise<number> {
      let removed = 0;
      for (const tag of tags) {
        const keys = await redis.smembers(tagKey(tag));
        if (keys.length) removed += await redis.del(...keys);
        await redis.del(tagKey(tag));
        if (l1) for (const key of keys) l1.delete(key);
        await broadcast(keys);
      }
      return removed;
    },

    /**
     * Versioned namespace. Keys live under "ns:<name>:v<version>:"; bump() moves to a new version,
     * so every old key is ignored at once (and expires on its own).
     */
    namespace(name: string) {
      const verKey = `${prefix}__ns:${name}`;
      const version = async () => Number((await redis.get(verKey)) ?? 0);
      return {
        async getOrSet<T>(key: string, loader: () => Promise<T>, o?: GetOrSetOptions) {
          return getOrSet(`ns:${name}:v${await version()}:${key}`, loader, o);
        },
        async bump(): Promise<number> {
          const v = await redis.incr(verKey);
          if (l1) l1.clear();
          await broadcast("*");
          return v;
        },
        version,
      };
    },

    /** Memoises an async function: wrap(fn, (...args) => key, options). */
    wrap<A extends unknown[], R>(fn: (...args: A) => Promise<R>, keyOf: (...args: A) => string, o?: GetOrSetOptions) {
      return (...args: A) => getOrSet(keyOf(...args), () => fn(...args), o);
    },

    stats: (): CacheStats => ({ ...stats }),
    /** Clears this process's L1 tier only. */
    clearLocal: () => l1?.clear(),
  };
}
