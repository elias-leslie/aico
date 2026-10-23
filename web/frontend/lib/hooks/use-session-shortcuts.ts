'use client'

import { useEffect } from 'react'
import {
  type ATermSlot,
  getSlotSessionId,
  type PaneSlot,
} from '@/lib/utils/slot'

interface Shortcut {
  matches: (e: KeyboardEvent) => boolean
  /** Index of the session to open, from the current one's index. */
  target: (e: KeyboardEvent, current: number, count: number) => number
}

/** Session switching: Ctrl+Tab, Ctrl+Shift+Tab and Ctrl+1-9. */
export const SESSION_SHORTCUTS: readonly Shortcut[] = [
  {
    matches: (e) => e.ctrlKey && e.key === 'Tab' && !e.shiftKey,
    target: (_e, current, count) => (current + 1) % count,
  },
  {
    matches: (e) => e.ctrlKey && e.key === 'Tab' && e.shiftKey,
    target: (_e, current, count) => (current - 1 + count) % count,
  },
  {
    matches: (e) => e.ctrlKey && /^[1-9]$/.test(e.key),
    target: (e) => parseInt(e.key, 10) - 1,
  },
]

function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  return (
    element?.tagName === 'INPUT' ||
    element?.tagName === 'TEXTAREA' ||
    element?.isContentEditable === true
  )
}

/** Registers the session-switching shortcuts over the switcher's sessions. */
export function useSessionShortcuts(
  slots: Array<ATermSlot | PaneSlot>,
  activeSessionId: string | null,
  onSwitch: (slot: ATermSlot | PaneSlot) => void,
) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return
      const shortcut = SESSION_SHORTCUTS.find((item) => item.matches(e))
      if (!shortcut) return
      e.preventDefault()
      const current = slots.findIndex(
        (slot) => getSlotSessionId(slot) === activeSessionId,
      )
      const slot = slots[shortcut.target(e, current, slots.length)]
      if (slot && getSlotSessionId(slot) !== activeSessionId) onSwitch(slot)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeSessionId, onSwitch, slots])
}
