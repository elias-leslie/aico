import { useCallback, useRef, useState, type DragEvent } from 'react'
import { clsx } from 'clsx'
import type { PaneSlot, ATermSlot } from '@/lib/utils/slot'
import { UnifiedATermHeaderContent as UnifiedATermHeader } from '@/components/a-term-header'
import {
  getSlotSessionId,
  getSlotWorkingDir,
  getSlotPanelId,
  isPaneSlot,
} from '@/lib/utils/slot'
import {
  clearDraggedPaneSlotId,
  getDraggedPaneSlotId,
  isPaneSwapDragEvent,
} from '@/lib/utils/pane-swap-dnd'
import { ATermComponent, type ATermHandle } from '@/components/ATerm'
import { PaneFilesDialog } from '@/components/files/PaneFilesDialog'
import type { ResizablePaneLayoutProps } from '@/types/pane-layout'

interface UsePaneRendererOptions {
  props: Pick<
    ResizablePaneLayoutProps,
    | 'onSwitch'
    | 'onSettings'
    | 'onReset'
    | 'onClose'
    | 'onCloseSession'
    | 'onUpload'
    | 'onClean'
    | 'onOpenModal'
    | 'canAddPane'
    | 'onModeSwitch'
    | 'isModeSwitching'
    | 'isMobile'
    | 'onSwapPanes'
    | 'onATermRef'
    | 'fontFamily'
    | 'fontSize'
    | 'scrollback'
    | 'cursorStyle'
    | 'cursorBlink'
    | 'theme'
    | 'onStatusChange'
    | 'onVoice'
    | 'layoutMode'
    | 'availableLayouts'
    | 'onLayoutModeChange'
    | 'aTermStatuses'
  >
  displaySlots: (ATermSlot | PaneSlot)[]
  paneCount: number
}

/**
 * Hook to create the renderPane function for individual pane rendering.
 */
