import { describe, expect, it, vi } from 'vitest'
import { coalesceTrailingAsync } from './tmux-view'

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
