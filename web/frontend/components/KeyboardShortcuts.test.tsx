import { act, render, renderHook, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  KeyboardShortcuts,
  SHORTCUTS,
  useATermKeyboardShortcuts,
} from './KeyboardShortcuts'

function press(init: KeyboardEventInit, target: EventTarget = window) {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

function setup() {
  const handlers = {
    onNewATerm: vi.fn(),
    onCloseTab: vi.fn(),
    onNextATerm: vi.fn(),
    onPrevATerm: vi.fn(),
    onJumpToATerm: vi.fn(),
    onVoiceToggle: vi.fn(),
  }
  const hook = renderHook(() => useATermKeyboardShortcuts(handlers))
  return { handlers, hook }
}

describe('A-Term keyboard shortcuts', () => {
  it('lists every shortcut from the same table the handler uses', () => {
    render(<KeyboardShortcuts isOpen onClose={vi.fn()} />)
    for (const shortcut of SHORTCUTS) {
      expect(screen.getByText(shortcut.description)).toBeInTheDocument()
      expect(screen.getAllByText(shortcut.keys).length).toBeGreaterThan(0)
    }
    expect(SHORTCUTS.map((s) => s.keys)).toEqual([
      'Ctrl+T',
      'Ctrl+W',
      'Ctrl+Tab',
      'Ctrl+Shift+Tab',
      'Ctrl+1-9',
      '?',
      'Pause',
      'Esc',
    ])
  })

  it('runs each listed shortcut', () => {
    const { handlers, hook } = setup()
    expect(press({ key: 't', ctrlKey: true }).defaultPrevented).toBe(true)
    expect(handlers.onNewATerm).toHaveBeenCalledOnce()
    press({ key: 'w', ctrlKey: true })
    expect(handlers.onCloseTab).toHaveBeenCalledOnce()
    press({ key: 'Tab', ctrlKey: true })
    expect(handlers.onNextATerm).toHaveBeenCalledOnce()
    press({ key: 'Tab', ctrlKey: true, shiftKey: true })
    expect(handlers.onPrevATerm).toHaveBeenCalledOnce()
    expect(handlers.onNextATerm).toHaveBeenCalledOnce()
    press({ key: '3', ctrlKey: true })
    expect(handlers.onJumpToATerm).toHaveBeenCalledWith(2)
    press({ key: 'Pause', code: 'Pause' })
    expect(handlers.onVoiceToggle).toHaveBeenCalledOnce()
    press({ key: '?' })
    expect(hook.result.current.showHelp).toBe(true)
  })

  it('ignores shortcuts while typing, except the voice toggle', () => {
    const { handlers, hook } = setup()
    const input = document.createElement('input')
    document.body.appendChild(input)
    try {
      expect(press({ key: 't', ctrlKey: true }, input).defaultPrevented).toBe(
        false,
      )
      press({ key: '?' }, input)
      press({ key: 'Pause', code: 'Pause' }, input)
      expect(handlers.onNewATerm).not.toHaveBeenCalled()
      expect(hook.result.current.showHelp).toBe(false)
      expect(handlers.onVoiceToggle).toHaveBeenCalledOnce()
    } finally {
      input.remove()
    }
  })

  it('leaves ? with a modifier and plain letters alone', () => {
    const { handlers, hook } = setup()
    expect(press({ key: '?', ctrlKey: true }).defaultPrevented).toBe(false)
    expect(press({ key: 't' }).defaultPrevented).toBe(false)
    expect(hook.result.current.showHelp).toBe(false)
    expect(handlers.onNewATerm).not.toHaveBeenCalled()
  })
})
