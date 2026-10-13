/**
 * Tiny in-process LRU with per-entry expiry: the L1 tier in front of Redis. A Map keeps insertion
 * order, so re-inserting on read moves an entry to the "recent" end and the first key is the oldest.
 */
export class Lru<V> {
  private map = new Map<string, { v: V; exp: number }>();

  constructor(private readonly max = 1000) {}

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.exp <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, e);
    return e.v;
  }

  set(key: string, v: V, ttlMs: number): void {
    if (ttlMs <= 0) return;
    this.map.delete(key);
    this.map.set(key, { v, exp: Date.now() + ttlMs });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
