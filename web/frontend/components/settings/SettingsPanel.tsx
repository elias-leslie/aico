'use client'

import { forwardRef, useLayoutEffect, useState, type ReactNode } from 'react'

export interface SettingsPanelProps {
  isOpen: boolean
  hasButton: boolean
  buttonRef?: React.RefObject<HTMLButtonElement | null>
  children: ReactNode
}

export const SettingsPanel = forwardRef<HTMLDivElement, SettingsPanelProps>(
  function SettingsPanel({ isOpen, hasButton, buttonRef, children }, ref) {
    const [dropdownStyle, setDropdownStyle] =
      useState<React.CSSProperties | null>(null)

    useLayoutEffect(() => {
      if (isOpen) {
        // Get safe area inset (for PWA apps with title bars)
        const safeAreaTop = parseInt(
          getComputedStyle(document.documentElement).getPropertyValue(
            '--sat',
          ) || '0',
          10,
        )
        const minTop = Math.max(safeAreaTop, 8)

        if (hasButton && buttonRef?.current) {
          // Position relative to button
          const rect = buttonRef.current.getBoundingClientRect()
          const calculatedTop = rect.bottom + 4
          setDropdownStyle({
            position: 'fixed',
            right: window.innerWidth - rect.right,
            top: Math.max(minTop, calculatedTop),
            zIndex: 10001,
          })
        } else {
          // No button - position in top-right corner
          setDropdownStyle({
            position: 'fixed',
            right: 16,
            top: Math.max(minTop, 56), // Below typical header height
            zIndex: 10001,
          })
        }
      } else {
        setDropdownStyle(null)
      }
    }, [isOpen, hasButton, buttonRef])

    if (!isOpen || !dropdownStyle) {
      return null
    }

    return (
      <div
        ref={ref}
        data-testid="settings-dropdown-menu"
        style={{
          ...dropdownStyle,
          backgroundColor: 'var(--term-surface-glass)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          border: '1px solid var(--term-border-active)',
          boxShadow: 'var(--term-shadow-dropdown)',
        }}
        className="rounded-lg p-4 min-w-[220px] max-h-[80vh] overflow-y-auto animate-in fade-in slide-in-from-top-2 duration-150"
      >
        {children}
      </div>
    )
  },
)
