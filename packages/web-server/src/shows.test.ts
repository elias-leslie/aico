import { TetherError } from '@aico/tether-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerShowRoutes, Shows, validateShare } from './shows'
import { serveRoutes } from './testing'

const SHOW_ID = 'ab12cd34ef56'

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SHOW_ID,
    session: 'ab12cd34',
    kind: 'files',
    title: 'Report',
    createdAt: '2026-10-27T10:00:00.000Z',
    paths: ['/srv/workspaces/projects/aico/report.md'],
    ...overrides,
  }
}

function tetherWith(items: unknown) {
  return {
    request: vi.fn(async () => ({ status: 200, body: { items } as never })),
  }
}

describe('validateShare', () => {
  it.each([null, 'Résumé', 'x'.repeat(120)])('accepts files titled %j', (title) => {
    expect(validateShare(payload({ title }))).toEqual(payload({ title }))
  })

  it('keeps a linked host and its not-live mark, and refuses a bad one', () => {
    const away = { host: 'gem', peer: { state: 'offline', since: 1, listedAt: null } }
    expect(validateShare(payload(away))).toEqual(payload(away))
    expect(validateShare(payload({ host: '' }))).toBeNull()
    expect(validateShare(payload({ peer: { state: 'offline' } }))).toBeNull()
  })

  it('accepts several paths without a session, and a URL', () => {
    expect(validateShare(payload({ session: null, paths: ['/a/b.png', '/a/c'] }))).not.toBeNull()
    const url = 'https://example.com/report?a=1&b=2'
    expect(
      validateShare(payload({ kind: 'url', url, paths: undefined, session: null, title: null })),
    ).toMatchObject({ url })
  })

  it.each([
    { id: 'not-hex' },
    { id: 'ab12' },
    { kind: 'file' },
    { session: '../owner' },
    { session: undefined },
    { title: 'x'.repeat(121) },
    { title: 'line\nbreak' },
    { title: 'bidi‮' },
    { createdAt: 'yesterday' },
    { paths: [] },
    { paths: ['relative/path'] },
    { paths: ['/a/../etc/passwd'] },
    { paths: ['/a\nb'] },
    { paths: '/a' },
    { paths: Array.from({ length: 21 }, (_, index) => `/a/${index}`) },
  ])('rejects %j', (overrides) => {
    expect(validateShare(payload(overrides))).toBeNull()
  })

  it.each([
    'javascript:alert(1)',
    'file:///etc/passwd',
    'https:///',
    'https://example.com/\n',
    ' https://example.com',
    `https://example.com/${'x'.repeat(2000)}`,
  ])('rejects the URL %j', (url) => {
    expect(validateShare(payload({ kind: 'url', url, paths: undefined }))).toBeNull()
  })
})

describe('Shows', () => {
  it("lists Tether's shares, leaving out any that fail the checks", async () => {
    const shows = new Shows({
      tether: tetherWith([payload(), { ...payload(), id: 'bad' }, payload({ id: 'bbbbbbbbbbbb' })]),
    })
    expect((await shows.list()).map((item) => item.id)).toEqual([SHOW_ID, 'bbbbbbbbbbbb'])
  })
})

describe('share routes', () => {
  let server: Awaited<ReturnType<typeof serveRoutes>>
  const tether = {
    request: vi.fn(async (method: string, path: string) => {
      if (method === 'DELETE') {
        if (path === '/v1/shares/cccccccccccc') throw new TetherError(404, 'not_found', {})
        return { status: 200, body: { id: path.split('/').pop(), removed: true } as never }
      }
      return {
        status: 200,
        body: { items: [payload(), payload({ id: 'bbbbbbbbbbbb', title: null })] } as never,
      }
    }),
  }

  beforeEach(async () => {
    tether.request.mockClear()
    const shows = new Shows({
      tether,
    })
    server = await serveRoutes((router) => registerShowRoutes(router, shows))
  })

  afterEach(async () => {
    await server.close()
  })

  it('lists shares', async () => {
    const body = (await (await fetch(`${server.base}/api/shows`)).json()) as {
      shows: { id: string }[]
    }
    expect(body.shows.map((item) => item.id)).toEqual([SHOW_ID, 'bbbbbbbbbbbb'])
  })

  it('removes a share through Tether and says plainly when it is gone', async () => {
    const remove = (id: string) => fetch(`${server.base}/api/shows/${id}`, { method: 'DELETE' })
    const done = await remove(SHOW_ID)
    expect(done.status).toBe(200)
    expect(await done.json()).toEqual({ id: SHOW_ID, removed: true })
    expect(tether.request).toHaveBeenCalledWith('DELETE', `/v1/shares/${SHOW_ID}`)
    for (const id of ['cccccccccccc', 'not-an-id']) {
      const gone = await remove(id)
      expect(gone.status).toBe(404)
      expect(await gone.json()).toEqual({ detail: 'That share is already gone' })
    }
    expect(tether.request).toHaveBeenCalledTimes(2)
  })
})
