'use client'

import {
  Activity,
  ChevronRight,
  Database,
  Folder,
  Gauge,
  Plus,
  StickyNote,
} from 'lucide-react'
import type { ComponentType } from 'react'
import { quotaGlances, quotaLine } from '@/lib/frame/quota'
import { useSessionAttention } from '@/lib/hooks/use-session-attention'
import { useStatus } from '@/lib/hooks/use-status'
import { popOutNotes } from '@/lib/notes-window'
import { plural } from '@/lib/status'
import type { PaneSlot, TerminalSlot } from '@/lib/utils/slot'
import { NeedsYouLauncher } from '../asks/NeedsYou'
import { CaptureLauncher } from '../capture/CaptureLauncher'
import { SessionRail, sessionsHeading } from '../SessionList'
import { useFrame } from './FrameContext'

type Icon = ComponentType<{ className?: string; strokeWidth?: number }>

function RailButton({
  icon: Glyph,
  label,
  count,
  onClick,
}: {
  icon: Icon
  label: string
  count?: number
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className="lantern-icon-btn compact relative"
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      <Glyph className="h-[18px] w-[18px]" strokeWidth={1.7} />
      {count ? (
        <span aria-hidden="true" className="lantern-rail-count">
          {count}
        </span>
      ) : null}
    </button>
  )
}

const Divider = () => (
  <span
    aria-hidden="true"
    className="my-1 h-px w-6 flex-none"
    style={{ background: 'var(--paper-veil)' }}
  />
)

/** The rail: icons and counts. New session, Needs you, one mark per session
 * with its state, then Status, Quota, Projects, Backups, Notes. */
export function Rail({
  slots,
  currentId,
  onSelect,
  onOpenPanel,
  onNewSession,
}: {
  slots: Array<TerminalSlot | PaneSlot>
  currentId?: string
  onSelect: (slot: TerminalSlot | PaneSlot) => void
  onOpenPanel?: () => void
  onNewSession?: () => void
}) {
  const frame = useFrame()
  const attention = useSessionAttention()
  const { view } = useStatus()
  const problems = view?.summary.problems
  const glances = quotaGlances(view?.rows ?? [])
  const heading = sessionsHeading(slots.length, attention.needsYouCount)
  return (
    <div
      data-testid="session-sidebar"
      data-collapsed="true"
      className="flex min-h-0 flex-1 flex-col items-center gap-0.5 py-1.5"
    >
      {onNewSession && (
        <button
          type="button"
          className="lantern-icon-btn compact"
          onClick={onNewSession}
          aria-label="New session"
          title="New session"
          data-testid="new-session-btn"
        >
          <Plus className="h-[18px] w-[18px]" strokeWidth={1.7} />
        </button>
      )}
      {onOpenPanel && (
        <button
          type="button"
          className="lantern-icon-btn compact"
          onClick={onOpenPanel}
          aria-label={`Open the panel · ${heading} · Alt+2`}
          title={`Open the panel · ${heading} · Alt+2`}
        >
          <ChevronRight className="h-[18px] w-[18px]" strokeWidth={1.7} />
        </button>
      )}
      <NeedsYouLauncher variant="icon" />
      <Divider />
      <nav
        aria-label="Sessions"
        data-testid="session-list"
        className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto overscroll-contain py-1"
      >
        <SessionRail
          slots={slots}
          currentId={currentId}
          attention={attention}
          onSelect={onSelect}
        />
      </nav>
      <Divider />
      <RailButton
        icon={Activity}
        label={
          problems === undefined
            ? 'Status'
            : problems
              ? `Status: ${plural(problems, 'problem')}`
              : 'Status: all healthy'
        }
        count={problems}
        onClick={() => frame?.open('/status', 'wide')}
      />
      <RailButton
        icon={Gauge}
        label={glances.length ? `Quota: ${quotaLine(glances)}` : 'Quota'}
        onClick={() => frame?.open('/status?q=usage', 'wide')}
      />
      <RailButton
        icon={Folder}
        label="Projects"
        onClick={() => frame?.open('/projects', 'wide')}
      />
      <RailButton
        icon={Database}
        label="Backups"
        onClick={() => frame?.open('/backups', 'full')}
      />
      <RailButton
        icon={StickyNote}
        label="Notes: opens in its own window"
        onClick={() => {
          if (!popOutNotes('/notes')) window.location.assign('/notes')
        }}
      />
      <CaptureLauncher variant="icon" />
    </div>
  )
}
