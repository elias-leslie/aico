'use client'

import { clsx } from 'clsx'
import { ArrowLeftRight, ChevronDown } from 'lucide-react'
import { type DragEvent, useCallback, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useClickOutside } from '@/lib/hooks/use-click-outside'
import {
  clearDraggedPaneSlotId,
  getDraggedPaneSlotId,
  isPaneSwapDragEvent,
  setDraggedPaneSlotId,
} from '@/lib/utils/pane-swap-dnd'
import {
  type ATermSlot,
  getSlotName,
  getSlotPanelId,
  type PaneSlot,
} from '@/lib/utils/slot'

function getSlotMode(slot: ATermSlot | PaneSlot): string {
  if (slot.type === 'project') {
    return slot.activeMode
  }
  return slot.sessionMode ?? 'shell'
}

function getMobileSlotLabel(slot: ATermSlot | PaneSlot): string {
  return `${getSlotName(slot)} [${getSlotMode(slot)}]`
}

export interface PaneSwapDropdownProps {
  /** Current slot being displayed */
  currentSlot: ATermSlot | PaneSlot
  /** All available slots for swapping */
  allSlots: Array<ATermSlot | PaneSlot>
  /** Callback when user selects another slot to swap with (desktop: swap positions) */
  onSwapWith?: (otherSlotId: string) => void
  /** Callback to switch to another slot (mobile: navigate to pane) */
  onSwitchTo?: (slot: ATermSlot | PaneSlot) => void
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
  const mobileSheetRef = useRef<HTMLDivElement>(null)
  const currentName = getSlotName(currentSlot)
  const currentId = getSlotPanelId(currentSlot)

  const dropdownSlots = useMemo(() => {
    if (!isMobile) {
      return allSlots
        .filter((slot) => getSlotPanelId(slot) !== currentId)
        .map((slot) => ({
          id: getSlotPanelId(slot),
          label: getSlotName(slot),
          slot,
        }))
    }

    const sortedSlots = [...allSlots].sort((slotA, slotB) => {
      const labelCompare = getMobileSlotLabel(slotA).localeCompare(
        getMobileSlotLabel(slotB),
        undefined,
        { sensitivity: 'base' },
      )
      if (labelCompare !== 0) {
        return labelCompare
      }
      return getSlotPanelId(slotA).localeCompare(getSlotPanelId(slotB))
    })

    const seenLabelCounts = new Map<string, number>()

    return sortedSlots.map((slot) => {
      const baseLabel = getMobileSlotLabel(slot)
      const count = (seenLabelCounts.get(baseLabel) ?? 0) + 1
      seenLabelCounts.set(baseLabel, count)
      return {
        id: getSlotPanelId(slot),
        label: count > 1 ? `${baseLabel} #${count}` : baseLabel,
        slot,
      }
    })
  }, [allSlots, currentId, isMobile])

  const closeDropdown = useCallback(() => setIsOpen(false), [])
  const clickOutsideRefs = useMemo(
    () => (isMobile ? [dropdownRef, mobileSheetRef] : [dropdownRef]),
    [isMobile],
  )
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

