import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow, IpcMain, IpcMainEvent } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  copyShownFile,
  createAgentShares,
  MAX_SHOWN_BYTES,
  parseShare,
  previewHtml,
  shownType,
  validShowName,
} from './show'

const id = 'aabbccddeeff'
const name = 'ab12cd34/out/report.pdf'
const file = { id, name, title: 'Report', session: 'ab12cd34', kind: 'file' }
const url = {
  ...file,
  kind: 'url',
  name: 'https://example.com/report',
  url: 'https://example.com/report',
}
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'aico-show-'))
  roots.push(root)
  await mkdir(join(root, 'agent/ab12cd34/out'), { recursive: true })
  return { root, source: join(root, 'agent', name) }
}

describe('shared file names', () => {
  it.each(['ab12cd34/out/report.pdf', 'none/out/image-1.PNG', '01234567/out/a_b.c-d'])(
    'accepts %s',
    (value) => {
      expect(validShowName(value)).toBe(true)
    },
  )
  it.each([
    'ab12cd34',
    'ab12cd34/out/',
    'none',
    '/ab12cd34/out/a',
    'AB12CD34/out/a',
    'ab12cd34/out/../a',
    'ab12cd34/out/a..b',
    'ab12cd34/out/a/b',
    'none/out/.',
    'none/out/a\\b',
    'none/out/a\0b',
    'none/out/a\nb',
    'none/out/a\n',
    'none/out/a b',
    'prefixnone/out/a',
  ])('rejects %s', (value) => {
    expect(validShowName(value)).toBe(false)
  })
  it('rejects malformed event metadata and unsafe URL schemes', () => {
    expect(parseShare(file)).toEqual(file)
    expect(parseShare(url)).toEqual(url)
    for (const change of [
      { id: '../x' },
      { session: {} },
      { title: '\nspoof' },
      { name: '../secret' },
      { kind: 'other' },
    ]) {
      expect(parseShare({ ...file, ...change })).toBeNull()
    }
    for (const value of [
      'javascript:alert(1)',
      'file:///tmp/a',
      'https://',
      'https://example.com/\na',
    ]) {
      expect(parseShare({ ...url, url: value })).toBeNull()
    }
  })
})

