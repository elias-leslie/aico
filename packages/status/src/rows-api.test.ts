import { describe, expect, it } from 'vitest'
import { deleteStatusRow, postStatusRows, statusRowsUrl } from './rows-api'

function recorder() {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchFn = (async (url: URL, init: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response(null, { status: 204 })
  }) as unknown as typeof fetch
  return { calls, fetchFn }
}

describe('status rows API', () => {
  it('resolves the endpoint from an origin or the endpoint itself', () => {
    for (const base of [
      'http://127.0.0.1:3002',
      'http://127.0.0.1:3002/',
      'http://127.0.0.1:3002/api/status/rows',
    ])
      expect(String(statusRowsUrl(base))).toBe('http://127.0.0.1:3002/api/status/rows')
    expect(String(statusRowsUrl('http://127.0.0.1:3002', 'deploy:a b/c'))).toBe(
      'http://127.0.0.1:3002/api/status/rows?id=deploy%3Aa+b%2Fc',
    )
    expect(() => statusRowsUrl('127.0.0.1:3002')).toThrow()
  })

  it('posts the rows as one JSON list and deletes one row by id', async () => {
    const { calls, fetchFn } = recorder()
    await postStatusRows('http://w', [{ id: 'a' }], { timeoutMs: 1000, fetch: fetchFn })
    await deleteStatusRow('http://w', 'a/b', { timeoutMs: 1000, fetch: fetchFn })
    expect(calls[0]).toMatchObject({
      url: 'http://w/api/status/rows',
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '[{"id":"a"}]',
      },
    })
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal)
    expect(calls[1]).toMatchObject({
      url: 'http://w/api/status/rows?id=a%2Fb',
      init: { method: 'DELETE' },
    })
  })
})