export function usePaneRenderer({
  props,
  displaySlots,
  paneCount,
}: UsePaneRendererOptions) {
  const {
    onSwitch,
    onSettings,
    onReset,
    onClose,
    onCloseSession,
    onUpload,
    onClean,
    onOpenModal,
    canAddPane,
    onModeSwitch,
    isModeSwitching,
    isMobile,
    onSwapPanes,
    onATermRef,
    fontFamily,
    fontSize,
    scrollback,
    cursorStyle,
    cursorBlink,
    theme,
    onStatusChange,
    onVoice,
    layoutMode,
    availableLayouts,
    onLayoutModeChange,
    aTermStatuses,
  } = props
  const [dragTargetPanelId, setDragTargetPanelId] = useState<string | null>(null)
  const [filesTarget, setFilesTarget] = useState<{
    paneId: string
    sessionId: string
  } | null>(null)
  const paneHandlesRef = useRef(new Map<string, ATermHandle>())

  const handleInsertPath = useCallback(
    (path: string) => {
      if (!filesTarget) return
      paneHandlesRef.current.get(filesTarget.sessionId)?.pasteInput(path)
    },
    [filesTarget],
  )

  const renderPane = useCallback(
    (slot: ATermSlot | PaneSlot, _index: number) => {
      const sessionId = getSlotSessionId(slot)
      const workingDir = getSlotWorkingDir(slot)
      const panelId = getSlotPanelId(slot)
      const paneId = isPaneSlot(slot) ? slot.paneId : null
      const isExternalSlot = slot.type === 'adhoc' && slot.isExternal
      const canResetSlot = !isExternalSlot
      const canCleanSlot =
        (slot.type === 'project' && slot.activeMode !== 'shell') || isExternalSlot
      const canSwapByDrop = !!onSwapPanes && paneCount > 1
      const isDragTarget = dragTargetPanelId === panelId

      const handlePaneDragOver = (event: DragEvent<HTMLDivElement>) => {
        if (!canSwapByDrop) return
        if (!isPaneSwapDragEvent(event)) return
        const draggedSlotId = getDraggedPaneSlotId(event)
        if (!draggedSlotId || draggedSlotId === panelId) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        setDragTargetPanelId(panelId)
      }

      const handlePaneDragLeave = (event: DragEvent<HTMLDivElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDragTargetPanelId((currentId) =>
            currentId === panelId ? null : currentId,
          )
        }
      }

      const handlePaneDrop = (event: DragEvent<HTMLDivElement>) => {
        if (!canSwapByDrop || !onSwapPanes) return
        const draggedSlotId = getDraggedPaneSlotId(event)
        clearDraggedPaneSlotId()
        setDragTargetPanelId(null)
        if (!draggedSlotId || draggedSlotId === panelId) return
        event.preventDefault()
        onSwapPanes(panelId, draggedSlotId)
      }

      return (
        <div
          data-testid={`pane-drop-target-${panelId}`}
          onDragOver={handlePaneDragOver}
          onDragLeave={handlePaneDragLeave}
          onDrop={handlePaneDrop}
          className={clsx(
            'a-term-pane-shell flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-md transition-colors duration-150',
            isDragTarget && 'a-term-pane-shell-drag-target ring-1 ring-[var(--term-accent)]',
          )}
          style={{ backgroundColor: 'var(--term-bg-surface)' }}
        >
          <UnifiedATermHeader
            slot={slot}
            showCleanButton={canCleanSlot}
            onSwitch={onSwitch ? () => onSwitch(slot) : undefined}
            onSettings={onSettings}
            onReset={onReset && canResetSlot ? () => onReset(slot) : undefined}
            onClose={onClose ? () => onClose(slot) : undefined}
            onCloseSession={onCloseSession ? () => onCloseSession(slot) : undefined}
            closeTooltip={isExternalSlot ? 'Detach a-term' : 'Detach pane'}
            onFiles={
              paneId && sessionId
                ? () => setFilesTarget({ paneId, sessionId })
                : undefined
            }
            onUpload={onUpload ? () => onUpload(sessionId ?? undefined) : undefined}
            onClean={onClean ? () => onClean(slot) : undefined}
            onOpenModal={onOpenModal}
            canAddPane={canAddPane}
            onModeSwitch={
              onModeSwitch ? (mode) => onModeSwitch(slot, mode) : undefined
            }
            isModeSwitching={isModeSwitching}
            onVoice={onVoice ? () => onVoice(sessionId ?? undefined) : undefined}
            isMobile={isMobile}
            allSlots={paneCount > 1 ? displaySlots : undefined}
            onSwapWith={
              onSwapPanes && paneCount > 1
                ? (otherSlotId) => onSwapPanes(panelId, otherSlotId)
                : undefined
            }
            onSwitchTo={
              isMobile && onSwitch && paneCount > 1
                ? (targetSlot) => onSwitch(targetSlot)
                : undefined
            }
            layoutMode={layoutMode}
            availableLayouts={availableLayouts}
            onLayoutModeChange={onLayoutModeChange}
            connectionStatus={sessionId ? aTermStatuses?.get(sessionId) : undefined}
            onReconnect={sessionId ? () => paneHandlesRef.current.get(sessionId)?.reconnect() : undefined}
            onSearch={sessionId
              ? (query, options) =>
                  paneHandlesRef.current.get(sessionId)?.search(query, options) ?? {
                    query,
                    totalMatches: 0,
                    activeIndex: -1,
                    found: false,
                  }
              : undefined}
            onClearSearch={sessionId
              ? () => paneHandlesRef.current.get(sessionId)?.clearSearch()
              : undefined}
          />

          <div
            className="relative flex-1 min-h-0 min-w-0 overflow-hidden"
            style={{ backgroundColor: 'var(--term-bg-deep)' }}
          >
            {sessionId ? (
              <ATermComponent
                key={sessionId}
                ref={(handle) => {
                  if (sessionId) {
                    if (handle) paneHandlesRef.current.set(sessionId, handle)
                    else paneHandlesRef.current.delete(sessionId)
                  }
                  onATermRef?.(sessionId, handle)
                }}
                sessionId={sessionId}
                sessionMode={slot.type === 'project' ? slot.activeMode : slot.sessionMode}
                workingDir={workingDir || undefined}
                className="h-full"
                fontFamily={fontFamily}
                fontSize={fontSize}
                scrollback={scrollback}
                cursorStyle={cursorStyle}
                cursorBlink={cursorBlink}
                theme={theme}
                onStatusChange={(status) => onStatusChange?.(sessionId, status)}
              />
            ) : (
              <div
                className="flex items-center justify-center h-full text-xs"
                style={{ color: 'var(--term-text-muted)' }}
              >
                Click tab to start session
              </div>
            )}
          </div>
          {paneId && filesTarget?.paneId === paneId && (
            <PaneFilesDialog
              isOpen={true}
              paneId={paneId}
              onClose={() => setFilesTarget(null)}
              onInsertPath={handleInsertPath}
            />
          )}
        </div>
      )
    },
    [
      onSwitch,
      onSettings,
      onReset,
      onClose,
      onCloseSession,
      onUpload,
      onClean,
      onOpenModal,
      canAddPane,
      onModeSwitch,
      isModeSwitching,
      isMobile,
      displaySlots,
      paneCount,
      onSwapPanes,
      onATermRef,
      fontFamily,
      fontSize,
      scrollback,
      cursorStyle,
      cursorBlink,
      theme,
      onStatusChange,
      onVoice,
      layoutMode,
      availableLayouts,
      onLayoutModeChange,
      aTermStatuses,
      dragTargetPanelId,
      filesTarget,
      handleInsertPath,
    ],
  )

  return renderPane
}
