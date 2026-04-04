'use client'

import { Settings2 } from 'lucide-react'
import { forwardRef } from 'react'

export interface SettingsButtonProps {
  isActive: boolean
  onClick: () => void
}

export const SettingsButton = forwardRef<HTMLButtonElement, SettingsButtonProps>(
  function SettingsButton({ isActive, onClick }, ref) {
    return (
      <button
        ref={ref}
        data-testid="settings-dropdown"
        onClick={onClick}
        title="Terminal settings"
        aria-label="Terminal settings"
        className="p-2.5 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-md transition-all duration-150"
        style={{
          backgroundColor: isActive
            ? 'var(--term-bg-elevated)'
            : 'transparent',
          color: isActive ? 'var(--term-accent)' : 'var(--term-text-muted)',
          boxShadow: isActive ? '0 0 8px var(--term-accent-glow)' : 'none',
        }}
        onMouseEnter={(e) => {
          if (!isActive) {
            e.currentTarget.style.backgroundColor = 'var(--term-bg-elevated)'
            e.currentTarget.style.color = 'var(--term-text-primary)'
          }
        }}
        onMouseLeave={(e) => {
          if (!isActive) {
            e.currentTarget.style.backgroundColor = 'transparent'
            e.currentTarget.style.color = 'var(--term-text-muted)'
          }
        }}
      >
        <Settings2 className="w-4 h-4" />
      </button>
    )
  },
)
