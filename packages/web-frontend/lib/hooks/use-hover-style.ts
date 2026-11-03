import { useState } from 'react'

export interface UseHoverStyleOptions {
  hoverBg?: string
  defaultBg?: string
  hoverColor?: string
  defaultColor?: string
  hoverBorderColor?: string
  defaultBorderColor?: string
}

export interface UseHoverStyleReturn {
  onMouseEnter: () => void
  onMouseLeave: () => void
  style: {
    backgroundColor: string
    color: string
    borderColor?: string
  }
  isHovered: boolean
}

/**
 * Hook for managing button hover state and styles.
 * Eliminates duplication of inline hover handlers.
 *
 * @example
 * const hover = useHoverStyle({
 *   hoverBg: 'var(--term-bg-surface)',
 *   defaultBg: 'transparent',
 *   hoverColor: 'var(--term-text-primary)',
 *   defaultColor: 'var(--term-text-muted)',
 * });
 *
 * <button {...hover.onMouseEnter} {...hover.onMouseLeave} style={hover.style}>
 *   Click me
 * </button>
 */
export function useHoverStyle({
  hoverBg = 'transparent',
  defaultBg = 'transparent',
  hoverColor,
  defaultColor,
  hoverBorderColor,
  defaultBorderColor,
}: UseHoverStyleOptions): UseHoverStyleReturn {
  const [isHovered, setIsHovered] = useState(false)

  return {
    onMouseEnter: () => setIsHovered(true),
    onMouseLeave: () => setIsHovered(false),
    style: {
      backgroundColor: isHovered ? hoverBg : defaultBg,
      color: isHovered ? hoverColor || defaultColor || '' : defaultColor || '',
      ...(defaultBorderColor && {
        borderColor: isHovered
          ? hoverBorderColor || defaultBorderColor
          : defaultBorderColor,
      }),
    },
    isHovered,
  }
}
