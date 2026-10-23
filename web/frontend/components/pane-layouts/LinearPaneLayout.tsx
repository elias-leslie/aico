'use client'

import { Group, Panel, useGroupRef } from 'react-resizable-panels'
import { getSlotPanelId } from '@/lib/utils/slot'
import { ResizeSeparator } from './ResizeSeparator'
import type { LayoutHelperProps } from './types'

/**
 * Linear pane layout for true row/column splits.
 */
export function LinearPaneLayout({
  containerRef,
  displaySlots,
  getMinSizePercent,
  createGroupLayoutChangeHandler,
  getStoredGroupLayout,
  renderPane,
  orientation = 'horizontal',
}: LayoutHelperProps) {
  const groupRef = useGroupRef()
  const panelIds = displaySlots.map((slot) => getSlotPanelId(slot))
  const groupId = `linear-pane-${orientation}-${displaySlots.length}`
  const panelSizes = getStoredGroupLayout(
    groupId,
    displaySlots.length,
    100 / displaySlots.length,
  )
  const minSizePercent = getMinSizePercent(orientation, displaySlots.length)

  return (
    <div
      ref={containerRef}
      className="w-full h-full p-1"
      style={{ backgroundColor: 'var(--term-bg-deep)' }}
    >
      <Group
        orientation={orientation}
        onLayoutChange={createGroupLayoutChangeHandler(groupId, panelIds, true)}
        groupRef={groupRef}
        className="h-full"
      >
        {displaySlots.flatMap((slot, index) => {
          const panelId = panelIds[index]
          const panelNode = (
            <Panel
              key={panelId}
              id={panelId}
              minSize={`${minSizePercent}%`}
              defaultSize={`${panelSizes[index] ?? 100 / displaySlots.length}%`}
              className="h-full"
            >
              {renderPane(slot, index)}
            </Panel>
          )

          if (index === displaySlots.length - 1) {
            return [panelNode]
          }

          return [
            panelNode,
            <ResizeSeparator
              key={`separator-${panelId}`}
              orientation={orientation}
              groupRef={groupRef}
              adjacentPanelIds={[panelId, panelIds[index + 1]]}
            />,
          ]
        })}
      </Group>
    </div>
  )
}
