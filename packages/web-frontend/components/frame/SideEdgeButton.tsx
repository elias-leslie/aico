'use client'

import { Menu } from 'lucide-react'
import { useNeedsYouCounts } from '@/lib/hooks/use-needs-you'
import { type Frame, useFrame } from './FrameContext'

/** Whether the side is out of sight, so the session's own bar carries the way
 * back to it: only on a phone, where it slides away. On a desktop the side is
 * always there, as the panel or the rail, with its own toggle. */
export function sideIsAway(frame: Frame | null): frame is Frame {
  return !!frame && !frame.docked
}

/** The left edge of the session's bar while the side is slid away: the menu on
 * a phone. Needs you waiting shows as an amber count on it, only above 0; an
 * unread count says nothing. */
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
  const label = 'Sessions and everything else'
  const name = needs.count > 0 ? `${label} · ${needs.count} need you` : label
  return (
    <button
      type="button"
      className="lantern-icon-btn compact relative flex-none"
      aria-label={name}
      title={name}
      onClick={() => frame.setSheetOpen(true)}
      data-testid="frame-menu"
    >
      <Menu className="h-5 w-5" strokeWidth={1.7} />
      {needs.count > 0 && (
        <span aria-hidden="true" className="lantern-rail-count">
          {needs.count}
        </span>
      )}
    </button>
  )
}
