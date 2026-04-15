'use client'

import { clsx } from 'clsx'
import {
  LogOut,
  Menu,
  Mic,
  Paperclip,
  Pencil,
  RefreshCw,
  Settings,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useClickOutside } from '@/lib/hooks/use-click-outside'
import { MenuItemButton } from './MenuItemButton'

export interface PaneOverflowMenuProps {
  onDetach?: () => void
  detachTooltip?: string
  onClosePane?: () => void
  closePaneLabel?: string
  closePaneTooltip?: string
  onCloseSession?: () => void
  closeSessionTooltip?: string
  onReset?: () => void
  onSettings?: () => void
  onUpload?: () => void
  onVoice?: () => void
  onClean?: () => void
  onResetAll?: () => void
  onCloseAll?: () => void
  onRename?: () => void
  isMobile?: boolean
}

/**
 * Consolidated pane actions menu for header controls.
 */
export function PaneOverflowMenu({
  onDetach,
  detachTooltip = 'Detach pane: open this pane in its own window.',
  onClosePane,
  closePaneLabel = 'Close Pane',
  closePaneTooltip = 'Close pane: remove it from this layout but keep the session running.',
  onCloseSession,
  closeSessionTooltip = 'Close session: terminate the underlying tmux session.',
  onReset,
  onSettings,
  onUpload,
  onVoice,
  onClean,
  onResetAll,
  onCloseAll,
  onRename,
  isMobile = false,
}: PaneOverflowMenuProps) {
  const [isOpen, setIsOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const closeMenu = useCallback(() => setIsOpen(false), [])
  const clickOutsideRefs = useMemo(() => [buttonRef, menuRef], [])
  useClickOutside(clickOutsideRefs, closeMenu, isOpen)

  useEffect(() => {
    if (!isOpen) return
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false)
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [isOpen])

  const handleDetach = useCallback(() => {
    onDetach?.()
    setIsOpen(false)
  }, [onDetach])

  const handleClosePane = useCallback(() => {
    onClosePane?.()
    setIsOpen(false)
  }, [onClosePane])

  const handleResetAll = useCallback(() => {
    onResetAll?.()
    setIsOpen(false)
  }, [onResetAll])

  const handleCloseAll = useCallback(() => {
    onCloseAll?.()
    setIsOpen(false)
  }, [onCloseAll])

  const handleCloseSession = useCallback(() => {
    onCloseSession?.()
    setIsOpen(false)
  }, [onCloseSession])

  const handleReset = useCallback(() => {
    onReset?.()
    setIsOpen(false)
  }, [onReset])

  const handleSettings = useCallback(() => {
    onSettings?.()
    setIsOpen(false)
  }, [onSettings])

  const handleUpload = useCallback(() => {
    onUpload?.()
    setIsOpen(false)
  }, [onUpload])

  const handleVoice = useCallback(() => {
    onVoice?.()
    setIsOpen(false)
  }, [onVoice])

  const handleClean = useCallback(() => {
    onClean?.()
    setIsOpen(false)
  }, [onClean])

  const handleRename = useCallback(() => {
    onRename?.()
    setIsOpen(false)
  }, [onRename])

  const hasPaneSessionActions = !!(onDetach || onClosePane || onCloseSession)
  const hasPaneUtilityActions = !!(
    onReset ||
    onSettings ||
    onUpload ||
    onVoice ||
    onClean
  )
  const hasBulkActions = !!(onResetAll || onCloseAll)

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        data-testid="pane-overflow-menu"
        onClick={() => setIsOpen(!isOpen)}
        className={clsx(
          'flex items-center justify-center rounded transition-all duration-150',
          isMobile ? 'w-8 h-8' : 'w-6 h-6',
        )}
        style={{ color: 'var(--term-text-muted)' }}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = 'var(--term-bg-elevated)'
          e.currentTarget.style.color = 'var(--term-accent)'
        }}
        onMouseLeave={(e) => {
          if (!isOpen) {
            e.currentTarget.style.backgroundColor = 'transparent'
            e.currentTarget.style.color = 'var(--term-text-muted)'
          }
        }}
        title="Pane actions"
        aria-label="Pane actions"
        aria-haspopup="menu"
        aria-expanded={isOpen}
      >
        <Menu className="w-3.5 h-3.5" />
      </button>

      {isOpen && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Pane actions"
          data-testid="pane-overflow-menu-items"
          className="absolute right-0 top-full mt-1 z-50 min-w-[180px] py-1 rounded-md shadow-lg animate-in fade-in slide-in-from-top-1 duration-100"
          style={{
            backgroundColor: 'var(--term-surface-glass)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            border: '1px solid var(--term-border-active)',
            boxShadow: 'var(--term-shadow-dropdown)',
          }}
        >
          {onDetach && (
            <MenuItemButton
              icon={<LogOut className="w-3.5 h-3.5" />}
              label="Detach Pane"
              onClick={handleDetach}
              isMobile={isMobile}
              title={detachTooltip}
            />
          )}
          {onClosePane && (
            <MenuItemButton
              icon={<X className="w-3.5 h-3.5" />}
              label={closePaneLabel}
              onClick={handleClosePane}
              isMobile={isMobile}
              title={closePaneTooltip}
            />
          )}
          {onCloseSession && (
            <MenuItemButton
              icon={<Trash2 className="w-3.5 h-3.5" />}
              label="Close Session"
              onClick={handleCloseSession}
              isMobile={isMobile}
              variant="danger"
              title={closeSessionTooltip}
            />
          )}
          {onRename && (
            <MenuItemButton
              icon={<Pencil className="w-3.5 h-3.5" />}
              label="Rename"
              onClick={handleRename}
              isMobile={isMobile}
              title="Rename this pane"
            />
          )}
          {(hasPaneSessionActions || !!onRename) && hasPaneUtilityActions && (
            <div
              className="mx-2 my-1 h-px"
              style={{ backgroundColor: 'var(--term-border)' }}
            />
          )}
          {onReset && (
            <MenuItemButton
              icon={<RefreshCw className="w-3.5 h-3.5" />}
              label="Reset A-Term"
              onClick={handleReset}
              isMobile={isMobile}
            />
          )}
          {onClean && (
            <MenuItemButton
              icon={<Sparkles className="w-3.5 h-3.5" />}
              label="Clean Prompt"
              onClick={handleClean}
              isMobile={isMobile}
            />
          )}
          {onUpload && (
            <MenuItemButton
              icon={<Paperclip className="w-3.5 h-3.5" />}
              label="Upload File"
              onClick={handleUpload}
              isMobile={isMobile}
            />
          )}
          {onVoice && (
            <MenuItemButton
              icon={<Mic className="w-3.5 h-3.5" />}
              label="Voice Input"
              onClick={handleVoice}
              isMobile={isMobile}
            />
          )}
          {onSettings && (
            <MenuItemButton
              icon={<Settings className="w-3.5 h-3.5" />}
              label="Settings"
              onClick={handleSettings}
              isMobile={isMobile}
            />
          )}
          {(hasPaneSessionActions || hasPaneUtilityActions) &&
            hasBulkActions && (
              <div
                className="mx-2 my-1 h-px"
                style={{ backgroundColor: 'var(--term-border)' }}
              />
            )}
          {onResetAll && (
            <MenuItemButton
              icon={<RefreshCw className="w-3.5 h-3.5" />}
              label="Reset All"
              onClick={handleResetAll}
              isMobile={isMobile}
            />
          )}
          {onCloseAll && (
            <MenuItemButton
              icon={<X className="w-3.5 h-3.5" />}
              label="Close All"
              onClick={handleCloseAll}
              isMobile={isMobile}
              variant="danger"
            />
          )}
        </div>
      )}
    </div>
  )
}
