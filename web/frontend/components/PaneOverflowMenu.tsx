'use client'

import {
  MoreHorizontal,
  Paperclip,
  Pencil,
  RefreshCw,
  RotateCcw,
  Square,
  Type,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  A_TERM_FONT_SIZES,
  type ATermFontSize,
} from '@/lib/hooks/use-a-term-settings'
import { useClickOutside } from '@/lib/hooks/use-click-outside'
import { MenuItemButton } from './MenuItemButton'

export interface PaneOverflowMenuProps {
  onCloseSession?: () => void
  onRefresh?: () => void
  onReset?: () => void
  onUpload?: () => void
  onRename?: () => void
  /** Text size, the one type setting; shown as a stepper when given. */
  fontSize?: ATermFontSize
  onFontSizeChange?: (size: ATermFontSize) => void
  isMobile?: boolean
}

const ICON = 'h-[18px] w-[18px]'

/**
 * The session menu in the session bar: upload, text size, the session's own
 * actions, and End session last.
 */
export function PaneOverflowMenu({
  onCloseSession,
  onRefresh,
  onReset,
  onUpload,
  onRename,
  fontSize,
  onFontSizeChange,
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

  const sizeIndex =
    fontSize === undefined ? -1 : A_TERM_FONT_SIZES.indexOf(fontSize)
  const stepSize = (step: number) => {
    const next = A_TERM_FONT_SIZES[sizeIndex + step]
    if (next !== undefined) onFontSizeChange?.(next)
  }
  const hasSessionActions = !!(onRename || onReset || onRefresh)

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        data-testid="pane-overflow-menu"
        onClick={() => setIsOpen(!isOpen)}
        className={isMobile ? 'lantern-icon-btn' : 'lantern-icon-btn compact'}
        title="Session menu"
        aria-label="Session menu"
        aria-haspopup="menu"
        aria-expanded={isOpen}
      >
        <MoreHorizontal className={ICON} strokeWidth={1.7} />
      </button>

      {isOpen && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Session menu"
          data-testid="pane-overflow-menu-items"
          className="lantern-sheet lantern-enter absolute right-0 top-full z-50 mt-1.5 min-w-[232px] rounded-xl p-1.5"
        >
          {onUpload && (
            <MenuItemButton
              icon={<Paperclip className={ICON} strokeWidth={1.7} />}
              label="Upload a file"
              onClick={run(onUpload)}
              isMobile={isMobile}
            />
          )}
          {fontSize !== undefined && onFontSizeChange && (
            <div
              role="group"
              aria-label="Text size"
              className="lantern-menu-item"
              style={{ minHeight: isMobile ? 44 : 38 }}
            >
              <Type className={ICON} strokeWidth={1.7} aria-hidden="true" />
              Text size
              <span className="ml-auto inline-flex items-center gap-0.5">
                <button
                  type="button"
                  className="lantern-btn"
                  style={{ width: 30, height: 30, padding: 0 }}
                  aria-label="Smaller text"
                  disabled={sizeIndex <= 0}
                  onClick={() => stepSize(-1)}
                >
                  −
                </button>
                <span
                  aria-live="polite"
                  className="w-[30px] text-center text-xs"
                  style={{
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--mist)',
                  }}
                >
                  {fontSize}
                </span>
                <button
                  type="button"
                  className="lantern-btn"
                  style={{ width: 30, height: 30, padding: 0 }}
                  aria-label="Larger text"
                  disabled={sizeIndex >= A_TERM_FONT_SIZES.length - 1}
                  onClick={() => stepSize(1)}
                >
                  +
                </button>
              </span>
            </div>
          )}
          {onRename && (
            <MenuItemButton
              icon={<Pencil className={ICON} strokeWidth={1.7} />}
              label="Rename"
              onClick={run(onRename)}
              isMobile={isMobile}
              title="Rename this session"
            />
          )}
          {onReset && (
            <MenuItemButton
              icon={<RotateCcw className={ICON} strokeWidth={1.7} />}
              label="Reset session"
              onClick={run(onReset)}
              isMobile={isMobile}
            />
          )}
          {onRefresh && (
            <MenuItemButton
              icon={<RefreshCw className={ICON} strokeWidth={1.7} />}
              label="Redraw"
              onClick={run(onRefresh)}
              isMobile={isMobile}
              title="Redraw this session's screen without restarting it"
            />
          )}
          {onCloseSession && (
            <>
              {(onUpload || onFontSizeChange || hasSessionActions) && (
                <hr
                  className="mx-1.5 my-1 border-0 border-t"
                  style={{ borderColor: 'rgb(var(--glass-rgb) / 0.06)' }}
                />
              )}
              <MenuItemButton
                icon={<Square className={ICON} strokeWidth={1.7} />}
                label="End session"
                onClick={run(onCloseSession)}
                isMobile={isMobile}
                variant="danger"
                title="End session: stop its process everywhere it is open."
              />
            </>
          )}
        </div>
      )}
    </div>
  )
}
