import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rawType, registerFileLocationRoutes } from './file-locations'
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
  server = await serveRoutes((router) => registerFileLocationRoutes(router))
})

afterEach(async () => {
  await server.close()
  rmSync(top, { recursive: true, force: true })
})

describe('file locations', () => {
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
      ['raw', join(top, 'work'), '../work/prompt.md'],
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

describe('rawType', () => {
  it('treats a file without NUL bytes as text', () => {
    expect(rawType(Buffer.from('plain'))).toEqual({
      type: 'text/plain; charset=utf-8',
      inline: true,
    })
    expect(rawType(Buffer.from([0x25, 0x50, 0x44, 0x46, 0]))).toMatchObject({ inline: false })
  })
})
