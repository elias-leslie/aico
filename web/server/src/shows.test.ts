import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  pushTitle,
  registerShowRoutes,
  type Share,
  Shows,
  showNotice,
  validateShare,
} from './shows'
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

function share(overrides: Record<string, unknown> = {}): Share {
  const valid = validateShare(payload(overrides))
  if (!valid) throw new Error('fixture share is invalid')
  return valid
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

  it('accepts several paths without a session, and a URL', () => {
    expect(validateShare(payload({ session: null, paths: ['/a/b.png', '/a/c'] }))).not.toBeNull()
    const url = 'https://example.com/report?a=1&b=2'
    expect(share({ kind: 'url', url, paths: undefined, session: null, title: null })).toMatchObject(
      { url },
    )
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
  it('pushes a fixed notice once per share, with the public host when set', async () => {
    const run = vi.fn(async () => {})
    const shows = new Shows({ tether: tetherWith([]), publicHost: 'aico.example.dev', run })
    await shows.receive(payload())
    await shows.receive(payload())
    await shows.receive({ ...payload(), id: 'not valid' })
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith(
      ['nightshift', 'push', '--json'],
      expect.any(Number),
      JSON.stringify({
        v: 1,
        source: 'aico',
        kind: 'todo',
        severity: 'info',
        title: 'Shared: Report',
        body: 'Open Aico to see it.',
        key: `show:${SHOW_ID}`,
        push: 'tray',
        actions: ['done'],
        primary: 'done',
        open: `https://aico.example.dev/?show=${SHOW_ID}`,
      }),
    )
  })

  it('names what was shared and never puts a URL in the notice', () => {
    expect(pushTitle(share({ title: null, paths: ['/a/image.png', '/a/prompt.md'] }))).toBe(
      'Shared: image.png and 1 more',
    )
    expect(pushTitle(share({ title: null, paths: ['/a/out/'] }))).toBe('Shared: out')
    const link = share({
      kind: 'url',
      url: 'https://secret.example',
      paths: undefined,
      title: null,
    })
    expect(pushTitle(link)).toBe('Shared a link')
    expect(JSON.stringify(showNotice(link, null))).not.toContain('secret.example')
    expect(showNotice(link, null)).not.toHaveProperty('open')
  })

  it('keeps going when a push fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const shows = new Shows({
      tether: tetherWith([]),
      publicHost: null,
      run: async () => {
        throw new Error('offline')
      },
    })
    await expect(shows.receive(payload())).resolves.toBeUndefined()
  })

  it("lists Tether's shares, leaving out any that fail the checks", async () => {
    const shows = new Shows({
      tether: tetherWith([payload(), { ...payload(), id: 'bad' }, payload({ id: 'bbbbbbbbbbbb' })]),
      publicHost: null,
    })
    expect((await shows.list()).map((item) => item.id)).toEqual([SHOW_ID, 'bbbbbbbbbbbb'])
  })
})

describe('share routes', () => {
  let server: Awaited<ReturnType<typeof serveRoutes>>

  beforeEach(async () => {
    const shows = new Shows({
      tether: tetherWith([payload(), payload({ id: 'bbbbbbbbbbbb', title: null })]),
      publicHost: null,
    })
    server = await serveRoutes((router) => registerShowRoutes(router, shows))
  })

  afterEach(async () => {
    await server.close()
  })

  it('lists shares and honours the cursor', async () => {
    const list = async (query = '') =>
      (
        (await (await fetch(`${server.base}/api/shows${query}`)).json()) as { shows: Share[] }
      ).shows.map((item) => item.id)
    expect(await list()).toEqual([SHOW_ID, 'bbbbbbbbbbbb'])
    expect(await list(`?since=${SHOW_ID}`)).toEqual(['bbbbbbbbbbbb'])
    expect(await list('?since=bbbbbbbbbbbb')).toEqual([])
    expect(await list('?since=cccccccccccc')).toEqual([SHOW_ID, 'bbbbbbbbbbbb'])
  })
})
