import { useCallback, useEffect, useState } from 'react'
import {
  DEFAULT_MIN_SIZE_PERCENT,
  MIN_PANE_HEIGHT_PX,
  MIN_PANE_WIDTH_PX,
  MIN_RESIZE_HEADROOM_PERCENT,
} from '@/types/pane-layout'

interface ContainerSize {
  width: number
  height: number
}

function getMaxMinSizePercent(panelCount: number) {
  if (panelCount <= 1) return 100

  return Math.max(10, 100 / panelCount - MIN_RESIZE_HEADROOM_PERCENT)
}

/**
 * Hook to calculate minimum pane size percentages based on container dimensions.
 * Pixel targets are capped so an evenly split group always retains drag headroom.
 */
export function useMinSizeCalculator(
  containerRef: React.RefObject<HTMLDivElement | null>,
) {
  const [containerSize, setContainerSize] = useState<ContainerSize | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const updateContainerSize = () => {
      const { width, height } = container.getBoundingClientRect()
      setContainerSize((current) => {
        if (current && current.width === width && current.height === height) {
          return current
        }

        return { width, height }
      })
    }

    updateContainerSize()

    if (typeof ResizeObserver === 'undefined') return

    const resizeObserver = new ResizeObserver(() => {
      updateContainerSize()
    })

    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
    }
  }, [containerRef])

  const getMinSizePercent = useCallback(
    (direction: 'horizontal' | 'vertical', panelCount = 2) => {
      const maxMinSizePercent = getMaxMinSizePercent(panelCount)
      const axisSize =
        direction === 'horizontal'
          ? containerSize?.width
          : containerSize?.height

      if (!axisSize || axisSize <= 0) {
        return Math.min(DEFAULT_MIN_SIZE_PERCENT, maxMinSizePercent)
      }

      const preferredMinSizePx =
        direction === 'horizontal' ? MIN_PANE_WIDTH_PX : MIN_PANE_HEIGHT_PX
      const percent = Math.max((preferredMinSizePx / axisSize) * 100, 10)

      return Math.min(percent, maxMinSizePercent)
    },
    [containerSize],
  )

  return getMinSizePercent
}
