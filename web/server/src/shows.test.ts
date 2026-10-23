import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_SHOW_BYTES,
  metadata,
  pushArgv,
  registerShowRoutes,
  type Show,
  Shows,
  validateShow,
} from './shows'
import { serveRoutes } from './testing'

const SHOW_ID = 'ab12cd34ef56'
const NAME = `ab12cd34/out/${SHOW_ID}-report.pdf`

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SHOW_ID,
    session: 'ab12cd34',
    kind: 'file',
    title: 'Report',
    name: NAME,
    ...overrides,
  }
}

function show(overrides: Record<string, unknown> = {}): Show {
  const valid = validateShow(payload(overrides))
  if (!valid) throw new Error('fixture show is invalid')
  return valid
}

const hexId = (value: number) => value.toString(16).padStart(12, '0')

describe('validateShow', () => {
  it.each([null, '', 'Résumé', 'x'.repeat(120)])('accepts file metadata titled %j', (title) => {
    expect(metadata(show({ title }))).toEqual(payload({ title }))
  })

  it('accepts a file without a session, and a URL', () => {
    expect(
      validateShow(payload({ session: null, name: `none/out/${SHOW_ID}-file` })),
    ).not.toBeNull()
    const url = 'https://example.com/report?a=1&b=2'
    expect(show({ kind: 'url', name: url, url, session: null, title: null })).toMatchObject({ url })
  })

  it.each([
    { id: 'not-hex' },
    { id: '' },
    { id: 'a'.repeat(65) },
    { id: 12 },
    { kind: 'image' },
    { session: '../owner' },
    { session: 123 },
    { title: 'x'.repeat(121) },
    { title: 123 },
    { title: 'line\nbreak' },
    { title: 'null\x00' },
    { title: 'bidi‮' },
    { title: 'line ' },
    { title: 'surrogate\ud800' },
    { name: '../owner/secrets' },
    { name: '/ab12cd34/out/report.pdf' },
    { name: 'ab12cd34/out/../../secrets' },
    { name: 'ab12cd34/out/report\n' },
    { name: 'ab12cd34/out/hello world' },
    { name: `ab12cd34/out/${'x'.repeat(121)}` },
    { name: 'ab12cd34/out/..' },
    { name: 'ab12cd34/out/.' },
    { name: 'none/out/report' },
    { url: 'https://example.com' },
    { name: null },
  ])('rejects %j', (overrides) => {
    expect(validateShow(payload(overrides))).toBeNull()
  })

  it.each([
    'javascript:alert(1)',
    'file:///etc/passwd',
    'ftp://example.com/a',
    'https:///',
    'https://[',
    'https://example.com:bad/',
    'https://example.com/\n',
    ' https://example.com',
    'https://example.com/‮',
    `https://example.com/${'x'.repeat(2000)}`,
  ])('rejects the URL %j', (url) => {
    expect(validateShow(payload({ kind: 'url', name: url, url }))).toBeNull()
  })
})

describe('Shows', () => {
  it('keeps the last 50 in arrival order and resumes after an id', async () => {
    const shows = new Shows({ exchangeRoot: '/nonexistent', publicHost: null, run: async () => {} })
    // Ids are not chronological.
    for (let index = 0; index < 55; index += 1)
      await shows.receive(payload({ id: hexId(100 - index) }))
    const items = shows.store.recent()
    expect(items).toHaveLength(50)
    expect(items[0].id).toBe(hexId(95))
    expect(shows.store.recent(items[48].id)).toEqual([items[49]])
    expect(shows.store.recent(items[49].id)).toEqual([])
    expect(shows.store.recent('expired')).toEqual(items)
  })

  it('pushes a fixed notice once per valid show, with the public host when set', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const run = vi.fn(async (_argv: string[]) => {})
    const shows = new Shows({
      exchangeRoot: '/nonexistent',
      publicHost: 'terminal.example.test',
      run,
    })
    await shows.receive(payload({ name: '../escape' }))
    await shows.receive('malformed')
    expect(shows.store.recent()).toEqual([])
    await shows.receive(payload({ title: '$(never execute); <title>' }))
    await shows.receive(payload()) // a reconnect replay
    expect(shows.store.recent()).toHaveLength(1)
    expect(run.mock.calls).toEqual([
      [
        [
          'nightshift',
          'push',
          '--title',
          'Agent shared something',
          '--severity',
          'info',
          '--key',
          `show:${SHOW_ID}`,
          '--open',
          `https://terminal.example.test/?show=${SHOW_ID}`,
          'Open Aico to see it.',
        ],
      ],
    ])
    log.mockRestore()
  })

  it('leaves the URL out of the notice and omits --open without a public host', () => {
    const url = 'https://untrusted.example/a?b=1'
    expect(pushArgv(show({ kind: 'url', name: url, url }), null)).toEqual([
      'nightshift',
      'push',
      '--title',
      'Agent shared something',
      '--severity',
      'info',
      '--key',
      `show:${SHOW_ID}`,
      'Open Aico to see it.',
    ])
  })

  it('keeps a show whose push fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const shows = new Shows({
      exchangeRoot: '/nonexistent',
      publicHost: null,
      run: async () => {
        throw new Error('nightshift missing')
      },
    })
    await shows.receive(payload())
    expect(shows.store.get(SHOW_ID)).toBeDefined()
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})

