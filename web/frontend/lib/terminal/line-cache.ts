/**
 * Client-side line cache for delta-based scrollback sync.
 *
 * Stores lines by stable index (base_offset + position). Applies incoming
 * deltas and rejects stale sequence numbers. Full content is reconstructed
 * via toFullContent() for snapshot application.
 */

export interface ScrollbackDelta {
  seqno: number
  base: number
  changes: [number, string][] // [stable_index, content]
  removals: number[]
  total_lines: number
  cursor?: [number, number]
}

export class LineCache {
  private lines: Map<number, string> = new Map()
  private lastSeqno: number = 0

  /**
   * Apply a delta from the server.
   * @returns false if the delta was stale (seqno <= lastSeqno).
   */
  applyDelta(delta: ScrollbackDelta): boolean {
    if (delta.seqno <= this.lastSeqno) {
      return false
    }
    this.lastSeqno = delta.seqno

    for (const idx of delta.removals) {
      this.lines.delete(idx)
    }
    for (const [idx, content] of delta.changes) {
      this.lines.set(idx, content)
    }

    return true
  }

  /**
   * Reconstruct full content from cached lines.
   */
  toFullContent(): string {
    if (this.lines.size === 0) return ''
    const indices = Array.from(this.lines.keys()).sort((a, b) => a - b)
    return indices.map((i) => this.lines.get(i)!).join('\r\n')
  }

  reset(): void {
    this.lines.clear()
    this.lastSeqno = 0
  }

  get size(): number {
    return this.lines.size
  }
}
