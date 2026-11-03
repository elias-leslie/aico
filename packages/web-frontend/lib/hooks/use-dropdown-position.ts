import { type RefObject, useLayoutEffect, useState } from 'react'

interface UseDropdownPositionOptions {
  /** Estimated dropdown height for above/below calculation */
  estimatedHeight?: number
  /** Estimated dropdown width for left/right calculation (omit to always align right) */
  estimatedWidth?: number
}

/**
 * Hook to calculate fixed-position dropdown placement relative to a trigger element.
 * Automatically flips above/below and left/right when near viewport edges.
 */
export function useDropdownPosition(
  triggerRef: RefObject<HTMLElement | null>,
  isOpen: boolean,
  options: UseDropdownPositionOptions = {},
): React.CSSProperties {
  const { estimatedHeight = 88, estimatedWidth } = options
  const [style, setStyle] = useState<React.CSSProperties>({})

  // biome-ignore lint/correctness/useExhaustiveDependencies: ref.current is intentionally not a dependency — we read the DOM element at effect time, not as reactive state
  useLayoutEffect(() => {
    if (!isOpen || !triggerRef.current) return

    const rect = triggerRef.current.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom
    const openAbove = spaceBelow < estimatedHeight

    const newStyle: React.CSSProperties = {
      position: 'fixed',
      top: openAbove ? undefined : rect.bottom + 4,
      bottom: openAbove ? window.innerHeight - rect.top + 4 : undefined,
      zIndex: 9999,
    }

    if (estimatedWidth) {
      const spaceRight = window.innerWidth - rect.right
      const openLeft = spaceRight < estimatedWidth
      newStyle.right = openLeft ? window.innerWidth - rect.right : undefined
      newStyle.left = openLeft ? undefined : rect.left
    } else {
      newStyle.right = window.innerWidth - rect.right
    }

    setStyle(newStyle)
  }, [isOpen, estimatedHeight, estimatedWidth])

  return style
}
