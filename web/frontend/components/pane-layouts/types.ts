import type { Layout } from 'react-resizable-panels'
import type { PaneSlot, ATermSlot } from '@/lib/utils/slot'

export interface LayoutHelperProps {
  containerRef: React.RefObject<HTMLDivElement | null>
  displaySlots: (ATermSlot | PaneSlot)[]
  getMinSizePercent: (
    direction: 'horizontal' | 'vertical',
    panelCount?: number,
  ) => number
  getStoredGroupLayout: (
    groupId: string,
    panelCount: number,
    defaultSize: number,
  ) => number[]
  createGroupLayoutChangeHandler: (
    groupId: string,
    panelIds: string[],
    persistPaneLayouts?: boolean,
  ) => (layout: Layout) => void
  renderPane: (slot: ATermSlot | PaneSlot, index: number) => React.ReactNode
  orientation?: 'horizontal' | 'vertical'
}
