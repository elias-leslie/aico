'use client'

import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { useSessionAttention } from '@/lib/hooks/use-session-attention'
import { type ATermSlot, getSlotName, type PaneSlot } from '@/lib/utils/slot'
import { AttentionBadge } from '../AttentionBadge'
import { CoordinatorBadge } from '../CoordinatorBadge'
import { SessionSwitcher } from '../SessionSwitcher'
import { SessionTitle } from '../SessionTitle'

interface HeaderNameDisplayProps {
  slot: ATermSlot | PaneSlot
  isActive: boolean
  isMobile: boolean
  allSlots?: Array<ATermSlot | PaneSlot>
  onSwitchTo?: (slot: ATermSlot | PaneSlot) => void
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
  const textColor = isActive
    ? 'var(--term-text-primary)'
    : 'var(--term-text-muted)'

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
        className="px-1.5 py-0.5 text-xs rounded max-w-[160px]"
        style={{
          color: 'var(--term-text-primary)',
          backgroundColor: 'var(--term-bg-deep)',
          border: '1px solid var(--term-accent)',
          boxShadow:
            '0 0 6px var(--term-accent-glow), inset 0 0 4px rgba(0, 255, 159, 0.05)',
          outline: 'none',
          fontFamily: 'var(--font-ui)',
          caretColor: 'var(--term-accent)',
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
      <span
        className="flex min-w-0 items-center overflow-hidden px-1.5 py-0.5 text-xs max-w-[320px]"
        style={{ color: textColor }}
        title={name}
      >
        <SessionTitle name={name} task={slot.task} />
      </span>
      <AttentionBadge attention={attention.forSlot(slot)} />
    </span>
  )
})
