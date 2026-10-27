import type { BrowserWindow, IpcMain, IpcMainEvent } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentShares, parseShare, shareSummary } from './show'

const id = 'aabbccddeeff'
const files = {
  id,
  title: 'Report',
  session: 'ab12cd34',
  kind: 'files',
  paths: ['/srv/out/report.pdf', '/srv/out/notes/'],
}
const url = {
  id,
  title: 'Report',
  session: 'ab12cd34',
  kind: 'url',
  url: 'https://example.com/report',
}
const WEB = 'https://aico.example'
afterEach(() => {
  vi.restoreAllMocks()
})

describe('shares', () => {
  it('rejects malformed event metadata and unsafe URL schemes', () => {
    expect(parseShare(files)).toEqual(files)
    expect(parseShare(url)).toEqual(url)
    for (const change of [
      { id: '../x' },
      { session: {} },
      { title: '\nspoof' },
      { paths: [] },
      { paths: ['relative/a'] },
      { paths: ['/a\nb'] },
      { kind: 'other' },
    ]) {
      expect(parseShare({ ...files, ...change })).toBeNull()
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
  it('sums up a share by its first file and how many more', () => {
    const summary = (data: Record<string, unknown>) => {
      const share = parseShare(data)
      return share && shareSummary(share)
    }
    expect(summary(files)).toBe('report.pdf and 1 more')
    expect(summary({ ...files, paths: ['/srv/out/'] })).toBe('out')
    expect(summary(url)).toBe(url.url)
  })
})

function ui(windowOpen = true) {
  const win = { isDestroyed: () => false, webContents: { send: vi.fn() } }
  const deps = {
    webUrl: WEB,
    windowFor: () => (windowOpen ? (win as unknown as BrowserWindow) : undefined),
    sessionName: () => 'Research',
    clipboard: { writeText: vi.fn() },
    shell: { openExternal: vi.fn(async (_url: string) => {}) },
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

describe('share notices', () => {
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
  it('opens a file share in the web app on a click from the recipient', () => {
    const { deps, shares, win, click } = ui()
    shares.notify({ ...files, title: null })
    expect(win.webContents.send).toHaveBeenCalledWith('selection:toast', {
      kind: 'Agent shared: report.pdf and 1 more',
      snippet: 'Research',
      action: { kind: 'file', id },
    })
    click({ send: vi.fn() })
    expect(deps.shell.openExternal).not.toHaveBeenCalled()
    click()
    expect(deps.shell.openExternal).toHaveBeenCalledExactlyOnceWith(`${WEB}/?show=${id}`)
    click()
    expect(deps.shell.openExternal).toHaveBeenCalledTimes(1)
  })
  it('offers Copy or Open in the existing dialog when no widget is open', async () => {
    const { deps, shares } = ui(false)
    deps.dialog.showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    shares.notify(url)
    await vi.waitFor(() =>
      expect(deps.clipboard.writeText).toHaveBeenCalledExactlyOnceWith(url.url),
    )
    expect(deps.dialog.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ buttons: ['Copy', 'Close'], detail: `Research\n${url.url}` }),
    )
    deps.dialog.showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    shares.notify(files)
    await vi.waitFor(() =>
      expect(deps.shell.openExternal).toHaveBeenCalledExactlyOnceWith(`${WEB}/?show=${id}`),
    )
    expect(deps.dialog.showMessageBox).toHaveBeenLastCalledWith(
      expect.objectContaining({ buttons: ['Open', 'Close'] }),
    )
  })
  it('drops notices while a dialog is open and allows another after dismissal', async () => {
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
    shares.notify(files)
    shares.notify({ ...url, id: '001122334455' })
    expect(deps.dialog.showMessageBox).toHaveBeenCalledTimes(1)
    dismiss(result)
    await new Promise<void>((resolve) => setImmediate(resolve))
    shares.notify(url)
    expect(deps.dialog.showMessageBox).toHaveBeenCalledTimes(2)
    expect(deps.shell.openExternal).not.toHaveBeenCalled()
    expect(deps.clipboard.writeText).not.toHaveBeenCalled()
  })
  it('allows another dialog after a dialog failure', async () => {
    const { deps, shares } = ui(false)
    deps.dialog.showMessageBox.mockRejectedValueOnce(new Error('Dialog failed'))
    shares.notify(url)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(deps.dialog.showErrorBox).toHaveBeenCalledExactlyOnceWith(
      'Could not open what was shared',
      'Dialog failed',
    )
    shares.notify(url)
    expect(deps.dialog.showMessageBox).toHaveBeenCalledTimes(2)
  })
})
