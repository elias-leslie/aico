'use client'

import { Group, Panel, useGroupRef } from 'react-resizable-panels'
import { getSlotPanelId } from '@/lib/utils/slot'
import { ResizeSeparator } from './ResizeSeparator'
import type { LayoutHelperProps } from './types'

/**
 * Asymmetric 3-pane layout: one wide main pane on top,
 * two smaller panes side-by-side on the bottom.
 *
 * ┌────────────────────┐
 * │       Main         │
 * ├─────────┬──────────┤
 * │  Side 1 │  Side 2  │
 * └─────────┴──────────┘
 */
export function MainSidePaneLayout({
  containerRef,
  displaySlots,
  getMinSizePercent,
  createGroupLayoutChangeHandler,
  getStoredGroupLayout,
  renderPane,
}: LayoutHelperProps) {
  const verticalGroupRef = useGroupRef()
  const bottomRowGroupRef = useGroupRef()

  const mainPanelId = getSlotPanelId(displaySlots[0])
  const bottomRowPanelIds: [string, string] = [
    getSlotPanelId(displaySlots[1]),
    getSlotPanelId(displaySlots[2]),
  ]

  const rootSizes = getStoredGroupLayout('main-side-root', 2, 60)
  const bottomRowSizes = getStoredGroupLayout('main-side-bottom-row', 2, 50)
  const columnMinSizePercent = getMinSizePercent('vertical', 2)
  const rowMinSizePercent = getMinSizePercent('horizontal', 2)

  return (
    <div
      ref={containerRef}
      className="w-full h-full p-1"
      style={{ backgroundColor: 'var(--term-bg-deep)' }}
    >
      <Group
        orientation="vertical"
        onLayoutChange={createGroupLayoutChangeHandler('main-side-root', [
          mainPanelId,
          'bottom-row',
        ])}
        groupRef={verticalGroupRef}
        className="h-full"
      >
        {/* Main pane — takes ~60% height by default */}
        <Panel
          id={mainPanelId}
          minSize={`${columnMinSizePercent}%`}
          defaultSize={`${rootSizes[0]}%`}
          className="h-full"
        >
          {renderPane(displaySlots[0], 0)}
        </Panel>

        <ResizeSeparator
          orientation="vertical"
          groupRef={verticalGroupRef}
          adjacentPanelIds={[mainPanelId, 'bottom-row']}
        />

        {/* Bottom row — two side-by-side panes */}
        <Panel
          id="bottom-row"
          minSize={`${columnMinSizePercent}%`}
          defaultSize={`${rootSizes[1]}%`}
        >
          <Group
            orientation="horizontal"
            onLayoutChange={createGroupLayoutChangeHandler(
              'main-side-bottom-row',
              bottomRowPanelIds,
              true,
            )}
            groupRef={bottomRowGroupRef}
            className="h-full"
          >
            <Panel
              id={bottomRowPanelIds[0]}
              minSize={`${rowMinSizePercent}%`}
              defaultSize={`${bottomRowSizes[0]}%`}
              className="h-full"
            >
              {renderPane(displaySlots[1], 1)}
            </Panel>

            <ResizeSeparator
              orientation="horizontal"
              groupRef={bottomRowGroupRef}
              adjacentPanelIds={bottomRowPanelIds}
            />

            <Panel
              id={bottomRowPanelIds[1]}
              minSize={`${rowMinSizePercent}%`}
              defaultSize={`${bottomRowSizes[1]}%`}
              className="h-full"
            >
              {renderPane(displaySlots[2], 2)}
            </Panel>
          </Group>
        </Panel>
      </Group>
    </div>
  )
}
