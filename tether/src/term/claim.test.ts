import { describe, expect, it, vi } from 'vitest'
import { TetherError, TetherUnavailable } from '../client/index'
import { coalesceTrailingAsync, createSizeClaim, type SizeClaimDeps } from './claim'

describe('coalescing', () => {
  it('repeats trailing work once for signals that arrive while it runs', async () => {
    let release = (): void => {}
    const work = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const run = coalesceTrailingAsync(work)
    const first = run()
    run()
    run()
    release()
    await Promise.resolve()
    await Promise.resolve()
    release()
    await first
    expect(work).toHaveBeenCalledTimes(2)
  })
})

describe('size claim', () => {
  type Answer = { applied: true; changed: boolean } | { applied: false; reason: string }
  function claim(answers: (Answer | Error)[], overrides: Partial<SizeClaimDeps> = {}) {
    const resizeClaim = vi.fn(async () => {
      const next = answers.shift() ?? { applied: true, changed: false }
      if (next instanceof Error) throw next
      return next
    })
    const deps = {
      tether: { resizeClaim } as unknown as SizeClaimDeps['tether'],
      id: 'aaaaaaaa',
      generation: vi.fn(() => 'g1'),
      link: { pid: 42, cols: 100, rows: 30 },
      viewer: { app: 'desktop', device: 'host' },
      isCurrent: () => true,
      refresh: vi.fn(async () => {}),
      applied: vi.fn(),
      ...overrides,
    }
    return { run: createSizeClaim(deps), deps, resizeClaim }
  }

  it("claims for the link's pid and size under the latest generation, naming the viewer", async () => {
    const { run, deps, resizeClaim } = claim([{ applied: true, changed: true }])
    await run()
    expect(resizeClaim).toHaveBeenCalledWith('aaaaaaaa', 'g1', 42, 100, 30, {
      app: 'desktop',
      device: 'host',
    })
    expect(deps.applied).toHaveBeenCalledWith(true)
  })

  it('retries a client that is not attached yet, then stops after a permanent refusal', async () => {
    const { run, deps, resizeClaim } = claim([
      { applied: false, reason: 'client_not_attached' },
      { applied: false, reason: 'window_linked' },
    ])
    await run()
    expect(resizeClaim).toHaveBeenCalledTimes(2)
    expect(deps.applied).not.toHaveBeenCalled()
  })

  it('re-reads the session on a stale generation and tries again', async () => {
    const { run, deps, resizeClaim } = claim([new TetherError(409, 'stale_generation', {})])
    await run()
    expect(deps.refresh).toHaveBeenCalledTimes(1)
    expect(resizeClaim).toHaveBeenCalledTimes(2)
    expect(deps.applied).toHaveBeenCalledWith(false)
  })

  it('gives up quietly when Tether is down, and never claims for a replaced link', async () => {
    const down = claim([new TetherUnavailable('down')])
    await down.run()
    expect(down.resizeClaim).toHaveBeenCalledTimes(1)
    const gone = claim([], { isCurrent: () => false })
    await gone.run()
    expect(gone.resizeClaim).not.toHaveBeenCalled()
  })
})
