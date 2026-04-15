'use client'

import { clsx } from 'clsx'
import { ChevronDown } from 'lucide-react'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { type ATermSlot, getSlotName, type PaneSlot } from '@/lib/utils/slot'
import { PaneSwapDropdown } from '../PaneSwapDropdown'

interface HeaderNameDisplayProps {
  slot: ATermSlot | PaneSlot
  isActive: boolean
  isMobile: boolean
  allSlots?: Array<ATermSlot | PaneSlot>
  onSwapWith?: (otherSlotId: string) => void
  onSwitchTo?: (slot: ATermSlot | PaneSlot) => void
  onSwitch?: () => void
  onRename?: (newName: string) => void
  isEditing?: boolean
  onEditingChange?: (editing: boolean) => void
}

export const HeaderNameDisplay = memo(function HeaderNameDisplay({
  slot,
  isActive,
  isMobile,
  allSlots,
  onSwapWith,
  onSwitchTo,
  onSwitch,
  onRename,
  isEditing = false,
  onEditingChange,
}: HeaderNameDisplayProps) {
  const name = getSlotName(slot)
  const textColor = isActive
    ? 'var(--term-text-primary)'
    : 'var(--term-text-muted)'

  const [editValue, setEditValue] = useState(name)
  const inputRef = useRef<HTMLInputElement>(null)

  // Sync edit value when entering edit mode or when name changes
  useEffect(() => {
    if (isEditing) {
      setEditValue(name)
      // Focus and select after render
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
    }
  }, [isEditing, name])

  const commitEdit = useCallback(() => {
    const trimmed = editValue.trim()
    if (trimmed && trimmed !== name) {
      onRename?.(trimmed)
    }
    onEditingChange?.(false)
  }, [editValue, name, onRename, onEditingChange])

  const cancelEdit = useCallback(() => {
    setEditValue(name)
    onEditingChange?.(false)
  }, [name, onEditingChange])

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

  // Mobile uses the pane switcher trigger for all pane/session navigation.
  if (isMobile && allSlots && (onSwitchTo || onSwapWith)) {
    return (
      <PaneSwapDropdown
        currentSlot={slot}
        allSlots={allSlots}
        onSwapWith={onSwapWith}
        onSwitchTo={onSwitchTo}
        isMobile={isMobile}
      />
    )
  }

  // Mobile keeps explicit switch button when drag or tab targets are not ideal.
  if (isMobile && onSwitch) {
    return (
      <button
        onClick={onSwitch}
        className={clsx(
          'flex items-center gap-1 px-1.5 py-0.5 rounded text-xs truncate max-w-[140px] transition-all duration-150',
          'hover:bg-[var(--term-bg-elevated)]',
          'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--term-accent)]',
        )}
        style={{ color: textColor }}
        title={name}
      >
        <span className="truncate">{name}</span>
        <ChevronDown className="w-3 h-3 flex-shrink-0" />
      </button>
    )
  }

  // Static display — still supports double-click rename
  return (
    <span
      className="flex items-center px-1.5 py-0.5 text-xs truncate max-w-[140px]"
      style={{ color: textColor }}
      title={name}
    >
      {name}
    </span>
  )
})
