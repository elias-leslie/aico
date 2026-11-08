import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MOCKUP_CSP, WRAPPED_CSP } from './design-render'
import { filePlaces, rawType, registerFileLocationRoutes } from './file-locations'
import { serveRoutes } from './testing'

let top: string
let server: Awaited<ReturnType<typeof serveRoutes>>

const query = (root: string, path?: string) =>
  `root=${encodeURIComponent(root)}${path === undefined ? '' : `&path=${encodeURIComponent(path)}`}`
const get = (route: string, root: string, path?: string) =>
  fetch(`${server.base}/api/files/${route}?${query(root, path)}`)

beforeEach(async () => {
  top = realpathSync(mkdtempSync(join(tmpdir(), 'aico-locations-')))
  mkdirSync(join(top, 'work'))
  writeFileSync(join(top, 'work', 'prompt.md'), '# Prompt\n')
  writeFileSync(join(top, 'work', 'image.png'), Buffer.from('\x89PNG\r\n\x1a\nrest', 'latin1'))
  writeFileSync(join(top, 'work', 'blob.bin'), Buffer.from([1, 0, 2]))
  writeFileSync(join(top, 'work', '.env'), 'SECRET=1')
  mkdirSync(join(top, '.ssh'))
  writeFileSync(join(top, '.ssh', 'notes'), 'x')
  symlinkSync(join(top, 'work', '.env'), join(top, 'work', 'innocent.txt'))
  server = await serveRoutes((router) =>
    registerFileLocationRoutes(router, { shortcuts: [top, join(top, 'missing')] }),
  )
})

afterEach(async () => {
  await server.close()
  for (const locked of ['locked', 'work/sealed.txt']) {
    try {
      chmodSync(join(top, locked), 0o755)
    } catch {}
  }
  rmSync(top, { recursive: true, force: true })
})

