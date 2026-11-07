'use client'

import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { useFrame } from './FrameContext'

/** The one sidebar control, at the top left of the side in the rail and in the
 * panel: the rail opens to the panel, the panel folds to the rail. A phone's
 * side is a drawer opened from the session bar's menu instead. */
export function SideToggle() {
  const frame = useFrame()
  if (!frame?.docked || frame.tier === 'full') return null
  const open = frame.tier === 'panel'
  const label = open ? 'Collapse the side' : 'Expand the side'
  return (
    <button
      type="button"
      className="lantern-icon-btn compact flex-none"
      aria-label={label}
      aria-expanded={open}
      title={`${label} · Alt+[`}
      onClick={frame.toggle}
      data-testid="frame-toggle"
    >
      {open ? (
        <PanelLeftClose className="h-[18px] w-[18px]" strokeWidth={1.7} />
      ) : (
        <PanelLeftOpen className="h-[18px] w-[18px]" strokeWidth={1.7} />
      )}
    </button>
  )
}
