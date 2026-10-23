'use client'

import { clsx } from 'clsx'
import { useCallback } from 'react'
import { keepKeyboardOpen } from './types'

interface KeyboardKeyProps {
  label: string
  onPress: () => void
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
  width = 1,
  className,
  style,
}: KeyboardKeyProps) {
  const handleClick = useCallback(() => {
    vibrate()
    onPress()
  }, [onPress])

  return (
    <button
      type="button"
      onPointerDown={keepKeyboardOpen}
      onClick={handleClick}
      className={clsx('lantern-key h-9 min-h-[36px]', className)}
      style={{
        flex: width,
        minWidth: `${width * 36}px`, // 36px base width for compact layout
        ...style,
      }}
    >
      {label}
    </button>
  )
}