describe('file locations', () => {
  it('shows HTML, SVG, Markdown and PDF rendered, each sandboxed, and refuses the rest', async () => {
    const work = join(top, 'work')
    writeFileSync(join(work, 'page.html'), '<h1>Page</h1>')
    writeFileSync(join(work, 'logo.svg'), '<svg/>')
    writeFileSync(join(work, 'doc.pdf'), '%PDF-1.4 tiny')
    writeFileSync(join(work, 'fake.pdf'), 'not a pdf')
    const page = await get('view', work, 'page.html')
    expect(await page.text()).toBe('<h1>Page</h1>')
    expect(page.headers.get('content-security-policy')).toBe(MOCKUP_CSP)
    const prompt = await get('view', work, 'prompt.md')
    expect(prompt.headers.get('content-security-policy')).toBe(WRAPPED_CSP)
    expect(await prompt.text()).toContain('# Prompt')
    expect(await (await get('view', work, 'logo.svg')).text()).toContain('data:image/svg+xml')
    const pdf = await get('view', work, 'doc.pdf')
    expect(pdf.headers.get('content-type')).toBe('application/pdf')
    expect((await get('view', work, 'fake.pdf')).status).toBe(415)
    expect((await get('view', work, 'blob.bin')).status).toBe(415)
    expect((await get('view', work, '.env')).status).toBe(403)
  })

  it('lists newest first with times when asked, and leaves dotfiles out when asked', async () => {
    const dir = join(top, 'recent')
    mkdirSync(dir)
    for (const [name, secs] of [
      ['old.txt', 1_000],
      ['new.txt', 3_000],
      ['.hidden', 4_000],
      ['mid.txt', 2_000],
    ] as const) {
      writeFileSync(join(dir, name), name)
      utimesSync(join(dir, name), secs, secs)
    }
    const list = async (extra: string) =>
      (await (await fetch(`${server.base}/api/files/tree?${query(dir)}${extra}`)).json()) as {
        entries: { name: string; modified?: number; size?: number }[]
        total: number
      }
    const byTime = await list('&sort=modified')
    expect(byTime.entries.map((entry) => entry.name)).toEqual([
      '.hidden',
      'new.txt',
      'mid.txt',
      'old.txt',
    ])
    expect(byTime.entries[1]).toMatchObject({ modified: 3_000_000, size: 7 })
    const visible = await list('&sort=modified&hidden=0')
    expect(visible.entries.map((entry) => entry.name)).toEqual(['new.txt', 'mid.txt', 'old.txt'])
    expect(visible.total).toBe(3)
    // By name stays the default, with the time on each row.
    const byName = await list('')
    expect(byName.entries.map((entry) => entry.name)).toEqual([
      '.hidden',
      'mid.txt',
      'new.txt',
      'old.txt',
    ])
    expect(byName.entries.every((entry) => typeof entry.modified === 'number')).toBe(true)
  })

  it('lists a folder and reads a file where it is, leaving secrets out', async () => {
    const tree = (await (await get('tree', join(top, 'work'))).json()) as {
      entries: { name: string }[]
    }
    expect(tree.entries.map((entry) => entry.name).sort()).toEqual(
      // innocent.txt links to .env, so it is left out too.
      ['blob.bin', 'image.png', 'prompt.md'].sort(),
    )
    const content = await (await get('content', join(top, 'work'), 'prompt.md')).json()
    expect(content).toMatchObject({ name: 'prompt.md', content: '# Prompt\n', is_binary: false })
  })

  it('serves text and images inline and anything else as a download, sandboxed', async () => {
    const text = await get('raw', join(top, 'work'), 'prompt.md')
    expect(text.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(text.headers.get('content-disposition')).toBe('inline; filename="prompt.md"')
    expect(text.headers.get('content-security-policy')).toContain('sandbox')
    expect(text.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await text.text()).toBe('# Prompt\n')
    const image = await get('raw', join(top, 'work'), 'image.png')
    expect(image.headers.get('content-type')).toBe('image/png')
    const blob = await get('raw', join(top, 'work'), 'blob.bin')
    expect(blob.headers.get('content-type')).toBe('application/octet-stream')
    expect(blob.headers.get('content-disposition')).toBe('attachment; filename="blob.bin"')
  })

  it('refuses secrets, escapes and secret folders', async () => {
    for (const [route, root, path] of [
      ['raw', join(top, 'work'), '.env'],
      ['raw', join(top, 'work'), 'innocent.txt'],
      ['content', join(top, 'work'), '.env'],
      ['tree', join(top, '.ssh'), undefined],
    ] as const) {
      expect((await get(route, root, path)).status).toBe(403)
    }
  })

  it('says what a path is, following links, and refuses secrets', async () => {
    const stat = (path: string) =>
      fetch(`${server.base}/api/files/stat?path=${encodeURIComponent(path)}`)
    symlinkSync(join(top, 'work'), join(top, 'shortcut'))
    expect(await (await stat(join(top, 'shortcut', 'prompt.md'))).json()).toEqual({
      path: join(top, 'work', 'prompt.md'),
      kind: 'file',
    })
    expect(await (await stat(join(top, 'work'))).json()).toEqual({
      path: join(top, 'work'),
      kind: 'folder',
    })
    expect((await stat(join(top, 'work', 'innocent.txt'))).status).toBe(403)
    expect((await stat(join(top, 'missing'))).status).toBe(404)
    expect((await stat('relative')).status).toBe(400)
  })

  it('says a moved or deleted file or folder is gone', async () => {
    expect((await get('raw', join(top, 'work'), 'missing.md')).status).toBe(404)
    expect((await get('tree', join(top, 'gone'))).status).toBe(404)
    expect((await get('tree', 'relative')).status).toBe(400)
  })
})

describe('file locations anywhere', () => {
  it('reads outside the starting folder: up with .., through a symlink out, hidden and build folders listed', async () => {
    mkdirSync(join(top, 'elsewhere', '.hidden'), { recursive: true })
    mkdirSync(join(top, 'elsewhere', 'build'))
    writeFileSync(join(top, 'elsewhere', 'note.txt'), 'outside\n')
    symlinkSync(join(top, 'elsewhere'), join(top, 'work', 'out'))
    expect(
      await (await get('content', join(top, 'work'), '../elsewhere/note.txt')).json(),
    ).toMatchObject({
      content: 'outside\n',
    })
    expect(await (await get('content', join(top, 'work'), 'out/note.txt')).json()).toMatchObject({
      content: 'outside\n',
    })
    expect(await (await get('raw', join(top, 'work'), 'out/note.txt')).text()).toBe('outside\n')
    const listing = (await (await get('tree', join(top, 'elsewhere'))).json()) as {
      entries: { name: string }[]
    }
    expect(listing.entries.map((entry) => entry.name)).toEqual(['.hidden', 'build', 'note.txt'])
  })

  it('shows a symlink as one, saying what it leads to and when it leads nowhere', async () => {
    symlinkSync(join(top, 'work'), join(top, 'to-work'))
    symlinkSync('prompt.md', join(top, 'work', 'link.md'))
    symlinkSync('nowhere', join(top, 'work', 'dead'))
    const top1 = (await (await get('tree', top)).json()) as { entries: Record<string, unknown>[] }
    expect(top1.entries.find((entry) => entry.name === 'to-work')).toMatchObject({
      is_directory: true,
      is_symlink: true,
      link_target: join(top, 'work'),
    })
    const work = (await (await get('tree', join(top, 'work'))).json()) as {
      entries: Record<string, unknown>[]
    }
    expect(work.entries.find((entry) => entry.name === 'link.md')).toMatchObject({
      is_directory: false,
      is_symlink: true,
      link_target: 'prompt.md',
      size: 9,
    })
    expect(work.entries.find((entry) => entry.name === 'dead')).toMatchObject({
      is_symlink: true,
      link_broken: true,
    })
    // Opening the link's folder lists what it leads to.
    const through = (await (await get('tree', top, 'to-work')).json()) as {
      entries: { name: string; path: string }[]
    }
    expect(through.entries.find((entry) => entry.name === 'prompt.md')?.path).toBe(
      'to-work/prompt.md',
    )
  })

  it('says a folder or file this account cannot read is unreadable, not missing', async () => {
    mkdirSync(join(top, 'locked'))
    writeFileSync(join(top, 'locked', 'inside.txt'), 'x')
    writeFileSync(join(top, 'work', 'sealed.txt'), 'x')
    chmodSync(join(top, 'locked'), 0o000)
    chmodSync(join(top, 'work', 'sealed.txt'), 0o000)
    const folder = await get('tree', join(top, 'locked'))
    expect(folder.status).toBe(403)
    expect(((await folder.json()) as { detail: string }).detail).toMatch(/Can’t read this folder/)
    const inside = await get('content', top, 'locked/inside.txt')
    expect(inside.status).toBe(403)
    const file = await get('content', join(top, 'work'), 'sealed.txt')
    expect(file.status).toBe(403)
    expect(((await file.json()) as { detail: string }).detail).toMatch(/Can’t read this file/)
    const raw = await get('raw', join(top, 'work'), 'sealed.txt')
    expect(raw.status).toBe(403)
    const stat = await fetch(
      `${server.base}/api/files/stat?path=${encodeURIComponent(join(top, 'locked', 'inside.txt'))}`,
    )
    expect(stat.status).toBe(403)
  })

  it('pages a large folder', async () => {
    mkdirSync(join(top, 'many'))
    for (let i = 0; i < 12; i += 1)
      writeFileSync(join(top, 'many', `f${String(i).padStart(2, '0')}`), 'x')
    const page = async (offset: number) =>
      (await (
        await fetch(
          `${server.base}/api/files/tree?${query(join(top, 'many'))}&offset=${offset}&limit=5`,
        )
      ).json()) as { entries: { name: string }[]; total: number; offset: number }
    const first = await page(0)
    expect(first).toMatchObject({ total: 12, offset: 0 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['f00', 'f01', 'f02', 'f03', 'f04'])
    const last = await page(10)
    expect(last.entries.map((entry) => entry.name)).toEqual(['f10', 'f11'])
  })

  it('lists Home and the shortcut folders that exist', async () => {
    const places = (await (await fetch(`${server.base}/api/files/places`)).json()) as {
      places: { id: string; label: string; path: string }[]
    }
    expect(places.places).toEqual([
      { id: 'home', label: 'Home', path: homedir() },
      { id: top, label: top, path: top },
    ])
    expect(filePlaces([])).toHaveLength(1)
  })

  it('streams a file of any size as a download once it is too large to open in the browser', async () => {
    writeFileSync(join(top, 'work', 'big.txt'), Buffer.alloc(26 * 1024 * 1024, 97))
    const response = await get('raw', join(top, 'work'), 'big.txt')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="big.txt"')
    expect((await response.arrayBuffer()).byteLength).toBe(26 * 1024 * 1024)
  })
})

describe('rawType', () => {
  it('treats a file without NUL bytes as text', () => {
    expect(rawType(Buffer.from('plain'))).toEqual({
      type: 'text/plain; charset=utf-8',
      inline: true,
    })
    expect(rawType(Buffer.from([0x25, 0x50, 0x44, 0x46, 0]))).toMatchObject({ inline: false })
  })
})