describe('share routes', () => {
  let root: string
  let file: string
  let shows: Shows
  let headerRead: (() => void) | undefined
  let server: Awaited<ReturnType<typeof serveRoutes>>

  const get = (path: string) => fetch(`${server.base}${path}`)
  const fileUrl = `/api/a-term/shows/${SHOW_ID}/file`
  const bytes = async (response: Response) => Buffer.from(await response.arrayBuffer())

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'aico-exchange-'))
    file = join(root, 'agent', NAME)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, 'private report contents')
    shows = new Shows({ exchangeRoot: root, publicHost: null, run: async () => {} })
    headerRead = undefined
    server = await serveRoutes((router) =>
      registerShowRoutes(router, shows, { headerRead: () => headerRead?.() }),
    )
  })

  afterEach(async () => {
    await server.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('lists metadata without contents and honours the cursor', async () => {
    const first = show()
    const second = show({ id: 'bbbbbbbbbbbb', title: null })
    shows.store.add(first)
    shows.store.add(second)
    const response = await get('/api/a-term/shows')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ shows: [metadata(first), metadata(second)] })
    expect(await (await get(`/api/a-term/shows?since=${first.id}`)).json()).toEqual({
      shows: [metadata(second)],
    })
    expect(await (await get(`/api/a-term/shows?since=${second.id}`)).json()).toEqual({ shows: [] })
  })

  it('serves a file as a no-store, nosniff attachment', async () => {
    shows.store.add(show())
    const response = await get(fileUrl)
    expect(response.status).toBe(200)
    expect(await bytes(response)).toEqual(readFileSync(file))
    expect(Object.fromEntries(response.headers)).toMatchObject({
      'content-type': 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
      'content-disposition': `attachment; filename="${basename(file)}"`,
    })
  })

  it.each([
    ['\x89PNG\r\n\x1a\nrest', 'image/png'],
    ['\xff\xd8\xffrest', 'image/jpeg'],
    ['GIF87arest', 'image/gif'],
    ['GIF89arest', 'image/gif'],
    ['RIFFabcdWEBPrest', 'image/webp'],
  ])('serves images inline by their magic bytes, whatever the name (%#)', async (text, mime) => {
    const content = Buffer.from(text, 'latin1')
    writeFileSync(file, content)
    shows.store.add(show())
    const response = await get(fileUrl)
    expect(await bytes(response)).toEqual(content)
    expect(response.headers.get('content-type')).toBe(mime)
    expect(response.headers.get('content-disposition')).toMatch(/^inline;/)
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it.each(["<svg onload='alert(1)'>", '<html>active</html>', 'RIFFabcdWAVE', 'not a PNG'])(
    'serves active or unknown contents as attachments: %s',
    async (content) => {
      writeFileSync(file, content)
      shows.store.add(show())
      const response = await get(fileUrl)
      expect(response.headers.get('content-type')).toBe('application/octet-stream')
      expect(response.headers.get('content-disposition')).toMatch(/^attachment;/)
    },
  )

  it('has no file for unknown or URL shares', async () => {
    expect((await get(fileUrl)).status).toBe(404)
    shows.store.add(show({ kind: 'url', name: 'https://example.com', url: 'https://example.com' }))
    expect((await get(fileUrl)).status).toBe(404)
  })

  it.each(['missing', 'symlink', 'directory', 'fifo', 'large'])(
    'refuses a %s in place of the file',
    async (replacement) => {
      unlinkSync(file)
      if (replacement === 'symlink') symlinkSync('/etc/passwd', file)
      else if (replacement === 'directory') mkdirSync(file)
      else if (replacement === 'fifo') execFileSync('mkfifo', [file])
      else if (replacement === 'large') {
        writeFileSync(file, '')
        truncateSync(file, MAX_SHOW_BYTES + 1)
      }
      shows.store.add(show())
      expect((await get(fileUrl)).status).toBe(replacement === 'large' ? 413 : 404)
    },
  )

  it.each([0, 1, 2, 3])('refuses a symlinked parent %i levels up', async (level) => {
    let parent = dirname(file)
    for (let index = 0; index < level; index += 1) parent = dirname(parent)
    renameSync(parent, `${parent}-moved`)
    symlinkSync(`${parent}-moved`, parent)
    shows.store.add(show())
    expect((await get(fileUrl)).status).toBe(404)
  })

  it('reads the opened file even if the path is swapped meanwhile', async () => {
    const original = readFileSync(file)
    headerRead = () => {
      unlinkSync(file)
      symlinkSync('/etc/passwd', file)
    }
    shows.store.add(show())
    expect(await bytes(await get(fileUrl))).toEqual(original)
  })

  it('stops at the checked size if the agent appends meanwhile', async () => {
    const original = readFileSync(file)
    headerRead = () => appendFileSync(file, 'extra bytes')
    shows.store.add(show())
    expect(await bytes(await get(fileUrl))).toEqual(original)
  })
})
