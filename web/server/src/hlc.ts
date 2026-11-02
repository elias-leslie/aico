// Hybrid logical clock, in milliseconds. `next()` is `max(Date.now(), last + 1)`,
// so stamps from one clock never repeat or go backwards even when the wall
// clock steps back, and `observe(remote)` pulls the clock past a stamp seen
// from a peer, so an edit made after receiving a row always sorts after it.
// The caller persists `last` (NotesStore keeps it in `meta.hlc_last`).

export class HybridClock {
  private latest: number

  constructor(
    last = 0,
    private readonly now: () => number = Date.now,
  ) {
    this.latest = last
  }

  /** The highest stamp issued or observed. */
  get last(): number {
    return this.latest
  }

  next(): number {
    this.latest = Math.max(this.now(), this.latest + 1)
    return this.latest
  }

  observe(remote: number): void {
    if (Number.isFinite(remote) && remote > this.latest) this.latest = remote
  }
}
