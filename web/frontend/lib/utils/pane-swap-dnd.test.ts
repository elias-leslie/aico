import { describe, expect, it } from 'vitest'
import {
  clearDraggedPaneSlotId,
  getDraggedPaneSlotId,
  isPaneSwapDragEvent,
  setDraggedPaneSlotId,
} from './pane-swap-dnd'

function createDragEvent(dataTransfer: {
  types?: string[]
  getData?: (type: string) => string
  setData?: (type: string, value: string) => void
  effectAllowed?: string
}) {
  return {
    dataTransfer: {
      types: dataTransfer.types ?? [],
      effectAllowed: dataTransfer.effectAllowed ?? 'move',
      getData: dataTransfer.getData ?? (() => ''),
      setData: dataTransfer.setData ?? (() => {}),
    },
  } as unknown as React.DragEvent<HTMLElement>
}

describe('pane-swap-dnd', () => {
  it('recognizes pane drags from declared drag types before payload is readable', () => {
    const event = createDragEvent({
      types: ['application/x-aterm-pane-slot'],
    })

    expect(isPaneSwapDragEvent(event)).toBe(true)
  })

  it('falls back to the active dragged slot when dragover payload data is empty', () => {
    const writtenData = new Map<string, string>()
    const dragStartEvent = createDragEvent({
      setData: (type, value) => {
        writtenData.set(type, value)
      },
    })

    setDraggedPaneSlotId(dragStartEvent, 'pane-1')

    const dragOverEvent = createDragEvent({
      types: ['application/x-aterm-pane-slot', 'text/plain'],
      getData: () => '',
    })

    expect(getDraggedPaneSlotId(dragOverEvent)).toBe('pane-1')

    clearDraggedPaneSlotId()
    expect(writtenData.get('application/x-aterm-pane-slot')).toBe('pane-1')
    expect(writtenData.get('text/plain')).toBe('pane-1')
  })
})
