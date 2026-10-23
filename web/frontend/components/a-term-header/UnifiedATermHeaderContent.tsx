'use client'

import { clsx } from 'clsx'
import { Folder, Pencil } from 'lucide-react'
import { memo, useCallback, useState } from 'react'
import { useATermPanes } from '@/lib/hooks/use-a-term-panes'
import { useATermSessions } from '@/lib/hooks/use-a-term-sessions'
import { useAgentTools } from '@/lib/hooks/use-agent-tools'
import { getSlotPanelId, getSlotSessionId, isPaneSlot } from '@/lib/utils/slot'
import { ModeToggle } from '../ModeToggle'
import { PaneOverflowMenu } from '../PaneOverflowMenu'
import { HeaderIconButton } from './HeaderIconButton'
import { HeaderNameDisplay } from './HeaderNameDisplay'
import { NewSessionButton } from './NewSessionButton'
import { PaneSearchControl } from './PaneSearchControl'
import { PaneStatusBadge } from './PaneStatusBadge'
import type { UnifiedATermHeaderProps } from './types'

export const UnifiedATermHeaderContent = memo(
  function UnifiedATermHeaderContent({
    slot,
    isActive = false,
    fontSize,
    onFontSizeChange,
    onReset,
    onCloseSession,
    onRefresh,
    onFiles,
    onUpload,
    onOpenModal,
    onModeSwitch,
    isModeSwitching = false,
    isMobile = false,
    allSlots,
    onSwitchTo,
    connectionStatus,
    onReconnect,
    onSearch,
    onClearSearch,
    composeOpen = false,
    onToggleCompose,
  }: UnifiedATermHeaderProps) {
    const { enabledTools } = useAgentTools()
    const { renamePane } = useATermPanes()
    const { update: updateSession } = useATermSessions()
    const [isRenaming, setIsRenaming] = useState(false)
    const paneId = isPaneSlot(slot) ? slot.paneId : null
    // A session the backend lets us rename keeps its name in Tether (Aico
    // shows it too); a pane name is only for sessions Tether does not own.
    const sessionRenameId = slot.can.rename ? getSlotSessionId(slot) : null
    const canRename = !!paneId || !!sessionRenameId

    const handleRename = useCallback(
      (newName: string) => {
        if (sessionRenameId) updateSession(sessionRenameId, { name: newName })
        else if (paneId) renamePane(paneId, newName)
      },
      [paneId, renamePane, sessionRenameId, updateSession],
    )
    const hasSessionActions =
      !!onUpload ||
      !!onFontSizeChange ||
      !!onRefresh ||
      !!onReset ||
      !!onCloseSession ||
      canRename

    return (
      <div
        data-testid={`a-term-header-${getSlotPanelId(slot)}`}
        className={clsx(
          'flex h-12 flex-shrink-0 items-center gap-1',
          isMobile ? 'pr-1 pl-1.5' : 'pr-1.5 pl-2.5',
        )}
      >
        {/* The session's tool mark; switches shell <-> agent on a project */}
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

        <div className="flex min-w-0 flex-[0_1_auto] items-center">
          <HeaderNameDisplay
            slot={slot}
            isActive={isActive}
            isMobile={isMobile}
            allSlots={allSlots}
            onSwitchTo={onSwitchTo}
            onRename={canRename ? handleRename : undefined}
            isEditing={isRenaming}
            onEditingChange={setIsRenaming}
          />
        </div>

        <PaneStatusBadge status={connectionStatus} onReconnect={onReconnect} />

        <div className="min-w-1 flex-1" />

        <div className="flex flex-none items-center gap-0.5">
          {onOpenModal && (
            <NewSessionButton onClick={onOpenModal} isMobile={isMobile} />
          )}

          {onToggleCompose && (
            <button
              type="button"
              onClick={onToggleCompose}
              aria-pressed={composeOpen}
              data-testid="compose-toggle"
              title="Compose text (stays open once opened)"
              className="lantern-btn ghost"
              style={{ height: 34, padding: '0 10px' }}
            >
              <Pencil className="h-4 w-4" strokeWidth={1.7} />
              Compose
            </button>
          )}

          {onSearch && onClearSearch && (
            <PaneSearchControl
              onSearch={onSearch}
              onClearSearch={onClearSearch}
              isMobile={isMobile}
            />
          )}

          {onFiles && (
            <HeaderIconButton
              icon={<Folder className="h-[18px] w-[18px]" strokeWidth={1.7} />}
              onClick={onFiles}
              tooltip="Files"
              isMobile={isMobile}
            />
          )}

          {hasSessionActions && (
            <PaneOverflowMenu
              onRename={canRename ? () => setIsRenaming(true) : undefined}
              onCloseSession={onCloseSession}
              onRefresh={onRefresh}
              onReset={onReset}
              onUpload={onUpload}
              fontSize={fontSize}
              onFontSizeChange={onFontSizeChange}
              isMobile={isMobile}
            />
          )}
        </div>
      </div>
    )
  },
)
