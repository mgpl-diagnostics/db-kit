import type { Repo, Repositories } from "../core/ports";
import type { Id } from "../core/types";
import type { Cache } from "./cache";

/**
 * Read-through + write-invalidate decorator for repositories:
 *   get(id)  → cache-aside on "<entity>:<id>" (tagged "<entity>:<id>")
 *   update / delete → database first, then invalidate that tag
 * Lists and searches are not cached (they go stale too easily); cache them explicitly where safe.
 */
function cachedRepo<T extends { id: Id }>(entity: string, inner: Repo<T>, cache: Cache, ttl: number): Repo<T> {
  const tag = (id: Id) => `${entity}:${id}`;
  return {
    ...inner,
    get: (id) => cache.getOrSet(tag(id), () => inner.get(id), { ttl, staleTtl: ttl, negativeTtl: 30, tags: [tag(id)] }),
    async create(data) {
      const out = await inner.create(data);
      await cache.invalidateTags(tag(out.id)); // drop a cached "not found" for this id
      return out;
    },
    async update(id, patch) {
      const out = await inner.update(id, patch);
      await cache.invalidateTags(tag(id));
      return out;
    },
    async delete(id) {
      const out = await inner.delete(id);
      await cache.invalidateTags(tag(id));
      return out;
    },
  };
}

/** Wraps the slow-changing, often-read repositories. Transactions use the uncached ones. */
export function withCache(repos: Repositories, cache: Cache, ttlSeconds = 300): Repositories {
  return {
    ...repos,
    orgs: cachedRepo("org", repos.orgs, cache, ttlSeconds),
    branches: cachedRepo("branch", repos.branches, cache, ttlSeconds),
    roles: cachedRepo("role", repos.roles, cache, ttlSeconds),
    doctors: cachedRepo("doctor", repos.doctors, cache, ttlSeconds),
    patients: { ...repos.patients, ...cachedRepo("patient", repos.patients, cache, 60) },
    ledgers: { ...repos.ledgers, ...cachedRepo("ledger", repos.ledgers, cache, ttlSeconds) },
  };
}