describe('preview types and inert HTML', () => {
  it.each([
    ['89504e470d0a1a0a', 'image/png'],
    ['ffd8ffe0', 'image/jpeg'],
    ['474946383761', 'image/gif'],
    ['474946383961', 'image/gif'],
    ['524946460400000057454250', 'image/webp'],
  ])('types %s by its bytes', (hex, type) => {
    expect(shownType(Buffer.from(hex, 'hex'))).toBe(type)
  })
  it('does not mistake truncated signatures, high-bit lookalikes, PDF, or binary for images', () => {
    for (const hex of [
      '89504e47',
      'ffd8',
      '474946',
      'c7c9c6b8b9e1',
      '524946460000000058585858',
      '00ff',
    ]) {
      expect(shownType(Buffer.from(hex, 'hex'))).not.toMatch(/^image\//)
    }
    expect(shownType(Buffer.from('%PDF-1.7\ntext-only PDF data'))).toBe('other')
    expect(shownType(Buffer.from([0xc0, 0xaf]))).toBe('other')
    expect(shownType(Buffer.from([0]))).toBe('other')
  })
  it('previews UTF-8 text, markdown and JSON strictly below 1 MB', () => {
    for (const text of [
      'hello\nworld\t☀',
      '# Report\n[link](https://example.com)',
      '{"ok":true}',
    ]) {
      expect(shownType(Buffer.from(text))).toBe('text')
    }
    expect(shownType(Buffer.alloc(1024 * 1024 - 1, 'a'))).toBe('text')
    expect(shownType(Buffer.alloc(1024 * 1024, 'a'))).toBe('other')
  })
  it('escapes text and titles, and restricts the viewer to inline images and styles', () => {
    const html = previewHtml(Buffer.from('<script>alert(1)</script>&"'), '<img src=x>') ?? ''
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&amp;&quot;')
    expect(html).toContain('<title>&lt;img src=x&gt;</title>')
    expect(html).not.toContain('<script>')
    expect(html).toContain("default-src 'none'; script-src 'none'")
    expect(html).toContain('img-src data:')
    expect(previewHtml(Buffer.from([0]), 'binary')).toBeNull()
    expect(previewHtml(Buffer.from('89504e470d0a1a0a', 'hex'), 'image')).toContain(
      'src="data:image/png;base64,',
    )
  })
})

describe('owner copies', () => {
  it('creates an independent owner copy with traversable directories and readable files', async () => {
    const { root, source } = await fixture()
    await writeFile(source, 'first version')
    const copy = await copyShownFile(root, id, name)
    expect(copy.path).toBe(join(root, 'owner/shown', `${id}-${name}`))
    await writeFile(source, 'changed by agent')
    expect(await readFile(copy.path, 'utf8')).toBe('first version')
    expect(copy.bytes.toString()).toBe('first version')
    for (const directory of [
      'owner',
      'owner/shown',
      `owner/shown/${id}-ab12cd34`,
      `owner/shown/${id}-ab12cd34/out`,
    ]) {
      expect((await stat(join(root, directory))).mode & 0o777).toBe(0o755)
    }
    expect((await stat(copy.path)).mode & 0o777).toBe(0o644)
    expect(await copyShownFile(root, id, name)).toEqual(copy)
    expect(await readFile(copy.path, 'utf8')).toBe('first version')
    await rm(source)
    expect(await copyShownFile(root, id, name)).toEqual(copy)
  })
  it('refuses symlinks in the file or any agent-controlled directory', async () => {
    for (const part of ['agent', 'agent/ab12cd34', 'agent/ab12cd34/out', `agent/${name}`]) {
      const { root } = await fixture()
      await mkdir(join(root, 'elsewhere'))
      const path = join(root, part)
      await rm(path, { recursive: true, force: true })
      await symlink(join(root, 'elsewhere'), path)
      await expect(copyShownFile(root, id, name)).rejects.toThrow()
      expect(await readdir(root)).not.toContain('owner')
    }
  })
  it('refuses non-regular and oversized files before creating owner directories', async () => {
    const { root, source } = await fixture()
    await mkdir(source)
    await expect(copyShownFile(root, id, name)).rejects.toThrow('regular file')
    await rm(source, { recursive: true })
    await writeFile(source, '')
    await truncate(source, MAX_SHOWN_BYTES + 1)
    await expect(copyShownFile(root, id, name)).rejects.toThrow('25 MB')
    expect(await readdir(root)).not.toContain('owner')
  })
  it('requires an existing exchange and owner ownership to create owner/', async () => {
    const { root, source } = await fixture()
    await writeFile(source, 'text')
    await expect(copyShownFile(join(root, 'missing'), id, name)).rejects.toThrow()
    vi.spyOn(process, 'getuid').mockReturnValue((process.getuid?.() ?? 0) + 1)
    await expect(copyShownFile(root, id, name)).rejects.toThrow('owned by you')
    expect(await readdir(root)).not.toContain('owner')
  })
  it('refuses symlinked and agent-writable owner destinations', async () => {
    const { root, source } = await fixture()
    await writeFile(source, 'text')
    await symlink(join(root, 'agent'), join(root, 'owner'))
    await expect(copyShownFile(root, id, name)).rejects.toThrow()
    await rm(join(root, 'owner'))
    await mkdir(join(root, 'owner'))
    await chmod(join(root, 'owner'), 0o777)
    await expect(copyShownFile(root, id, name)).rejects.toThrow('writable only by you')
  })
})

function ui(windowOpen = true) {
  const win = { isDestroyed: () => false, webContents: { send: vi.fn() } }
  const deps = {
    exchangeRoot: '/unused',
    windowFor: () => (windowOpen ? (win as unknown as BrowserWindow) : undefined),
    sessionName: () => 'Research',
    preview: vi.fn(async (_path: string, _title: string) => {}),
    clipboard: { writeText: vi.fn() },
    shell: { showItemInFolder: vi.fn() },
    dialog: {
      showMessageBox: vi.fn(async () => ({ response: 1, checkboxChecked: false })),
      showErrorBox: vi.fn(),
    },
  }
  const shares = createAgentShares(deps)
  const handlers = new Map<string, (event: IpcMainEvent, id: unknown) => void>()
  shares.registerIpc({
    on: (channel, handler) => {
      handlers.set(channel, handler)
      return {}
    },
  } as Pick<IpcMain, 'on'>)
  const click = (sender = win.webContents, shareId = id) =>
    handlers.get('show:file')?.({ sender } as unknown as IpcMainEvent, shareId)
  return { deps, win, shares, click }
}

describe('handoff notifications', () => {
  it('sends the title, known session and full URL with a Copy action', () => {
    const { shares, win, deps } = ui()
    shares.notify(url)
    expect(win.webContents.send).toHaveBeenCalledWith('selection:toast', {
      kind: 'Agent shared: Report',
      snippet: 'Research\nhttps://example.com/report',
      action: { kind: 'copy', text: url.url },
    })
    expect(deps.clipboard.writeText).not.toHaveBeenCalled()
  })
  it('uses the name when the title is empty, and waits for a click from the recipient', async () => {
    const { root, source } = await fixture()
    await writeFile(source, '# Report')
    const { deps, shares, win, click } = ui()
    deps.exchangeRoot = root
    shares.notify({ ...file, title: null })
    expect(win.webContents.send).toHaveBeenCalledWith(
      'selection:toast',
      expect.objectContaining({ kind: `Agent shared: ${name}` }),
    )
    expect(await readdir(root)).not.toContain('owner')
    click({ send: vi.fn() })
    expect(deps.preview).not.toHaveBeenCalled()
    click()
    await vi.waitFor(() => expect(deps.preview).toHaveBeenCalledTimes(1))
    const path = join(root, 'owner/shown', `${id}-ab12cd34`, 'preview.html')
    expect(deps.preview).toHaveBeenCalledWith(path, name)
    expect(await readFile(path, 'utf8')).toBe(previewHtml(Buffer.from('# Report'), name))
    expect(deps.shell.showItemInFolder).not.toHaveBeenCalled()
  })
  it('reveals a PDF copy and reports unsafe file failures', async () => {
    const { root, source } = await fixture()
    await writeFile(source, '%PDF-1.7')
    const { deps, shares, click } = ui()
    deps.exchangeRoot = root
    shares.notify(file)
    click()
    await vi.waitFor(() =>
      expect(deps.shell.showItemInFolder).toHaveBeenCalledWith(
        join(root, 'owner/shown', `${id}-${name}`),
      ),
    )
    expect(deps.preview).not.toHaveBeenCalled()
    await rm(source)
    await symlink('/etc/passwd', source)
    shares.notify({ ...file, id: '001122334455' })
    click(undefined, '001122334455')
    await vi.waitFor(() => expect(deps.dialog.showErrorBox).toHaveBeenCalledTimes(1))
  })
  it('offers Copy in the existing dialog when no widget is open', async () => {
    const { deps, shares } = ui(false)
    deps.dialog.showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    shares.notify(url)
    await vi.waitFor(() =>
      expect(deps.clipboard.writeText).toHaveBeenCalledExactlyOnceWith(url.url),
    )
    expect(deps.dialog.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ buttons: ['Copy', 'Close'], detail: `Research\n${url.url}` }),
    )
  })
  it('drops handoffs while a dialog is open and allows another after dismissal', async () => {
    const { deps, shares } = ui(false)
    const result = { response: 1, checkboxChecked: false }
    let dismiss = (_result: typeof result) => {}
    deps.dialog.showMessageBox.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          dismiss = resolve
        }),
    )
    shares.notify(url)
    shares.notify(file)
    shares.notify({ ...url, id: '001122334455' })
    expect(deps.dialog.showMessageBox).toHaveBeenCalledTimes(1)
    dismiss(result)
    await new Promise<void>((resolve) => setImmediate(resolve))
    shares.notify(url)
    expect(deps.dialog.showMessageBox).toHaveBeenCalledTimes(2)
    expect(deps.preview).not.toHaveBeenCalled()
    expect(deps.clipboard.writeText).not.toHaveBeenCalled()
  })
  it('allows another handoff dialog after a dialog failure', async () => {
    const { deps, shares } = ui(false)
    deps.dialog.showMessageBox.mockRejectedValueOnce(new Error('Dialog failed'))
    shares.notify(url)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(deps.dialog.showErrorBox).toHaveBeenCalledExactlyOnceWith(
      'Could not show shared file',
      'Dialog failed',
    )
    shares.notify(url)
    expect(deps.dialog.showMessageBox).toHaveBeenCalledTimes(2)
  })
  it('shows the original owner copy when the same handoff is clicked again', async () => {
    const { root, source } = await fixture()
    await writeFile(source, '%PDF-1.7 original')
    const { deps, shares, click } = ui()
    deps.exchangeRoot = root
    shares.notify(file)
    click()
    await vi.waitFor(() => expect(deps.shell.showItemInFolder).toHaveBeenCalledTimes(1))
    await writeFile(source, 'Changed to text by the agent')
    shares.notify(file)
    click()
    await vi.waitFor(() => expect(deps.shell.showItemInFolder).toHaveBeenCalledTimes(2))
    expect(deps.shell.showItemInFolder).toHaveBeenLastCalledWith(
      join(root, 'owner/shown', `${id}-${name}`),
    )
    expect(deps.preview).not.toHaveBeenCalled()
    expect(deps.dialog.showErrorBox).not.toHaveBeenCalled()
  })
})