  const handleDragLeave = useCallback((event: DragEvent<HTMLButtonElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setIsDragTarget(false)
    }
  }, [])

  const handleDrop = useCallback(
    (event: DragEvent<HTMLButtonElement>) => {
      const draggedSlotId = readDraggedSlotId(event)
      clearDraggedPaneSlotId()
      setIsDragTarget(false)
      if (!draggedSlotId || draggedSlotId === currentId) return
      event.preventDefault()
      onSwapWith?.(draggedSlotId)
    },
    [currentId, onSwapWith, readDraggedSlotId],
  )

  if (!isMobile && dropdownSlots.length === 0) {
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
          isDragTarget &&
            'ring-1 ring-[var(--term-accent)] bg-[var(--term-bg-elevated)]',
        )}
        style={{
          color: 'var(--term-text-primary)',
        }}
        title={
          isMobile
            ? `${currentName} (tap to switch panes)`
            : `${currentName} (click to swap position or drag to another pane)`
        }
        aria-label={
          isMobile
            ? `Switch panes from ${currentName}`
            : `Swap ${currentName} with another pane`
        }
        aria-haspopup={isMobile ? 'dialog' : 'menu'}
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

      {!isMobile &&
        isOpen && (
          <div
            data-testid="pane-swap-dropdown-menu"
            className="absolute left-0 top-full mt-1 z-50 min-w-[180px] rounded-md shadow-lg overflow-hidden animate-in fade-in slide-in-from-top-1 duration-100"
            style={{
              backgroundColor: 'var(--term-surface-glass)',
              backdropFilter: 'blur(12px)',
              WebkitBackdropFilter: 'blur(12px)',
              border: '1px solid var(--term-border-active)',
              boxShadow: 'var(--term-shadow-dropdown)',
            }}
          >
            <div
              className="px-2 py-1.5 text-[10px] uppercase tracking-wide flex items-center gap-1"
              style={{
                color: 'var(--term-text-muted)',
                backgroundColor: 'var(--term-bg-surface)',
              }}
            >
              <ArrowLeftRight className="w-3 h-3" />
              Swap position with
            </div>

            {dropdownSlots.map(({ id, label }) => (
              <button
                key={id}
                onClick={() => {
                  onSwapWith?.(id)
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
                <span className="truncate flex-1">{label}</span>
              </button>
            ))}
          </div>
        )}

      {isMobile &&
        isOpen &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            data-testid="pane-swap-mobile-sheet"
            className="fixed inset-0 z-[90] flex items-end"
            role="dialog"
            aria-modal="true"
            aria-label="Switch pane"
          >
            <button
              type="button"
              aria-label="Close pane switcher"
              className="absolute inset-0 bg-black/50"
              onClick={closeDropdown}
            />
            <div
              ref={mobileSheetRef}
              className="relative z-[91] max-h-[70vh] w-full overflow-hidden rounded-t-2xl border-t animate-in slide-in-from-bottom-3 duration-150"
              style={{
                backgroundColor: 'var(--term-bg-surface)',
                borderColor: 'var(--term-border-active)',
                boxShadow: 'var(--term-shadow-dropdown)',
              }}
            >
              <div
                className="mx-auto mt-2 h-1.5 w-12 rounded-full"
                style={{ backgroundColor: 'var(--term-border)' }}
              />
              <div
                className="px-4 py-3 text-[11px] uppercase tracking-wide"
                style={{ color: 'var(--term-text-muted)' }}
              >
                Switch pane
              </div>
              <div
                data-testid="pane-swap-mobile-sheet-scroll"
                className="max-h-[calc(70vh-3.5rem)] overflow-y-auto overscroll-contain px-2 pb-3"
                style={{
                  WebkitOverflowScrolling: 'touch',
                  overscrollBehavior: 'contain',
                  scrollbarGutter: 'stable',
                  touchAction: 'pan-y',
                }}
              >
                {dropdownSlots.map(({ id, label, slot }) => {
                  const isCurrent = id === currentId
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => {
                        onSwitchTo?.(slot)
                        setIsOpen(false)
                      }}
                      className={clsx(
                        'mb-1 flex w-full items-center justify-between rounded-lg px-3 py-3 text-left text-sm transition-colors',
                        isCurrent && 'ring-1',
                      )}
                      style={{
                        color: 'var(--term-text-primary)',
                        backgroundColor: isCurrent
                          ? 'var(--term-bg-elevated)'
                          : 'transparent',
                        borderColor: isCurrent
                          ? 'var(--term-accent-muted)'
                          : 'transparent',
                      }}
                    >
                      <span className="truncate">{label}</span>
                      {isCurrent && (
                        <span
                          className="ml-3 shrink-0 text-[11px] uppercase tracking-wide"
                          style={{ color: 'var(--term-text-muted)' }}
                        >
                          Current
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}
