import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { PaneSlot } from '@/lib/utils/slot'
import { SLOT_BASE } from '@/test-stubs/session-fixtures'
import { useSessionShortcuts } from './use-session-shortcuts'

function slot(id: string): PaneSlot {
  return {
    type: 'adhoc',
    ...SLOT_BASE,
    paneId: `pane-${id}`,
    sessionId: id,
    name: id,
    workingDir: null,
    sessionMode: 'shell',
  }
}

const slots = [slot('a'), slot('b'), slot('c')]

function press(init: KeyboardEventInit, target: EventTarget = window) {
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }))
}

describe('useSessionShortcuts', () => {
  it('switches sessions with Ctrl+Tab, Ctrl+Shift+Tab and Ctrl+number', () => {
    const onSwitch = vi.fn()
    renderHook(() => useSessionShortcuts(slots, 'a', onSwitch))

    press({ key: 'Tab', ctrlKey: true })
    press({ key: 'Tab', ctrlKey: true, shiftKey: true })
    press({ key: '2', ctrlKey: true })
    press({ key: '9', ctrlKey: true })

    expect(onSwitch.mock.calls.map(([s]) => s.sessionId)).toEqual([
      'b',
      'c',
      'b',
    ])
  })

  it('leaves Ctrl+T, Ctrl+W and typing alone', () => {
    const onSwitch = vi.fn()
    renderHook(() => useSessionShortcuts(slots, 'a', onSwitch))
    const input = document.createElement('input')
    document.body.appendChild(input)

    const ctrlT = new KeyboardEvent('keydown', {
      key: 't',
      ctrlKey: true,
      cancelable: true,
    })
    window.dispatchEvent(ctrlT)
    press({ key: 'w', ctrlKey: true })
    press({ key: 'Tab', ctrlKey: true }, input)

    expect(ctrlT.defaultPrevented).toBe(false)
    expect(onSwitch).not.toHaveBeenCalled()
    input.remove()
  })
})
