import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScrollbackPage } from '../types'
import { ScrollbackOverlay, trimTrailingBlankLines } from './scrollback-overlay'

const writes = vi.hoisted(() => [] as string[])

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    buffer = { active: { viewportY: 0, baseY: 0, getLine: () => undefined } }
    options = { fontFamily: '', fontSize: 0 }
    loadAddon() {}
    open() {}
    onScroll() {}
    resize() {}
    select() {}
    reset() {}
    write(text: string, done: () => void) {
      writes.push(text)
      done()
    }
    scrollToLine() {}
    scrollToBottom() {}
    scrollToTop() {}
    scrollLines() {}
    refresh() {}
    clearSelection() {}
    getSelection() {
      return ''
    }
  },
}))
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss() {}
    dispose() {}
  },
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function fixture(
  capturePage: (request?: { fromLine?: number; count?: number }) => Promise<ScrollbackPage>,
) {
  const listeners = new Map<string, EventListener>()
  const windowListeners = new Map<string, EventListener>()
  const host = {
    id: '',
    style: { display: '' },
    querySelector: () => null,
    addEventListener: vi.fn((name: string, listener: EventListener) =>
      listeners.set(name, listener),
    ),
  }
  vi.stubGlobal('document', { createElement: () => host })
  vi.stubGlobal('window', {
    addEventListener: vi.fn((name: string, listener: EventListener) =>
      windowListeners.set(name, listener),
    ),
    removeEventListener: vi.fn((name: string, listener: EventListener) => {
      if (windowListeners.get(name) === listener) windowListeners.delete(name)
    }),
  })
  const onDismiss = vi.fn()
  const overlay = new ScrollbackOverlay(
    {
      theme: { background: '#000', foreground: '#fff' },
      fontFamily: 'monospace',
      fontSize: 12,
      size: () => ({ cols: 80, rows: 24 }),
      capturePage,
      writeClipboard: vi.fn(),
      onDismiss,
    },
    { appendChild: vi.fn() } as unknown as HTMLElement,
  )
  const wheelUp = () => {
    const wheel = {
      deltaY: -1,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    }
    listeners.get('wheel')?.(wheel as unknown as Event)
  }
  const pressEscape = () => {
    const event = { key: 'Escape', preventDefault: vi.fn() }
    windowListeners.get('keydown')?.(event as unknown as Event)
    return event
  }
  return { overlay, host, onDismiss, wheelUp, pressEscape, windowListeners }
}

beforeEach(() => writes.splice(0))
afterEach(() => vi.unstubAllGlobals())

describe('scrollback capture trimming', () => {
  it('removes padded screen rows without backtracking across earlier blank screens', () => {
    const capture = `start\n${'\n'.repeat(24)}end\n`
    const started = performance.now()

    expect(trimTrailingBlankLines(capture)).toBe(`start\n${'\n'.repeat(24)}end`)
    expect(performance.now() - started).toBeLessThan(100)
  })

  it('preserves trailing spaces when the capture has no trailing line break', () => {
    expect(trimTrailingBlankLines('prompt   ')).toBe('prompt   ')
  })
})

describe('scrollback overlay pending captures', () => {
  it('lets Escape cancel an initial capture before the page arrives', async () => {
    const pendingPage = deferred<ScrollbackPage>()
    const capturePage = vi
      .fn()
      .mockReturnValueOnce(pendingPage.promise)
      .mockResolvedValueOnce({ fromLine: 0, totalLines: 1, historySize: 0, text: 'fresh\n' })
    const { overlay, pressEscape, windowListeners } = fixture(capturePage)

    const pendingEntry = overlay.enter(-1)
    expect(overlay.opening).toBe(true)
    expect(windowListeners.has('keydown')).toBe(true)
    expect(pressEscape().preventDefault).toHaveBeenCalledOnce()
    expect(overlay.opening).toBe(false)
    expect(windowListeners.has('keydown')).toBe(false)
    await overlay.enter(-1)
    pendingPage.resolve({ fromLine: 0, totalLines: 1, historySize: 0, text: 'stale\n' })
    await pendingEntry

    expect(capturePage).toHaveBeenCalledTimes(2)
    expect(overlay.active).toBe(true)
    expect(writes).toEqual(['fresh'])
  })

  it('keeps an older page from replacing a fresh entry after dismissal', async () => {
    const older = deferred<ScrollbackPage>()
    const capturePage = vi
      .fn()
      .mockResolvedValueOnce({ fromLine: 2, totalLines: 3, historySize: 0, text: 'tail\n' })
      .mockReturnValueOnce(older.promise)
      .mockResolvedValueOnce({ fromLine: 0, totalLines: 1, historySize: 0, text: 'fresh\n' })
    const { overlay, host, onDismiss, wheelUp } = fixture(capturePage)

    await overlay.enter(-1)
    wheelUp()
    expect(capturePage).toHaveBeenNthCalledWith(2, { fromLine: 0, count: 2 })
    overlay.dismiss()
    expect(overlay.active).toBe(false)
    expect(host.style.display).toBe('none')
    await overlay.enter(-1)
    older.resolve({ fromLine: 0, totalLines: 3, historySize: 0, text: 'stale\nolder\n' })
    await older.promise
    await Promise.resolve()

    expect(overlay.active).toBe(true)
    expect(host.style.display).toBe('block')
    expect(writes).toEqual(['tail', 'fresh'])
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('ignores an initial page dismissed in flight even after a newer entry opens', async () => {
    const first = deferred<ScrollbackPage>()
    const capturePage = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ fromLine: 0, totalLines: 1, historySize: 0, text: 'fresh\n' })
    const { overlay, host, onDismiss } = fixture(capturePage)

    const pending = overlay.enter(-1)
    overlay.dismiss()
    await overlay.enter(-1)
    first.resolve({ fromLine: 0, totalLines: 1, historySize: 0, text: 'stale\n' })
    await pending

    expect(capturePage).toHaveBeenCalledTimes(2)
    expect(overlay.active).toBe(true)
    expect(host.style.display).toBe('block')
    expect(writes).toEqual(['fresh'])
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('does not report a rejected older page after dismissal', async () => {
    const older = deferred<ScrollbackPage>()
    const capturePage = vi
      .fn()
      .mockResolvedValueOnce({ fromLine: 1, totalLines: 2, historySize: 0, text: 'tail\n' })
      .mockReturnValueOnce(older.promise)
    const { overlay, wheelUp } = fixture(capturePage)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await overlay.enter(-1)
      wheelUp()
      overlay.dismiss()
      older.reject(new Error('stale failure'))
      await expect(older.promise).rejects.toThrow('stale failure')
      await Promise.resolve()
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
