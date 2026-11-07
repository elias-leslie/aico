'use client'

import { clsx } from 'clsx'
import { Folder, Pencil } from 'lucide-react'
import { memo, useCallback, useState } from 'react'
import { useAgentTools } from '@/lib/hooks/use-agent-tools'
import { useTerminalPanes } from '@/lib/hooks/use-terminal-panes'
import { useTerminalSessions } from '@/lib/hooks/use-terminal-sessions'
import { getSlotPanelId, getSlotSessionId, isPaneSlot } from '@/lib/utils/slot'
import { useFrame } from '../frame/FrameContext'
import { SideEdgeButton } from '../frame/SideEdgeButton'
import { ModeToggle } from '../ModeToggle'
import { PaneOverflowMenu } from '../PaneOverflowMenu'
import { ContextFillBadge } from './ContextFillBadge'
import { HeaderIconButton } from './HeaderIconButton'
import { HeaderNameDisplay } from './HeaderNameDisplay'
import { PaneSearchControl } from './PaneSearchControl'
import { PaneStatusBadge } from './PaneStatusBadge'
import type { UnifiedTerminalHeaderProps } from './types'

const CHECK_IN_SHELL_NOTE =
  'Only agent sessions can check in later. A shell can’t report back on its own.'

export const UnifiedTerminalHeaderContent = memo(
  function UnifiedTerminalHeaderContent({
    slot,
    isActive = false,
    fontSize,
    onFontSizeChange,
    onReset,
    onCloseSession,
    onRefresh,
    onFiles,
    onUpload,
    onModeSwitch,
    isModeSwitching = false,
    isMobile = false,
    connectionStatus,
    searchAlwaysOpen = false,
    onSearch,
    onClearSearch,
    composeOpen = false,
    onToggleCompose,
  }: UnifiedTerminalHeaderProps) {
    const { enabledTools } = useAgentTools()
    const { renamePane } = useTerminalPanes()
    const { update: updateSession } = useTerminalSessions()
    const [isRenaming, setIsRenaming] = useState(false)
    // The title only where no list shows this session's row beside it: Rail,
    // a hidden side, a phone. Rename still opens the name field.
    const frame = useFrame()
    const listShowsRow = !!frame?.docked && frame.tier === 'panel'
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
        data-testid={`terminal-header-${getSlotPanelId(slot)}`}
        className={clsx(
          '@container relative flex h-12 flex-shrink-0 items-center gap-1',
          isMobile ? 'pr-1 pl-1.5' : 'pr-1.5 pl-2.5',
        )}
      >
        <SideEdgeButton />

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

        <div
          className={clsx(
            'flex min-w-0 flex-[0_1_auto] items-center',
            listShowsRow && !isRenaming && 'hidden',
          )}
        >
          <HeaderNameDisplay
            slot={slot}
            isActive={isActive}
            isMobile={isMobile}
            onRename={canRename ? handleRename : undefined}
            isEditing={isRenaming}
            onEditingChange={setIsRenaming}
          />
        </div>

        <PaneStatusBadge status={connectionStatus} compact={isMobile} />
        <ContextFillBadge
          sessionId={getSlotSessionId(slot)}
          mode={slot.type === 'project' ? slot.activeMode : slot.sessionMode}
        />

        <div className="min-w-1 flex-1" />

        <div className="flex min-w-0 flex-[0_1_auto] items-center gap-0.5">
          {onSearch && onClearSearch && (
            <PaneSearchControl
              onSearch={onSearch}
              onClearSearch={onClearSearch}
              isMobile={isMobile}
              alwaysOpen={searchAlwaysOpen}
            />
          )}

          {onToggleCompose && (
            <button
              type="button"
              onClick={onToggleCompose}
              aria-pressed={composeOpen}
              data-testid="compose-toggle"
              title="Compose text (stays open once opened)"
              aria-label="Compose"
              className="lantern-btn ghost"
              style={{ height: 34, padding: '0 10px' }}
            >
              <Pencil className="h-4 w-4" strokeWidth={1.7} />
              <span className="hidden @min-[760px]:inline">Compose</span>
            </button>
          )}

          {/* Icon only on a phone and when the session pane is under 760px, so the bar fits. */}
          {onFiles &&
            (isMobile ? (
              <HeaderIconButton
                icon={
                  <Folder className="h-[18px] w-[18px]" strokeWidth={1.7} />
                }
                onClick={onFiles}
                tooltip="Files"
                isMobile={isMobile}
              />
            ) : (
              <button
                type="button"
                onClick={onFiles}
                title="Files: this session's project folder and what agents shared"
                aria-label="Files"
                className="lantern-btn ghost"
                style={{ height: 34, padding: '0 10px' }}
              >
                <Folder className="h-4 w-4" strokeWidth={1.7} />
                <span className="hidden @min-[760px]:inline">Files</span>
              </button>
            ))}

          {hasSessionActions && (
            <PaneOverflowMenu
              onRename={canRename ? () => setIsRenaming(true) : undefined}
              checkInSessionId={getSlotSessionId(slot)}
              checkInUnavailable={
                (slot.type === 'project'
                  ? slot.activeMode
                  : slot.sessionMode) === 'shell'
                  ? CHECK_IN_SHELL_NOTE
                  : undefined
              }
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
