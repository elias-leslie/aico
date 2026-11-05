import { describe, expect, it } from 'vitest'
import { pendingGrants } from './grants'

describe('grant taps', () => {
  it('lists only pending requests using the root-owned link', async () => {
    const result = await pendingGrants(async () => ({
      public_url: 'https://aico.example.test/grants',
      requests: [
        {
          id: 'a'.repeat(32),
          state: 'pending',
          title: 'Open test access?',
          expires: Date.now() / 1000 + 60,
        },
        { id: 'b'.repeat(32), state: 'revoked' },
      ],
    }))
    expect(result).toHaveLength(1)
    expect(result?.[0]?.url).toBe(`https://aico.example.test/grants?request=${'a'.repeat(32)}`)
  })
  it('reports unavailable separately from no pending taps', async () => {
    expect(
      await pendingGrants(async () => {
        throw new Error('offline')
      }),
    ).toBeNull()
    expect(await pendingGrants(async () => ({ requests: [] }))).toEqual([])
  })
})
