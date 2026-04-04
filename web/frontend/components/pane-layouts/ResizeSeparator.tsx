'use client'

import { useCallback, useRef, type PointerEvent } from 'react'
import { Separator, type GroupImperativeHandle } from 'react-resizable-panels'

interface ResizeSeparatorProps {
  orientation: 'horizontal' | 'vertical'
  groupRef: React.RefObject<GroupImperativeHandle | null>
  adjacentPanelIds: [string, string]
}

/**
 * Custom separator with double-click to reset adjacent panels to equal sizes.
 */
export function ResizeSeparator({
  orientation,
  groupRef,
  adjacentPanelIds,
}: ResizeSeparatorProps) {
  const pointerFocusRef = useRef(false)

  const handleDoubleClick = useCallback(() => {
    const group = groupRef.current
    if (!group) return

    const currentLayout = group.getLayout()
    const [panelA, panelB] = adjacentPanelIds
    const totalSize =
      (currentLayout[panelA] ?? 50) + (currentLayout[panelB] ?? 50)
    const equalSize = totalSize / 2

    const newLayout = {
      ...currentLayout,
      [panelA]: equalSize,
      [panelB]: equalSize,
    }

    group.setLayout(newLayout)
  }, [groupRef, adjacentPanelIds])

  const handlePointerDown = useCallback(() => {
    pointerFocusRef.current = true
  }, [])

  const clearPointerFocus = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (
        pointerFocusRef.current &&
        typeof document !== 'undefined' &&
        document.activeElement === event.currentTarget
      ) {
        event.currentTarget.blur()
      }

      pointerFocusRef.current = false
    },
    [],
  )

  return (
    <Separator
      className={
        orientation === 'horizontal'
          ? 'resizable-handle-horizontal'
          : 'resizable-handle-vertical'
      }
      onDoubleClick={handleDoubleClick}
      onPointerDown={handlePointerDown}
      onPointerLeave={clearPointerFocus}
      onPointerUp={clearPointerFocus}
    />
  )
}
