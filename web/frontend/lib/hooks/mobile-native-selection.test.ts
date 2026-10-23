import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../utils/device', () => ({ isMobileDevice: () => true }))

import {
  getLayerSelectionText,
  isNativeSelectionActive,
  NATIVE_SELECTION_LAYER_CLASS,
  setupMobileNativeSelection,
} from './mobile-native-selection'

type Listener = () => void

function makeTerm(lines: Array<{ text: string; wrapped?: boolean }>) {
  const listeners = { write: [] as Listener[], scroll: [] as Listener[] }
  const term = {
    cols: 20,
    rows: lines.length,
    options: { fontFamily: 'monospace', fontSize: 14, theme: {} },
    buffer: {
      active: {
        viewportY: 0,
        getLine: (y: number) =>
          lines[y]
            ? {
                isWrapped: !!lines[y].wrapped,
                translateToString: () => lines[y].text,
              }
            : undefined,
      },
    },
    clearSelection: vi.fn(),
    focus: vi.fn(),
    onWriteParsed: (fn: Listener) => {
      listeners.write.push(fn)
      return { dispose: () => {} }
    },
    onScroll: (fn: Listener) => {
      listeners.scroll.push(fn)
      return { dispose: () => {} }
    },
    onResize: () => ({ dispose: () => {} }),
  }
  return { term, listeners }
}

function mount(lines: Array<{ text: string; wrapped?: boolean }>) {
  const container = document.createElement('div')
  const xterm = document.createElement('div')
  xterm.className = 'xterm'
  const screen = document.createElement('div')
  screen.className = 'xterm-screen'
  xterm.appendChild(screen)
  container.appendChild(xterm)
  document.body.appendChild(container)
  const { term, listeners } = makeTerm(lines)
  const onPaste = vi.fn()
  const cleanup = setupMobileNativeSelection(term as never, container, {
    onPaste,
  })
  const layer = screen.querySelector<HTMLElement>(
    `.${NATIVE_SELECTION_LAYER_CLASS}`,
  )
  if (!layer) throw new Error('layer not mounted')
  return { container, xterm, layer, term, listeners, onPaste, cleanup }
}

function touch(target: HTMLElement, type: string, touches: number) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'touches', {
    value: Array.from({ length: touches }, () => ({ clientX: 5, clientY: 5 })),
  })
  target.dispatchEvent(event)
}

afterEach(() => {
  document.body.replaceChildren()
  document.getSelection()?.removeAllRanges()
})

describe('getLayerSelectionText', () => {
  it('joins soft-wrapped rows and keeps real line breaks', () => {
    const layer = document.createElement('div')
    for (const [text, wrapped] of [
      ['$ echo one', false],
      ['two three', false],
      ['four', true],
      ['five', false],
    ] as const) {
      const row = document.createElement('div')
      if (wrapped) row.dataset.wrapped = '1'
      row.appendChild(document.createTextNode(text))
      layer.appendChild(row)
    }
    document.body.appendChild(layer)
    const rows = Array.from(layer.children)
    const range = document.createRange()
    range.setStart(rows[0].firstChild as Text, 2)
    range.setEnd(rows[2].firstChild as Text, 2)
    expect(getLayerSelectionText(layer, range)).toBe('echo one\ntwo threefo')
  })
})

describe('setupMobileNativeSelection', () => {
  it('shows the rows only while a finger is down', () => {
    const { container, layer } = mount([{ text: 'hello world' }])
    expect(layer.style.display).not.toBe('block')

    touch(container, 'touchstart', 1)
    expect(layer.style.display).toBe('block')
    expect(layer.contentEditable).toBe('true')
    expect(layer.textContent).toBe('hello world')

    touch(container, 'touchend', 0)
    expect(layer.style.display).toBe('none')
    expect(layer.contentEditable).toBe('false')
    expect(isNativeSelectionActive(container)).toBe(false)
  })

  it('keeps a long-press selection and hides it from xterm', () => {
    const { container, xterm, layer, term } = mount([{ text: 'hello world' }])
    const xtermContextMenu = vi.fn()
    xterm.addEventListener('contextmenu', xtermContextMenu)

    touch(container, 'touchstart', 1)
    const menu = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    })
    layer.dispatchEvent(menu)
    touch(container, 'touchend', 0)

    expect(menu.defaultPrevented).toBe(false)
    expect(xtermContextMenu).not.toHaveBeenCalled()
    expect(term.clearSelection).toHaveBeenCalled()
    expect(isNativeSelectionActive(container)).toBe(true)
    expect(layer.style.display).toBe('block')

    // The next touch anywhere ends it, without detaching the row under it.
    const row = layer.firstElementChild
    touch(container, 'touchstart', 1)
    expect(isNativeSelectionActive(container)).toBe(false)
    expect(layer.style.display).toBe('none')
    expect(row?.isConnected).toBe(true)
  })

  it('sends a native-bar paste to the session exactly once', () => {
    const { container, xterm, layer, onPaste } = mount([{ text: 'x' }])
    const xtermPaste = vi.fn()
    xterm.addEventListener('paste', xtermPaste)
    touch(container, 'touchstart', 1)
    layer.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
    )

    const paste = new Event('paste', {
      bubbles: true,
      cancelable: true,
    }) as ClipboardEvent
    Object.defineProperty(paste, 'clipboardData', {
      value: { getData: () => 'ls -la', items: [], files: [] },
    })
    layer.dispatchEvent(paste)

    expect(onPaste).toHaveBeenCalledTimes(1)
    expect(onPaste).toHaveBeenCalledWith('ls -la')
    expect(xtermPaste).not.toHaveBeenCalled()
    expect(paste.defaultPrevented).toBe(true)
    expect(isNativeSelectionActive(container)).toBe(false)
  })

  it('freezes the captured rows when output arrives mid-selection', () => {
    const { container, layer, listeners } = mount([{ text: 'x' }])
    touch(container, 'touchstart', 1)
    layer.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
    )
    for (const fn of listeners.write) fn()
    expect(layer.classList.contains('is-frozen')).toBe(true)
  })
})
