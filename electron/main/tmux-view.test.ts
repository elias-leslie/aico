import { describe, expect, it, vi } from 'vitest'
import { coalesceAsync, coalesceTrailingAsync } from './tmux-view'

describe('coalescing', () => {
  it('shares one pending load and starts a fresh one afterwards', async () => {
    const load = vi.fn(async () => 1)
    const run = coalesceAsync(load)
    await Promise.all([run(), run()])
    await run()
    expect(load).toHaveBeenCalledTimes(2)
  })

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
