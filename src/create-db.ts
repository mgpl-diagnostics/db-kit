import type { Redis } from "ioredis";
import type { Cache, CacheOptions } from "./cache/cache";
import type { Backend, Repositories } from "./core/ports";
import type { MongoOptions } from "./mongo/index";
import type { PgOptions } from "./pg/index";

export interface CreateDbOptions {
  backend: Backend;
  mongo?: MongoOptions;
  pg?: PgOptions;
  /** A Redis connection or URL. Enables `db.cache` and cached repositories. */
  redis?: Redis | string;
  cache?: CacheOptions & {
    /** Cache reads of orgs, branches, roles, doctors, ledgers and patients by id. Default true. */
    repositories?: boolean;
    /** TTL in seconds for cached repositories. Default 300. */
    ttl?: number;
    /** Two-tier cache with cross-server L1 invalidation (opens a second Redis connection). Default false. */
    twoTier?: boolean;
  };
  /** Create collections / tables and indexes on start. Default true. */
  sync?: boolean;
}

export interface Db {
  readonly backend: Backend;
  /** Repositories (cached reads where configured). */
  repos: Repositories;
  /** Uncached repositories. Transactions always use these. */
  rawRepos: Repositories;
  cache?: Cache;
  redis?: Redis;
  close(): Promise<void>;
}

/**
 * One call for any backend framework:
 *   const db = await createDb({ backend: "pg", pg: { url }, redis: "redis://localhost:6379" });
 * The backend packages are imported lazily, so Mongo users never load Sequelize and vice versa.
 */
export async function createDb(o: CreateDbOptions): Promise<Db> {
  const rawRepos =
    o.backend === "mongo"
      ? await (await import("./mongo/index")).createMongoRepositories(o.mongo ?? {})
      : await (await import("./pg/index")).createPgRepositories(o.pg ?? {});
  if (o.sync !== false) await rawRepos.sync();

  let redis: Redis | undefined;
  let subscriber: Redis | undefined;
  let cache: Cache | undefined;
  let repos = rawRepos;
  const ownsRedis = typeof o.redis === "string";
  if (o.redis) {
    const { default: IORedis } = await import("ioredis");
    redis = typeof o.redis === "string" ? new IORedis(o.redis) : o.redis;
    const c = await import("./cache/index");
    if (o.cache?.twoTier) subscriber = redis.duplicate();
    cache = c.createCache(redis, { ...o.cache, ...(o.cache?.twoTier ? { l1: o.cache.l1 || {}, subscriber } : {}) });
    if (o.cache?.repositories !== false) repos = c.withCache(rawRepos, cache, o.cache?.ttl ?? 300);
  }

  return {
    backend: o.backend,
    repos,
    rawRepos,
    cache,
    redis,
    async close() {
      await rawRepos.close();
      subscriber?.disconnect();
      if (ownsRedis) redis?.disconnect();
    },
  };
}
