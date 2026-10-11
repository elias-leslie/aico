import { describe, expect, it } from 'vitest'
import { PaneExitReconciliationQueue } from './pane-exit-queue'

interface Pass {
  serverId: string
  settle: (resolved: boolean) => void
  fail: (error: unknown) => void
}

function harness() {
  const passes: Pass[] = []
  const errors: Array<[string, unknown]> = []
  const state = { quitting: false }
  const queue = new PaneExitReconciliationQueue({
    reconcile: (serverId) =>
      new Promise<boolean>((resolve, reject) => {
        passes.push({ serverId, settle: resolve, fail: reject })
      }),
    isQuitting: () => state.quitting,
    onError: (serverId, error) => errors.push([serverId, error]),
  })
  return { queue, passes, errors, state }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('PaneExitReconciliationQueue', () => {
  it('clears unresolved state after a resolved pass', async () => {
    const { queue, passes } = harness()
    queue.observe('s1')
    expect(passes.map((p) => p.serverId)).toEqual(['s1'])
    passes[0].settle(true)
    await flush()

    queue.retryUnresolved('s1')
    expect(passes).toHaveLength(1)
  })

  it('keeps a server unresolved after an unresolved pass so a retry reruns it', async () => {
    const { queue, passes } = harness()
    queue.observe('s1')
    passes[0].settle(false)
    await flush()

    queue.retryUnresolved('s1')
    expect(passes).toHaveLength(2)
  })

  it('coalesces exits during a pass into one dirty follow-up', async () => {
    const { queue, passes } = harness()
    queue.observe('s1')
    queue.observe('s1')
    queue.observe('s1')
    expect(passes).toHaveLength(1)

    // A dirty pass never resolves the server, even when it reports resolved.
    passes[0].settle(true)
    await flush()
    expect(passes).toHaveLength(2)

    passes[1].settle(true)
    await flush()
    expect(passes).toHaveLength(2)
    queue.retryUnresolved('s1')
    expect(passes).toHaveLength(2)
  })

  it('holds a deferred server unresolved until its owner releases', async () => {
    const { queue, passes } = harness()
    queue.observe('s1')
    queue.defer('s1')
    expect(queue.isDeferred('s1')).toBe(true)
    passes[0].settle(true)
    await flush()
    expect(passes).toHaveLength(1)

    queue.releaseDeferred('s1')
    expect(queue.isDeferred('s1')).toBe(false)
    expect(passes).toHaveLength(2)
    passes[1].settle(true)
    await flush()

    queue.retryUnresolved('s1')
    expect(passes).toHaveLength(2)
  })

  it('does not resolve a server whose pass ended with a pending deferral', async () => {
    const { queue, passes } = harness()
    queue.observe('s1')
    queue.defer('s1')
    passes[0].settle(true)
    await flush()

    queue.retryUnresolved('s1')
    expect(passes).toHaveLength(2)
  })

  it('ignores a release with no matching deferral', () => {
    const { queue, passes } = harness()
    queue.releaseDeferred('s1')
    expect(passes).toHaveLength(0)
  })

  it('coalesces a release that arrives during a pass', async () => {
    const { queue, passes } = harness()
    queue.observe('s1')
    queue.defer('s1')
    queue.releaseDeferred('s1')
    expect(passes).toHaveLength(1)

    passes[0].settle(true)
    await flush()
    expect(passes).toHaveLength(2)
  })

  it('reports a failed pass and leaves the server unresolved', async () => {
    const { queue, passes, errors } = harness()
    const failure = new Error('tmux unavailable')
    queue.observe('s1')
    passes[0].fail(failure)
    await flush()
    expect(errors).toEqual([['s1', failure]])

    queue.retryUnresolved('s1')
    expect(passes).toHaveLength(2)
  })

  it('starts no pass while quitting but still records the observed exit', async () => {
    const { queue, passes, state } = harness()
    state.quitting = true
    queue.observe('s1')
    expect(passes).toHaveLength(0)

    state.quitting = false
    queue.retryUnresolved('s1')
    expect(passes).toHaveLength(1)
  })

  it('drops a dirty follow-up once quitting but keeps the server unresolved', async () => {
    const { queue, passes, state } = harness()
    queue.observe('s1')
    queue.observe('s1')
    state.quitting = true
    passes[0].settle(true)
    await flush()
    expect(passes).toHaveLength(1)

    state.quitting = false
    queue.retryUnresolved('s1')
    expect(passes).toHaveLength(2)
  })

  it('runs servers independently', async () => {
    const { queue, passes } = harness()
    queue.observe('s1')
    queue.observe('s2')
    expect(passes.map((p) => p.serverId)).toEqual(['s1', 's2'])

    passes[1].settle(true)
    await flush()
    queue.observe('s2')
    expect(passes.map((p) => p.serverId)).toEqual(['s1', 's2', 's2'])
  })

  it('never retries a server it has not observed', () => {
    const { queue, passes } = harness()
    queue.retryUnresolved('s1')
    expect(passes).toHaveLength(0)
  })
})
