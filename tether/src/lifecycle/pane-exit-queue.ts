export interface PaneExitReconciliationQueueOptions {
  /** One pass over every widget on the server; true when the exit is resolved. */
  reconcile: (serverId: string) => Promise<boolean>
  isQuitting: () => boolean
  onError: (serverId: string, error: unknown) => void
}

/**
 * Coalesces detached pane-exit reconciliation per tmux server. At most one pass
 * runs per server; exits observed during it collapse into one dirty follow-up.
 * A server stays unresolved until a clean pass finishes with no dirty or
 * deferred work, so a later concrete trigger can retry it.
 */
export class PaneExitReconciliationQueue {
  private readonly inFlight = new Map<string, Promise<void>>()
  private readonly dirty = new Set<string>()
  private readonly deferred = new Set<string>()
  private readonly unresolved = new Set<string>()

  constructor(private readonly options: PaneExitReconciliationQueueOptions) {}

  /** A pane-exit event: unresolved until a pass proves otherwise. */
  observe(serverId: string): void {
    this.unresolved.add(serverId)
    this.queue(serverId)
  }

  private queue(serverId: string): void {
    if (this.options.isQuitting()) return
    if (this.inFlight.has(serverId)) {
      // One pass observes every widget on the generation. Coalesce any number of
      // exits during it to one dirty follow-up instead of retaining an unbounded
      // promise/backlog under rapid pane churn.
      this.dirty.add(serverId)
      return
    }
    let resolved = false
    const next: Promise<void> = this.options
      .reconcile(serverId)
      .then((value) => {
        resolved = value
      })
      .catch((error) => this.options.onError(serverId, error))
      .finally(() => {
        if (this.inFlight.get(serverId) === next) this.inFlight.delete(serverId)
        const dirty = this.dirty.delete(serverId)
        if (resolved && !dirty && !this.deferred.has(serverId)) {
          this.unresolved.delete(serverId)
        } else {
          this.unresolved.add(serverId)
        }
        if (dirty) this.queue(serverId)
      })
    this.inFlight.set(serverId, next)
  }

  /** A busy lifecycle owner holds a widget on this server; retry after release. */
  defer(serverId: string): void {
    this.deferred.add(serverId)
  }

  isDeferred(serverId: string): boolean {
    return this.deferred.has(serverId)
  }

  /** The owner released: run the follow-up pass a deferral promised. */
  releaseDeferred(serverId: string): void {
    if (this.deferred.delete(serverId)) this.queue(serverId)
  }

  retryUnresolved(serverId: string): void {
    if (this.unresolved.has(serverId)) this.queue(serverId)
  }
}
