'use client'

import { clsx } from 'clsx'
import { FolderOpen } from 'lucide-react'
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
import { PaneStatusBadge, shouldShowPaneStatus } from './PaneStatusBadge'
import type { UnifiedATermHeaderProps } from './types'

export const UnifiedATermHeaderContent = memo(
  function UnifiedATermHeaderContent({
    slot,
    isActive = false,
    onSettings,
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
    const showStatusBadge = shouldShowPaneStatus(connectionStatus)
    const hasSessionActions =
      !!onUpload ||
      !!onSettings ||
      !!onRefresh ||
      !!onReset ||
      !!onCloseSession ||
      canRename

    return (
      <div
        data-testid={`a-term-header-${getSlotPanelId(slot)}`}
        className={clsx(
          'flex-shrink-0 flex items-center gap-1',
          isMobile ? 'h-9 px-1.5' : 'h-8 px-2',
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
      >
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

        {onOpenModal && (
          <NewSessionButton onClick={onOpenModal} isMobile={isMobile} />
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {showStatusBadge && (
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

          {onFiles && (
            <HeaderIconButton
              icon={<FolderOpen className="w-3.5 h-3.5" />}
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
              onSettings={onSettings}
              onUpload={onUpload}
              isMobile={isMobile}
            />
          )}
        </div>
      </div>
    )
  },
)
