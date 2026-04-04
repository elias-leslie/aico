'use client'

import { clsx } from 'clsx'
import { ArrowLeftRight, ChevronDown } from 'lucide-react'
import { useCallback, useMemo, useRef, useState, type DragEvent } from 'react'
import { useClickOutside } from '@/lib/hooks/use-click-outside'
import {
  type PaneSlot,
  getSlotName,
  getSlotPanelId,
  type TerminalSlot,
} from '@/lib/utils/slot'
import {
  clearDraggedPaneSlotId,
  getDraggedPaneSlotId,
  isPaneSwapDragEvent,
  setDraggedPaneSlotId,
} from '@/lib/utils/pane-swap-dnd'

export interface PaneSwapDropdownProps {
  /** Current slot being displayed */
  currentSlot: TerminalSlot | PaneSlot
  /** All available slots for swapping */
  allSlots: Array<TerminalSlot | PaneSlot>
  /** Callback when user selects another slot to swap with (desktop: swap positions) */
  onSwapWith: (otherSlotId: string) => void
  /** Callback to switch to another slot (mobile: navigate to pane) */
  onSwitchTo?: (slot: TerminalSlot | PaneSlot) => void
  isMobile?: boolean
}

/**
 * Dropdown for swapping pane positions in split/grid mode.
 * Shows current pane name with chevron; clicking opens dropdown of other panes.
 * Selecting another pane triggers a position swap.
 */
export function PaneSwapDropdown({
  currentSlot,
  allSlots,
  onSwapWith,
  onSwitchTo,
  isMobile = false,
}: PaneSwapDropdownProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [isDragTarget, setIsDragTarget] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const currentName = getSlotName(currentSlot)
  const currentId = getSlotPanelId(currentSlot)

  // Other slots to show in dropdown (exclude current)
  const otherSlots = allSlots.filter((s) => getSlotPanelId(s) !== currentId)

  const closeDropdown = useCallback(() => setIsOpen(false), [])
  const clickOutsideRefs = useMemo(() => [dropdownRef], [])
  useClickOutside(clickOutsideRefs, closeDropdown, isOpen)

  const readDraggedSlotId = useCallback(
    (event: React.DragEvent<HTMLElement>) => getDraggedPaneSlotId(event),
    [],
  )

  const handleDragStart = useCallback(
    (event: DragEvent<HTMLButtonElement>) => {
      if (isMobile) return
      setDraggedPaneSlotId(event, currentId)
    },
    [currentId, isMobile],
  )

  const handleDragEnd = useCallback(() => {
    clearDraggedPaneSlotId()
    setIsDragTarget(false)
  }, [])

  const handleDragOver = useCallback(
    (event: DragEvent<HTMLButtonElement>) => {
      if (!isPaneSwapDragEvent(event)) return
      const draggedSlotId = readDraggedSlotId(event)
      if (!draggedSlotId || draggedSlotId === currentId) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      setIsDragTarget(true)
    },
    [currentId, readDraggedSlotId],
  )

  const handleDragLeave = useCallback(
    (event: DragEvent<HTMLButtonElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
        setIsDragTarget(false)
      }
    },
    [],
  )

  const handleDrop = useCallback(
    (event: DragEvent<HTMLButtonElement>) => {
      const draggedSlotId = readDraggedSlotId(event)
      clearDraggedPaneSlotId()
      setIsDragTarget(false)
      if (!draggedSlotId || draggedSlotId === currentId) return
      event.preventDefault()
      onSwapWith(draggedSlotId)
    },
    [currentId, onSwapWith, readDraggedSlotId],
  )

  // Don't show dropdown if there's nothing to swap with
  if (otherSlots.length === 0) {
    return (
      <span
        className="flex items-center px-1.5 py-0.5 text-xs truncate max-w-[140px]"
        style={{ color: 'var(--term-text-primary)' }}
        title={currentName}
      >
        {currentName}
      </span>
    )
  }

  return (
    <div ref={dropdownRef} className="relative flex items-center gap-1">
      {/* Trigger button */}
      <button
        data-testid="pane-swap-dropdown"
        onClick={() => setIsOpen(!isOpen)}
        draggable={!isMobile}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={clsx(
          'flex items-center gap-1 px-1.5 py-0.5 rounded text-xs truncate max-w-[140px] transition-all duration-150',
          !isMobile && 'cursor-grab active:cursor-grabbing',
          'hover:bg-[var(--term-bg-elevated)]',
          isDragTarget && 'ring-1 ring-[var(--term-accent)] bg-[var(--term-bg-elevated)]',
        )}
        style={{
          color: 'var(--term-text-primary)',
        }}
        title={`${currentName} (click to swap position${isMobile ? '' : ' or drag to another pane'})`}
        aria-label={`Swap ${currentName} with another pane`}
        aria-haspopup="menu"
        aria-expanded={isOpen}
      >
        <span className="truncate">{currentName}</span>
        <ChevronDown
          className={clsx(
            'w-3 h-3 flex-shrink-0 transition-transform',
            isOpen && 'rotate-180',
          )}
        />
      </button>

      {/* Dropdown showing other panes */}
      {isOpen && (
        <div
          data-testid="pane-swap-dropdown-menu"
          className={clsx(
            'absolute left-0 top-full mt-1 z-50 rounded-md shadow-lg overflow-hidden animate-in fade-in slide-in-from-top-1 duration-100',
            isMobile ? 'min-w-[200px]' : 'min-w-[180px]',
          )}
          style={{
            backgroundColor: 'var(--term-surface-glass)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            border: '1px solid var(--term-border-active)',
            boxShadow: 'var(--term-shadow-dropdown)',
          }}
        >
          {/* Header */}
          <div
            className="px-2 py-1.5 text-[10px] uppercase tracking-wide flex items-center gap-1"
            style={{
              color: 'var(--term-text-muted)',
              backgroundColor: 'var(--term-bg-surface)',
            }}
          >
            <ArrowLeftRight className="w-3 h-3" />
            {isMobile ? 'Switch to' : 'Swap position with'}
          </div>

          {/* Other panes */}
          {otherSlots.map((slot) => {
            const slotId = getSlotPanelId(slot)
            const slotName = getSlotName(slot)
            return (
              <button
                key={slotId}
                onClick={() => {
                  if (isMobile && onSwitchTo) {
                    onSwitchTo(slot)
                  } else {
                    onSwapWith(slotId)
                  }
                  setIsOpen(false)
                }}
                className="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-left transition-colors hover:bg-[var(--term-bg-surface)]"
                style={{
                  color: 'var(--term-text-primary)',
                }}
              >
                <ArrowLeftRight
                  className="w-3 h-3 flex-shrink-0"
                  style={{ color: 'var(--term-text-muted)' }}
                />
                <span className="truncate flex-1">{slotName}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
