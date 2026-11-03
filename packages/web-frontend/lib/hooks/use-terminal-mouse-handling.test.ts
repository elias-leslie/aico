import { afterEach, describe, expect, it, vi } from 'vitest'
import { setupTerminalMouseHandling } from './use-terminal-mouse-handling'

type Listener = (e: unknown) => void

function harness({
  mode,
  isMobile = false,
  selection = '',
}: {
  mode: string
  isMobile?: boolean
  selection?: string
}) {
  const capture = new Map<string, Listener>()
  const bubble = new Map<string, Listener>()
  const container = {
    addEventListener: (
      type: string,
      fn: Listener,
      opts?: { capture?: boolean },
    ) => (opts?.capture ? capture : bubble).set(type, fn),
    removeEventListener: () => {},
  } as unknown as HTMLElement
  const term = {
    _core: { coreMouseService: { areMouseEventsActive: true } },
    buffer: { active: { type: 'alternate' } },
    getSelection: () => selection,
  } as never
  setupTerminalMouseHandling(term, container, {
    sessionMode: () => mode,
    isMobile,
  })
  // Fires a trusted press; returns whether the shim took it for local selection.
  const press = (button = 0) => {
    const taken: string[] = []
    capture.get('mousedown')?.({
      type: 'mousedown',
      button,
      shiftKey: false,
      isTrusted: true,
      stopPropagation: () => taken.push('stop'),
      preventDefault: () => {},
      target: { dispatchEvent: () => {} },
    })
    return taken.length > 0
  }
  const release = (button = 0) => bubble.get('mouseup')?.({ button })
  return { press, release }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('web terminal drag and copy', () => {
  it('leaves the drag to Claude Code so it copies and says so itself', () => {
    expect(harness({ mode: 'claude-code' }).press()).toBe(false)
  })

  it('selects locally for other agents', () => {
    expect(harness({ mode: 'codex' }).press()).toBe(true)
  })

  it('keeps right-click away from the program', () => {
    expect(harness({ mode: 'claude-code' }).press(2)).toBe(true)
  })

  it('keeps local selection on phones', () => {
    expect(harness({ mode: 'claude-code', isMobile: true }).press()).toBe(true)
  })

  it('copies the local selection on release', () => {
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const { release } = harness({ mode: 'codex', selection: 'npm run build' })
    release(2)
    expect(writeText).not.toHaveBeenCalled()
    release(0)
    expect(writeText).toHaveBeenCalledWith('npm run build')
  })

  it('writes nothing without a selection', () => {
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    harness({ mode: 'codex' }).release(0)
    expect(writeText).not.toHaveBeenCalled()
  })
})
