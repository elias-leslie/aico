import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { drainOutbox, postOrKeep } from './outbox'
import type { StatusRow } from './row'

const row = (id: string, meaning: string): StatusRow => ({
  id,
  what: 'Usage',
  kind: 'job',
  machine: 'a',
  state: 'ok',
  meaning,
})
const dir = () => mkdtempSync(join(tmpdir(), 'outbox-'))

function web() {
  const got: StatusRow[] = []
  const state = { status: 200, down: false }
  const fetchFn = (async (_url: string, init: { body: string }) => {
    if (state.down) throw new TypeError('fetch failed')
    if (state.status === 200) got.push(...(JSON.parse(init.body) as StatusRow[]))
    return new Response('{}', { status: state.status })
  }) as unknown as typeof fetch
  return { got, state, fetchFn }
}

describe('the status outbox', () => {
  it('keeps rows aico-web could not take and sends the newest of each id on the next try', async () => {
    const { got, state, fetchFn } = web()
    const options = { dir: dir(), fetch: fetchFn }
    state.down = true
    expect(await postOrKeep('http://x/rows', [row('a', 'one'), row('b', 'one')], options)).toBe(
      'fetch failed',
    )
    expect(await postOrKeep('http://x/rows', [row('a', 'two')], options)).toBe('fetch failed')
    expect(readdirSync(options.dir)).toHaveLength(2)
    expect(await drainOutbox('http://x/rows', options)).toBe(0)
    state.down = false
    // A later post for another id also carries the waiting rows out.
    expect(await postOrKeep('http://x/rows', [row('c', 'now')], options)).toBeNull()
    expect(got.map((r) => `${r.id}:${r.meaning}`).sort()).toEqual(['a:two', 'b:one', 'c:now'])
    expect(readdirSync(options.dir)).toEqual([])
  })

  it('a fresh row that went out clears its older waiting copy', async () => {
    const { got, state, fetchFn } = web()
    const options = { dir: dir(), fetch: fetchFn }
    state.down = true
    await postOrKeep('http://x/rows', [row('a', 'old')], options)
    state.down = false
    expect(await postOrKeep('http://x/rows', [row('a', 'new')], options)).toBeNull()
    expect(got.map((r) => r.meaning)).toEqual(['new'])
  })

  it('does not keep rows aico-web refuses outright', async () => {
    const { state, fetchFn } = web()
    const options = { dir: dir(), fetch: fetchFn }
    state.status = 400
    await expect(postOrKeep('http://x/rows', [row('a', 'bad')], options)).rejects.toThrow('400')
    expect(readdirSync(options.dir)).toEqual([])
  })
})
