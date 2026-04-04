/**
 * LRU-bounded line cache for demand-paged scrollback.
 *
 * Stores scrollback lines fetched via scroll_request messages. Uses an LRU
 * eviction policy to bound memory. Deduplicates in-flight page requests.
 */

interface CachedLine {
  content: string
  accessedAt: number
}

const DEFAULT_MAX_ENTRIES = 5000

export class ScrollbackLineCache {
  private lines: Map<number, CachedLine> = new Map()
  private pendingRequests: Set<string> = new Set()
  private maxEntries: number

  constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = maxEntries
  }

  setLines(fromLine: number, lines: string[]): void {
    const now = Date.now()
    for (let i = 0; i < lines.length; i++) {
      this.lines.set(fromLine + i, { content: lines[i], accessedAt: now })
    }
    // Clear pending request for this range
    this.pendingRequests.delete(`${fromLine}:${lines.length}`)
    this.evict()
  }

  getLine(index: number): CachedLine | undefined {
    const entry = this.lines.get(index)
    if (entry) {
      entry.accessedAt = Date.now()
    }
    return entry
  }

  hasRange(fromLine: number, count: number): boolean {
    for (let i = fromLine; i < fromLine + count; i++) {
      if (!this.lines.has(i)) return false
    }
    return true
  }

  isRequestPending(fromLine: number, count: number): boolean {
    return this.pendingRequests.has(`${fromLine}:${count}`)
  }

  markRequestPending(fromLine: number, count: number): void {
    this.pendingRequests.add(`${fromLine}:${count}`)
  }

  clear(): void {
    this.lines.clear()
    this.pendingRequests.clear()
  }

  get size(): number {
    return this.lines.size
  }

  private evict(): void {
    if (this.lines.size <= this.maxEntries) return

    // Sort by accessedAt, remove oldest entries
    const entries = Array.from(this.lines.entries()).sort(
      (a, b) => a[1].accessedAt - b[1].accessedAt,
    )
    const toRemove = entries.length - this.maxEntries
    for (let i = 0; i < toRemove; i++) {
      this.lines.delete(entries[i][0])
    }
  }
}
