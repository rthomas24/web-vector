/** Minimal LRU cache with optional TTL (no dependency). */
export class LRU<K, V> {
  private readonly map = new Map<K, { value: V; expires: number }>();
  constructor(
    private readonly max: number,
    private readonly ttlMs?: number,
    private readonly onEvict?: (key: K, value: V) => void,
  ) {}

  get(key: K): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expires && e.expires < Date.now()) {
      this.map.delete(key);
      this.onEvict?.(key, e.value);
      return undefined;
    }
    // refresh recency
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  set(key: K, value: V, ttlMs?: number): void {
    if (this.map.has(key)) this.map.delete(key);
    const ttl = ttlMs ?? this.ttlMs;
    this.map.set(key, { value, expires: ttl ? Date.now() + ttl : 0 });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as K;
      const ev = this.map.get(oldest);
      this.map.delete(oldest);
      if (ev) this.onEvict?.(oldest, ev.value);
    }
  }

  delete(key: K): boolean {
    const e = this.map.get(key);
    const ok = this.map.delete(key);
    if (e) this.onEvict?.(key, e.value);
    return ok;
  }

  clear(): void {
    if (this.onEvict) for (const [k, e] of this.map) this.onEvict(k, e.value);
    this.map.clear();
  }

  /** Remove expired entries. */
  purge(): number {
    const now = Date.now();
    let n = 0;
    for (const [k, e] of this.map) {
      if (e.expires && e.expires < now) {
        this.map.delete(k);
        this.onEvict?.(k, e.value);
        n++;
      }
    }
    return n;
  }

  get size(): number {
    return this.map.size;
  }

  keys(): K[] {
    return [...this.map.keys()];
  }
}
