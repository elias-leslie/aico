'use client'

import { clsx } from 'clsx'
import { useCallback } from 'react'
import { keepKeyboardOpen, type ModifierState } from './types'

interface KeyboardKeyProps {
  label: string
  onPress: () => void
  state?: ModifierState
  width?: number // Width multiplier (1 = normal, 1.5 = 1.5x width, etc.)
  className?: string
  style?: React.CSSProperties
}

// Provide haptic feedback if available
function vibrate() {
  if (typeof navigator !== 'undefined' && navigator.vibrate) {
    navigator.vibrate(10)
  }
}

export function KeyboardKey({
  label,
  onPress,
  state = 'off',
  width = 1,
  className,
  style,
}: KeyboardKeyProps) {
  const handleClick = useCallback(() => {
    vibrate()
    onPress()
  }, [onPress])

  // Get styles based on state using CSS variables
  const getStateStyles = (): React.CSSProperties => {
    switch (state) {
      case 'locked':
        return {
          backgroundColor: 'var(--term-accent)',
          color: 'var(--term-accent-foreground)',
          border: '1px solid var(--term-accent)',
          boxShadow: '0 0 8px var(--term-accent-glow)',
        }
      case 'sticky':
        return {
          backgroundColor: 'var(--term-bg-elevated)',
          color: 'var(--term-accent)',
          border: '1px solid var(--term-accent-muted)',
        }
      default: // "off"
        return {
          backgroundColor: 'var(--term-bg-elevated)',
          color: 'var(--term-text-primary)',
          border: '1px solid var(--term-border)',
        }
    }
  }

  return (
    <button
      type="button"
      onPointerDown={keepKeyboardOpen}
      onClick={handleClick}
      className={clsx(
        // Base styles
        'flex items-center justify-center',
        'text-base font-medium',
        'rounded-md',
        'select-none touch-manipulation',
        'transition-all duration-100',
        // Height - reduced for compact mobile layout
        'h-9 min-h-[36px]',
        className,
      )}
      style={{
        flex: width,
        minWidth: `${width * 36}px`, // 36px base width for compact layout
        ...getStateStyles(),
        ...style,
      }}
    >
      {label}
    </button>
  )
}
