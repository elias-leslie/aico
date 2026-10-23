'use client'

import { clsx } from 'clsx'
import {
  Menu,
  Paperclip,
  Pencil,
  RefreshCw,
  Settings,
  Trash2,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useClickOutside } from '@/lib/hooks/use-click-outside'
import { MenuItemButton } from './MenuItemButton'

export interface PaneOverflowMenuProps {
  onCloseSession?: () => void
  onRefresh?: () => void
  onReset?: () => void
  onSettings?: () => void
  onUpload?: () => void
  onRename?: () => void
  isMobile?: boolean
}

/**
 * The session menu in the session bar.
 */
export function PaneOverflowMenu({
  onCloseSession,
  onRefresh,
  onReset,
  onSettings,
  onUpload,
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

  const run = useCallback(
    (action?: () => void) => () => {
      action?.()
      setIsOpen(false)
    },
    [],
  )

  const hasSessionActions = !!(onCloseSession || onRename)
  const hasUtilityActions = !!(onReset || onSettings || onUpload || onRefresh)

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
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
        title="Session menu"
        aria-label="Session menu"
        aria-haspopup="menu"
        aria-expanded={isOpen}
      >
        <Menu className="w-3.5 h-3.5" />
      </button>

      {isOpen && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Session menu"
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
          {onCloseSession && (
            <MenuItemButton
              icon={<Trash2 className="w-3.5 h-3.5" />}
              label="End session"
              onClick={run(onCloseSession)}
              isMobile={isMobile}
              variant="danger"
              title="End session: stop its process everywhere it is open."
            />
          )}
          {onRename && (
            <MenuItemButton
              icon={<Pencil className="w-3.5 h-3.5" />}
              label="Rename"
              onClick={run(onRename)}
              isMobile={isMobile}
              title="Rename this session"
            />
          )}
          {hasSessionActions && hasUtilityActions && (
            <div
              className="mx-2 my-1 h-px"
              style={{ backgroundColor: 'var(--term-border)' }}
            />
          )}
          {onReset && (
            <MenuItemButton
              icon={<RefreshCw className="w-3.5 h-3.5" />}
              label="Reset session"
              onClick={run(onReset)}
              isMobile={isMobile}
            />
          )}
          {onRefresh && (
            <MenuItemButton
              icon={<RefreshCw className="w-3.5 h-3.5" />}
              label="Redraw"
              onClick={run(onRefresh)}
              isMobile={isMobile}
              title="Redraw this session's screen without restarting it"
            />
          )}
          {onUpload && (
            <MenuItemButton
              icon={<Paperclip className="w-3.5 h-3.5" />}
              label="Upload file"
              onClick={run(onUpload)}
              isMobile={isMobile}
            />
          )}
          {onSettings && (
            <MenuItemButton
              icon={<Settings className="w-3.5 h-3.5" />}
              label="Settings"
              onClick={run(onSettings)}
              isMobile={isMobile}
            />
          )}
        </div>
      )}
    </div>
  )
}
