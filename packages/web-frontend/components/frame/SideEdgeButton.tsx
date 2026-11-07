'use client'

import { Menu, PanelLeftOpen } from 'lucide-react'
import { useNeedsYouCounts } from '@/lib/hooks/use-needs-you'
import { type Frame, useFrame } from './FrameContext'

/** Whether the side is out of sight, so the session's own bar carries the way
 * back to it: hidden beside the session, or (a phone) slid away. */
export function sideIsAway(frame: Frame | null): frame is Frame {
  return !!frame && (!frame.docked || frame.tier === 'hidden')
}

/** The left edge of the session's bar while the side is out of sight: Show
 * the side (hidden), or the menu on a phone. Needs you waiting shows as an
 * amber count on it, only above 0; an unread count says nothing. */
export function SideEdgeButton({
  dockedOnly = false,
}: {
  /** A bar that has its own way to the phone's menu (the chat's Back). */
  dockedOnly?: boolean
}) {
  const frame = useFrame()
  if (!sideIsAway(frame) || (dockedOnly && !frame.docked)) return null
  return <EdgeButton frame={frame} />
}

function EdgeButton({ frame }: { frame: Frame }) {
  const needs = useNeedsYouCounts()
  const waiting = needs.count > 0 ? `${needs.count} need you` : null
  const phone = !frame.docked
  const label = phone ? 'Sessions and everything else' : 'Show the side'
  const name = waiting ? `${label} · ${waiting}` : label
  return (
    <button
      type="button"
      className="lantern-icon-btn compact relative flex-none"
      aria-label={name}
      title={phone || waiting ? name : `${label} · Alt+1`}
      onClick={() => (phone ? frame.setSheetOpen(true) : frame.setTier('rail'))}
      data-testid={phone ? 'frame-menu' : 'frame-side-restore'}
    >
      {phone ? (
        <Menu className="h-5 w-5" strokeWidth={1.7} />
      ) : (
        <PanelLeftOpen className="h-5 w-5" strokeWidth={1.7} />
      )}
      {needs.count > 0 && (
        <span aria-hidden="true" className="lantern-rail-count">
          {needs.count}
        </span>
      )}
    </button>
  )
}
