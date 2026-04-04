'use client'

import { Group, Panel, useGroupRef } from 'react-resizable-panels'
import { getSlotPanelId } from '@/lib/utils/slot'
import { ResizeSeparator } from './ResizeSeparator'
import type { LayoutHelperProps } from './types'

function WidePaneRow({
  slots,
  startIndex,
  renderPane,
  getMinSizePercent,
  createGroupLayoutChangeHandler,
  getStoredGroupLayout,
  groupId,
}: {
  slots: LayoutHelperProps['displaySlots']
  startIndex: number
  renderPane: LayoutHelperProps['renderPane']
  getMinSizePercent: LayoutHelperProps['getMinSizePercent']
  createGroupLayoutChangeHandler: LayoutHelperProps['createGroupLayoutChangeHandler']
  getStoredGroupLayout: LayoutHelperProps['getStoredGroupLayout']
  groupId: string
}) {
  const rowGroupRef = useGroupRef()
  const panelIds = slots.map((slot) => getSlotPanelId(slot))
  const panelSizes = getStoredGroupLayout(groupId, slots.length, 100 / slots.length)
  const minSizePercent = getMinSizePercent('horizontal', slots.length)

  return (
    <Group
      orientation="horizontal"
      onLayoutChange={createGroupLayoutChangeHandler(groupId, panelIds, true)}
      groupRef={rowGroupRef}
      className="h-full"
    >
      {slots.flatMap((slot, rowIndex) => {
        const panelId = panelIds[rowIndex]
        const panelNode = (
          <Panel
            key={panelId}
            id={panelId}
            minSize={`${minSizePercent}%`}
            defaultSize={`${panelSizes[rowIndex] ?? 100 / slots.length}%`}
            className="h-full"
          >
            {renderPane(slot, startIndex + rowIndex)}
          </Panel>
        )

        if (rowIndex === slots.length - 1) return [panelNode]

        return [
          panelNode,
          <ResizeSeparator
            key={`separator-${panelId}`}
            orientation="horizontal"
            groupRef={rowGroupRef}
            adjacentPanelIds={[panelId, panelIds[rowIndex + 1]]}
          />,
        ]
      })}
    </Group>
  )
}

export function WidePaneLayout({
  containerRef,
  displaySlots,
  getMinSizePercent,
  createGroupLayoutChangeHandler,
  getStoredGroupLayout,
  renderPane,
}: LayoutHelperProps) {
  const verticalGroupRef = useGroupRef()
  const topRowSlots = displaySlots.slice(0, 3)
  const bottomRowSlots = displaySlots.slice(3)
  const rootPanelIds =
    bottomRowSlots.length > 0 ? ['wide-top-row', 'wide-bottom-row'] : ['wide-top-row']
  const rootSizes = getStoredGroupLayout(
    'wide-pane-root',
    rootPanelIds.length,
    bottomRowSlots.length > 0 ? 50 : 100,
  )
  const rowMinSizePercent = getMinSizePercent('vertical', rootPanelIds.length)

  return (
    <div
      ref={containerRef}
      className="w-full h-full p-1"
      style={{ backgroundColor: 'var(--term-bg-deep)' }}
    >
      <Group
        orientation="vertical"
        onLayoutChange={createGroupLayoutChangeHandler('wide-pane-root', rootPanelIds)}
        groupRef={verticalGroupRef}
        className="h-full"
      >
        <Panel
          id="wide-top-row"
          minSize={`${rowMinSizePercent}%`}
          defaultSize={`${rootSizes[0] ?? (bottomRowSlots.length > 0 ? 50 : 100)}%`}
        >
          <WidePaneRow
            slots={topRowSlots}
            startIndex={0}
            renderPane={renderPane}
            getMinSizePercent={getMinSizePercent}
            createGroupLayoutChangeHandler={createGroupLayoutChangeHandler}
            getStoredGroupLayout={getStoredGroupLayout}
            groupId="wide-pane-top-row"
          />
        </Panel>

        {bottomRowSlots.length > 0 && (
          <>
            <ResizeSeparator
              orientation="vertical"
              groupRef={verticalGroupRef}
              adjacentPanelIds={['wide-top-row', 'wide-bottom-row']}
            />

            <Panel
              id="wide-bottom-row"
              minSize={`${rowMinSizePercent}%`}
              defaultSize={`${rootSizes[1] ?? 50}%`}
            >
              <WidePaneRow
                slots={bottomRowSlots}
                startIndex={topRowSlots.length}
                renderPane={renderPane}
                getMinSizePercent={getMinSizePercent}
                createGroupLayoutChangeHandler={createGroupLayoutChangeHandler}
                getStoredGroupLayout={getStoredGroupLayout}
                groupId="wide-pane-bottom-row"
              />
            </Panel>
          </>
        )}
      </Group>
    </div>
  )
}
