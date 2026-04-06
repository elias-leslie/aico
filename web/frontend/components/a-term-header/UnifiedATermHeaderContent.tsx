'use client'

import { clsx } from 'clsx'
import { GripVertical } from 'lucide-react'
import { memo, useCallback, useMemo, useState, type DragEvent } from 'react'
import { useAgentTools } from '@/lib/hooks/use-agent-tools'
import { useATermPanes } from '@/lib/hooks/use-a-term-panes'
import { LayoutModeButtons } from '@/components/LayoutModeButton'
import { getSlotName, getSlotPanelId, isPaneSlot } from '@/lib/utils/slot'
import {
  clearDraggedPaneSlotId,
  getDraggedPaneSlotId,
  isPaneSwapDragEvent,
  setDraggedPaneSlotId,
} from '@/lib/utils/pane-swap-dnd'
import { ModeToggle } from '../ModeToggle'
import { PaneOverflowMenu } from '../PaneOverflowMenu'
import { AddATermButton } from './AddATermButton'
import { HeaderNameDisplay } from './HeaderNameDisplay'
import { PaneSearchControl } from './PaneSearchControl'
import { PaneStatusBadge } from './PaneStatusBadge'
import type { UnifiedATermHeaderProps } from './types'

function formatActionLabel(label: string) {
  return label.replace(/\b\w/g, (character) => character.toUpperCase())
}

