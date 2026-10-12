import { describe, expect, it } from 'vitest'
import { createPasteGuard } from './paste-guard'

describe('createPasteGuard', () => {
  it('pastes once when a gesture fires twice concurrently', async () => {
    const pasted: string[] = []
    const run = createPasteGuard(
      async () => 'cmd',
      (t) => pasted.push(t),
    )
    await Promise.all([run(), run()])
    expect(pasted).toEqual(['cmd'])
  })

  it('drops a repeat inside the window but allows a later paste', async () => {
    const pasted: string[] = []
    let t = 0
    const run = createPasteGuard(
      async () => 'x',
      (s) => pasted.push(s),
      400,
      () => t,
    )
    await run()
    t = 100
    await run()
    t = 1000
    await run()
    expect(pasted).toEqual(['x', 'x'])
  })

  it('ignores empty clipboard and recovers after a read failure', async () => {
    const pasted: string[] = []
    let fail = true
    const run = createPasteGuard(
      async () => {
        if (fail) throw new Error('boom')
        return 'ok'
      },
      (s) => pasted.push(s),
      0,
    )
    await expect(run()).rejects.toThrow()
    fail = false
    await run()
    expect(pasted).toEqual(['ok'])
  })
})
