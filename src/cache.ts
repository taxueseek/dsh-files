// Bounded LRU cache for parsed document text. Keys are the fs target key plus
// the stat version token (the same freshness token dsh-fs write guards rely
// on), so an edited file never serves stale text while unchanged files are
// parsed at most once per process.
//
// Budget is enforced on BOTH entry count and total bytes: a 24 MiB PDF can
// yield several MiB of extracted text, so a pure entry-count cap lets memory
// balloon. `maxBytes` bounds the estimated retained size (2 bytes per char).

export interface CacheKey {
  targetKey: string
  version: string
  format: string
  /** XLSX sheet 维度：按 sheet 单独缓存，互不污染。 */
  sheet?: number
  /** XLSX list_sheets 维度：列名结果与全量读取分开缓存。 */
  listSheets?: boolean
}

export class ParseCache {
  private readonly map = new Map<string, string>()
  /** in-flight 解析去重：并发同 key 只解析一次，其余 await 同一 promise。 */
  private readonly inflight = new Map<string, Promise<string>>()
  private readonly maxEntries: number
  private readonly maxBytes: number
  private bytes = 0

  constructor(maxEntries: number, maxBytes = 64 * 1024 * 1024) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error(`ParseCache: maxEntries must be a positive integer, got ${maxEntries}`)
    }
    if (!Number.isInteger(maxBytes) || maxBytes < 1) {
      throw new Error(`ParseCache: maxBytes must be a positive integer, got ${maxBytes}`)
    }
    this.maxEntries = maxEntries
    this.maxBytes = maxBytes
  }

  get(key: CacheKey): string | undefined {
    const k = this.keyOf(key)
    const hit = this.map.get(k)
    if (hit !== undefined) {
      // Refresh recency.
      this.map.delete(k)
      this.map.set(k, hit)
    }
    return hit
  }

  set(key: CacheKey, text: string): void {
    const k = this.keyOf(key)
    if (this.map.has(k)) {
      this.bytes -= this.sizeOf(this.map.get(k) as string)
      this.map.delete(k)
    }
    const size = this.sizeOf(text)
    this.map.set(k, text)
    this.bytes += size
    // Evict by count first, then by byte budget (oldest first).
    while ((this.map.size > this.maxEntries || this.bytes > this.maxBytes) && this.map.size > 0) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      const evicted = this.map.get(oldest) as string
      this.bytes -= this.sizeOf(evicted)
      this.map.delete(oldest)
    }
  }

  /**
   * Get-or-compute with in-flight dedup: concurrent callers with the same key
   * share one compute promise, so a large PDF is parsed once even when several
   * agents page it simultaneously (isConcurrencySafe: true admits parallelism).
   */
  async getOrCompute(key: CacheKey, compute: () => Promise<string>): Promise<string> {
    const k = this.keyOf(key)
    const hit = this.map.get(k)
    if (hit !== undefined) {
      // Refresh recency.
      this.map.delete(k)
      this.map.set(k, hit)
      return hit
    }
    const existing = this.inflight.get(k)
    if (existing !== undefined) return existing
    const running = (async () => {
      const text = await compute()
      this.set(key, text)
      return text
    })()
    this.inflight.set(k, running)
    try {
      return await running
    } finally {
      // 只删自己的 promise：并发期间新来的调用会复用同一个，谁完成谁删。
      if (this.inflight.get(k) === running) this.inflight.delete(k)
    }
  }

  clear(): void {
    this.map.clear()
    this.bytes = 0
  }

  get size(): number {
    return this.map.size
  }

  get totalBytes(): number {
    return this.bytes
  }

  /** Estimated retained bytes; strings are UTF-16 internally (2 bytes/char). */
  private sizeOf(text: string): number {
    return text.length * 2
  }

  private keyOf(key: CacheKey): string {
    return `${key.targetKey}\u0000${key.version}\u0000${key.format}\u0000${key.sheet ?? ''}\u0000${key.listSheets === true ? 'list' : ''}`
  }
}