export const UnifiedATermHeaderContent = memo(
  function UnifiedATermHeaderContent({
    slot,
    isActive = false,
    showCleanButton = false,
    onSwitch,
    onSettings,
    onReset,
    onClose,
    onCloseSession,
    closeTooltip,
    onUpload,
    onVoice,
    onClean,
    onOpenModal,
    canAddPane = true,
    onModeSwitch,
    isModeSwitching = false,
    isMobile = false,
    allSlots,
    onSwapWith,
    onSwitchTo,
    onResetAll,
    onCloseAll,
    layoutMode,
    availableLayouts,
    onLayoutModeChange,
    connectionStatus,
    onReconnect,
    onSearch,
    onClearSearch,
  }: UnifiedATermHeaderProps) {
    const { enabledTools } = useAgentTools()
    const { renamePane } = useATermPanes()
    const [isDragTarget, setIsDragTarget] = useState(false)
    const [isRenaming, setIsRenaming] = useState(false)
    const paneId = isPaneSlot(slot) ? slot.paneId : null

    const handleRename = useCallback(
      (newName: string) => {
        if (paneId) renamePane(paneId, newName)
      },
      [paneId, renamePane],
    )
    const isAgentMode =
      (slot.type === 'project' && slot.activeMode !== 'shell') ||
      (slot.type === 'adhoc' && slot.isExternal)
    const shouldShowClean = showCleanButton && isAgentMode
    const slotId = getSlotPanelId(slot)
    const slotName = getSlotName(slot)
    const detachLabel = formatActionLabel(closeTooltip ?? 'Detach pane')
    const detachTooltip = `${detachLabel}: remove it from this layout but keep the session running.`
    const hasPaneActions =
      shouldShowClean ||
      !!onVoice ||
      !!onUpload ||
      !!onSettings ||
      !!onReset ||
      !!onClose ||
      !!onCloseSession ||
      !!onResetAll ||
      !!onCloseAll
    const canSwapByDrag = useMemo(
      () => !isMobile && !!onSwapWith && (allSlots?.length ?? 0) > 1,
      [allSlots, isMobile, onSwapWith],
    )

    const handleDragStart = useCallback(
      (event: DragEvent<HTMLButtonElement>) => {
        if (!canSwapByDrag) return
        setDraggedPaneSlotId(event, slotId)
      },
      [canSwapByDrag, slotId],
    )

    const handleDragEnd = useCallback(() => {
      clearDraggedPaneSlotId()
      setIsDragTarget(false)
    }, [])

    const handleDragOver = useCallback(
      (event: DragEvent<HTMLDivElement>) => {
        if (!canSwapByDrag) return
        if (!isPaneSwapDragEvent(event)) return
        const draggedSlotId = getDraggedPaneSlotId(event)
        if (!draggedSlotId || draggedSlotId === slotId) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        setIsDragTarget(true)
      },
      [canSwapByDrag, slotId],
    )

    const handleDragLeave = useCallback(
      (event: DragEvent<HTMLDivElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setIsDragTarget(false)
        }
      },
      [],
    )

    const handleDrop = useCallback(
      (event: DragEvent<HTMLDivElement>) => {
        if (!canSwapByDrag || !onSwapWith) return
        const draggedSlotId = getDraggedPaneSlotId(event)
        clearDraggedPaneSlotId()
        setIsDragTarget(false)
        if (!draggedSlotId || draggedSlotId === slotId) return
        event.preventDefault()
        onSwapWith(draggedSlotId)
      },
      [canSwapByDrag, onSwapWith, slotId],
    )

    return (
      <div
        data-testid={`a-term-header-${slotId}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={clsx(
          'flex-shrink-0 flex items-center gap-1 transition-colors duration-150',
          isMobile ? 'h-9 px-1.5' : 'h-8 px-2',
          isDragTarget && 'ring-1 ring-inset ring-[var(--term-accent)]',
        )}
        style={{
          backgroundColor: isActive
            ? 'var(--term-bg-elevated)'
            : 'var(--term-bg-surface)',
          borderBottom: isActive
            ? '2px solid var(--term-accent)'
            : '1px solid var(--term-border)',
          fontFamily: 'var(--font-ui)',
        }}
        title={
          canSwapByDrag
            ? `${slotName}: drag this header onto another pane to swap positions`
            : undefined
        }
      >
        {canSwapByDrag && (
          <button
            type="button"
            data-testid={`pane-drag-handle-${slotId}`}
            draggable={true}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            className={clsx(
              'flex items-center justify-center rounded transition-all duration-150',
              isMobile ? 'w-8 h-8' : 'w-6 h-6',
              'cursor-grab active:cursor-grabbing',
              'text-[var(--term-text-muted)] hover:bg-[var(--term-bg-elevated)] hover:text-[var(--term-accent)]',
              'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--term-accent)]',
            )}
            title={`Drag ${slotName} to swap panes`}
            aria-label={`Drag ${slotName} to swap panes`}
          >
            <GripVertical className="w-3.5 h-3.5" />
          </button>
        )}

        {/* Mode toggle (shell <-> agent) - only for project slots */}
        {slot.type === 'project' && onModeSwitch && (
          <ModeToggle
            value={slot.activeMode}
            onChange={onModeSwitch}
            disabled={isModeSwitching}
            isLoading={isModeSwitching}
            isMobile={isMobile}
            agentTools={enabledTools}
          />
        )}

        {/* A-Term name/switcher */}
        <HeaderNameDisplay
          slot={slot}
          isActive={isActive}
          isMobile={isMobile}
          allSlots={allSlots}
          onSwapWith={onSwapWith}
          onSwitchTo={onSwitchTo}
          onSwitch={onSwitch}
          onRename={paneId ? handleRename : undefined}
          isEditing={isRenaming}
          onEditingChange={setIsRenaming}
        />

        {/* Add a-term button */}
        {onOpenModal && (
          <AddATermButton
            onOpenModal={onOpenModal}
            canAddPane={canAddPane}
            isMobile={isMobile}
          />
        )}

        {layoutMode &&
          onLayoutModeChange &&
          availableLayouts &&
          availableLayouts.length > 1 && (
          <LayoutModeButtons
            layoutMode={layoutMode}
            onLayoutChange={onLayoutModeChange}
            availableLayouts={availableLayouts}
          />
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Status badge — before overflow menu (desktop + mobile) */}
        {connectionStatus && (
          <span
            className="h-3.5 w-px mx-0.5"
            style={{ backgroundColor: 'var(--term-border)' }}
          />
        )}
        <PaneStatusBadge status={connectionStatus} onReconnect={onReconnect} />

        <div className="flex items-center gap-0.5">
          {onSearch && onClearSearch && (
            <PaneSearchControl
              onSearch={onSearch}
              onClearSearch={onClearSearch}
              isMobile={isMobile}
            />
          )}

          {hasPaneActions && (
            <PaneOverflowMenu
              onRename={paneId ? () => setIsRenaming(true) : undefined}
              onDetach={onClose}
              detachLabel={detachLabel}
              detachTooltip={detachTooltip}
              onCloseSession={onCloseSession}
              onReset={onReset}
              onSettings={onSettings}
              onUpload={onUpload}
              onVoice={onVoice}
              onClean={shouldShowClean ? onClean : undefined}
              onResetAll={onResetAll}
              onCloseAll={onCloseAll}
              isMobile={isMobile}
            />
          )}
        </div>
      </div>
    )
  },
)
