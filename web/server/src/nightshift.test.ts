import { describe, expect, it, vi } from 'vitest'
import { readNightshiftView } from './nightshift'

const URL = 'http://127.0.0.1:3020'
const VIEW = { version: 1, snapshot: { state: 'fresh', age: 60 }, tiles: [] }

function answering(status: number, body: unknown): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as typeof fetch
}

describe('readNightshiftView', () => {
  it("passes Nightshift's view through", async () => {
    const fetchImpl = answering(200, VIEW)
    expect(await readNightshiftView({ nightshiftUrl: `${URL}/` }, fetchImpl)).toEqual({
      available: true,
      view: VIEW,
    })
    expect(vi.mocked(fetchImpl).mock.calls[0][0]).toBe(`${URL}/api/view`)
  })

  it('says Nightshift is not answering instead of showing anything as fine', async () => {
    const down = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED')
    }) as typeof fetch
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await readNightshiftView({ nightshiftUrl: URL }, down)).toEqual({
      available: false,
      reason: 'not_answering',
    })
    expect(await readNightshiftView({ nightshiftUrl: URL }, answering(502, {}))).toEqual({
      available: false,
      reason: 'not_answering',
    })
    expect(
      await readNightshiftView({ nightshiftUrl: URL }, answering(200, { ...VIEW, version: 2 })),
    ).toEqual({ available: false, reason: 'unexpected' })
    expect(await readNightshiftView({ nightshiftUrl: null })).toEqual({
      available: false,
      reason: 'not_configured',
    })
    quiet.mockRestore()
  })
})
