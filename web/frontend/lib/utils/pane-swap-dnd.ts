import type { DragEvent } from 'react'

export const PANE_SWAP_DRAG_MIME_TYPE = 'application/x-terminal-pane-slot'
export const PANE_SWAP_FALLBACK_MIME_TYPE = 'text/plain'

let activeDraggedPaneSlotId: string | null = null

export function setDraggedPaneSlotId(
  event: DragEvent<HTMLElement>,
  slotId: string,
): void {
  activeDraggedPaneSlotId = slotId
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData(PANE_SWAP_DRAG_MIME_TYPE, slotId)
  event.dataTransfer.setData(PANE_SWAP_FALLBACK_MIME_TYPE, slotId)
}

export function isPaneSwapDragEvent(
  event: DragEvent<HTMLElement>,
): boolean {
  const types = Array.from(event.dataTransfer?.types ?? [])
  return (
    !!activeDraggedPaneSlotId ||
    types.includes(PANE_SWAP_DRAG_MIME_TYPE) ||
    types.includes(PANE_SWAP_FALLBACK_MIME_TYPE)
  )
}

export function getDraggedPaneSlotId(
  event: DragEvent<HTMLElement>,
): string {
  const customSlotId = event.dataTransfer?.getData(PANE_SWAP_DRAG_MIME_TYPE) ?? ''
  const fallbackSlotId = event.dataTransfer?.getData(PANE_SWAP_FALLBACK_MIME_TYPE) ?? ''

  return customSlotId || fallbackSlotId || activeDraggedPaneSlotId || ''
}

export function clearDraggedPaneSlotId(): void {
  activeDraggedPaneSlotId = null
}
