import { describe, expect, it, vi } from 'vitest'
import { TetherError, TetherUnavailable } from '../client/index'
import { coalesceTrailingAsync, createSizeClaim, type SizeClaimDeps, sizeAtAttach } from './claim'

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

describe('size at attach', () => {
  const holder = (clientPid: number) => ({
    clientPid,
    cols: 120,
    rows: 40,
    generation: 'g1',
    claimedAt: '',
    viewer: { app: 'desktop', device: 'box' },
  })
  function at(
    answer: { generation: string; holder: ReturnType<typeof holder> | null } | Error,
    window: { cols: number; rows: number; pinned: boolean; clients: number[] } | null,
  ) {
    return sizeAtAttach({
      tether: {
        resizeHolder: vi.fn(async () => {
          if (answer instanceof Error) throw answer
          return answer
        }),
      },
      id: 'abc',
      generation: () => 'g1',
      link: { windowState: async () => window },
    })
  }
  const window = (pinned: boolean, clients: number[]) => ({ cols: 120, rows: 40, pinned, clients })

  it('a session nobody has claimed sizes to its first viewer', async () => {
    expect((await at({ generation: 'g1', holder: null }, window(false, [5]))).claim).toBe(true)
  })

  it('looking at a session someone holds takes nothing, and says who and at what size', async () => {
    const result = await at({ generation: 'g1', holder: holder(7) }, window(true, [5, 7]))
    expect(result).toEqual({ claim: false, holder: holder(7), size: window(true, [5, 7]) })
  })

  it("a holder whose client has gone holds nothing (the viewer's app restarted)", async () => {
    expect((await at({ generation: 'g1', holder: holder(7) }, window(true, [5]))).claim).toBe(true)
  })

  it('a pinned window counts as held when Tether knows no holder (it restarted)', async () => {
    expect((await at({ generation: 'g1', holder: null }, window(true, [5]))).claim).toBe(false)
    expect((await at(new TetherUnavailable('down'), window(true, [5]))).claim).toBe(false)
  })

  it("an older generation's holder is not this session's, and an unanswered window is held", async () => {
    expect((await at({ generation: 'g0', holder: holder(7) }, window(false, [5]))).claim).toBe(true)
    expect((await at({ generation: 'g1', holder: null }, null)).claim).toBe(false)
  })
})
