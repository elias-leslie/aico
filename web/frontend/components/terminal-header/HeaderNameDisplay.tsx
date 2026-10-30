'use client'

import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { useSessionAttention } from '@/lib/hooks/use-session-attention'
import { getSlotName, type PaneSlot, type TerminalSlot } from '@/lib/utils/slot'
import { AttentionBadge } from '../AttentionBadge'
import { CoordinatorBadge } from '../CoordinatorBadge'
import { HostBadge } from '../HostBadge'
import { SessionSwitcher } from '../SessionSwitcher'
import { SessionTitle } from '../SessionTitle'

interface HeaderNameDisplayProps {
  slot: TerminalSlot | PaneSlot
  isActive: boolean
  isMobile: boolean
  allSlots?: Array<TerminalSlot | PaneSlot>
  onSwitchTo?: (slot: TerminalSlot | PaneSlot) => void
  onRename?: (newName: string) => void
  isEditing?: boolean
  onEditingChange?: (editing: boolean) => void
}

export const HeaderNameDisplay = memo(function HeaderNameDisplay({
  slot,
  isActive,
  isMobile,
  allSlots,
  onSwitchTo,
  onRename,
  isEditing = false,
  onEditingChange,
}: HeaderNameDisplayProps) {
  const name = getSlotName(slot)
  // A session renamed in Tether renames its task; the project stays the
  // workspace's.
  const renameValue = slot.can.rename ? (slot.task ?? '') : name
  const attention = useSessionAttention()
  const textColor = isActive ? 'var(--bone)' : 'var(--mist)'

  const [editValue, setEditValue] = useState(renameValue)
  const inputRef = useRef<HTMLInputElement>(null)

  // Sync edit value when entering edit mode or when name changes
  useEffect(() => {
    if (isEditing) {
      setEditValue(renameValue)
      // Focus and select after render
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
    }
  }, [isEditing, renameValue])

  const commitEdit = useCallback(() => {
    const trimmed = editValue.trim()
    if (trimmed && trimmed !== renameValue) {
      onRename?.(trimmed)
    }
    onEditingChange?.(false)
  }, [editValue, renameValue, onRename, onEditingChange])

  const cancelEdit = useCallback(() => {
    setEditValue(renameValue)
    onEditingChange?.(false)
  }, [renameValue, onEditingChange])

  // Editing mode — inline input
  if (isEditing && onRename) {
    return (
      <input
        ref={inputRef}
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commitEdit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            cancelEdit()
          }
          e.stopPropagation()
        }}
        onBlur={commitEdit}
        aria-label="Session name"
        className="h-8 max-w-[220px] rounded-md px-2"
        style={{
          color: 'var(--bone)',
          backgroundColor: 'rgb(var(--ink-rgb) / 0.86)',
          border: '1px solid var(--lantern)',
          outline: 'none',
          font: '450 15px/1.2 var(--font-display)',
          caretColor: 'var(--lantern)',
          minWidth: 60,
        }}
        spellCheck={false}
        autoComplete="off"
      />
    )
  }

  // The title opens the session list.
  if (allSlots && onSwitchTo) {
    return (
      <SessionSwitcher
        currentSlot={slot}
        allSlots={allSlots}
        onSwitchTo={onSwitchTo}
        isMobile={isMobile}
        attention={attention}
      />
    )
  }

  // Static display — still supports double-click rename. The pane's agent
  // state (waiting 3m, done 1m, ...) sits beside its name.
  return (
    <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
      <CoordinatorBadge badge={slot.badge} dot={isMobile} />
      <HostBadge host={slot.host} state={slot.hostState} />
      <span
        className="flex min-w-0 max-w-[320px] items-center overflow-hidden px-1.5 py-0.5"
        style={{ color: textColor, font: '450 15px/1.2 var(--font-display)' }}
        title={name}
      >
        <SessionTitle name={name} task={slot.task} />
      </span>
      <AttentionBadge attention={attention.forSlot(slot)} />
    </span>
  )
})
