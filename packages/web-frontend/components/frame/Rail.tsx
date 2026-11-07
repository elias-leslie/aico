'use client'

import {
  Activity,
  Clock,
  Database,
  Folder,
  Gauge,
  Plus,
  Server,
  StickyNote,
} from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'
import { quotaGlances, quotaLine } from '@/lib/frame/quota'
import { useSessionAttention } from '@/lib/hooks/use-session-attention'
import { useUsage } from '@/lib/hooks/use-usage'
import { openNotes } from '@/lib/notes-window'
import { plural } from '@/lib/status'
import type { PaneSlot, TerminalSlot } from '@/lib/utils/slot'
import { NeedsYouLauncher } from '../asks/NeedsYou'
import { CaptureLauncher } from '../capture/CaptureLauncher'
import { SessionRail } from '../SessionList'
import { useFrame } from './FrameContext'
import { GlanceBackups, useBackupsGlance } from './glance/GlanceBackups'
import { GlanceMachines, useMachinesGlance } from './glance/GlanceMachines'
import { GlancePopover } from './glance/GlancePopover'
import { GlanceProjects, useProjectsGlance } from './glance/GlanceProjects'
import { GlanceQuota, useQuotaGlance } from './glance/GlanceQuota'
import { GlanceRecent, useRecentGlance } from './glance/GlanceRecent'
import { GlanceStatus, useStatusGlance } from './glance/GlanceStatus'
import type { GlanceHead } from './glance/glance-types'
import { RailPopover } from './RailPopover'
import { SettingsMenu } from './Settings'

type Icon = ComponentType<{ className?: string; strokeWidth?: number }>

function RailButton({
  icon: Glyph,
  label,
  onClick,
}: {
  icon: Icon
  label: string
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
    </button>
  )
}

/** A data icon: its tooltip is the one line, a click opens the same glance the Panel's section holds. */
function GlanceButton({
  icon: Glyph,
  label,
  title,
  count,
  head,
  children,
}: {
  icon: Icon
  label: string
  title: string
  count?: number | null
  head: GlanceHead
  children: ReactNode
}) {
  return (
    <RailPopover
      label={label}
      panelLabel={title}
      className="lantern-icon-btn compact relative"
      icon={
        <>
          <Glyph className="h-[18px] w-[18px]" strokeWidth={1.7} />
          {count ? (
            <span aria-hidden="true" className="lantern-rail-count">
              {count}
            </span>
          ) : null}
        </>
      }
    >
      <GlancePopover title={title} head={head}>
        {children}
      </GlancePopover>
    </RailPopover>
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
 * with its state (a coordinator's opens its team), then Status, Quota, Projects,
 * Backups, Machines and Recent (each opens its glance beside the rail without
 * widening it), and at the bottom Notes, Capture and Settings. The side's one toggle
 * sits above, in the head. */
export function Rail({
  slots,
  currentId,
  onSelect,
  onNewSession,
}: {
  slots: Array<TerminalSlot | PaneSlot>
  currentId?: string
  onSelect: (slot: TerminalSlot | PaneSlot) => void
  onNewSession?: () => void
}) {
  const frame = useFrame()
  const attention = useSessionAttention()
  const status = useStatusGlance()
  const problems = status.problems
  const { report } = useUsage()
  const glances = quotaGlances(report)
  const quota = useQuotaGlance()
  const backups = useBackupsGlance()
  const recent = useRecentGlance()
  const machines = useMachinesGlance()
  const projects = useProjectsGlance()
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
      <NeedsYouLauncher />
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
      <GlanceButton
        icon={Activity}
        title="Status"
        label={
          problems === null
            ? 'Status'
            : problems
              ? `Status: ${plural(problems, 'problem')}`
              : 'Status: all healthy'
        }
        count={problems}
        head={status}
      >
        <GlanceStatus />
      </GlanceButton>
      <GlanceButton
        icon={Gauge}
        title="Quota"
        label={glances.length ? `Quota: ${quotaLine(glances)}` : 'Quota'}
        head={quota}
      >
        <GlanceQuota />
      </GlanceButton>
      <GlanceButton
        icon={Folder}
        title="Projects"
        label="Projects"
        head={projects}
      >
        <GlanceProjects />
      </GlanceButton>
      <GlanceButton
        icon={Database}
        title="Backups"
        label="Backups"
        head={backups}
      >
        <GlanceBackups />
      </GlanceButton>
      <GlanceButton
        icon={Server}
        title="Machines"
        label="Machines"
        head={machines}
      >
        <GlanceMachines />
      </GlanceButton>
      <GlanceButton icon={Clock} title="Recent" label="Recent" head={recent}>
        <GlanceRecent />
      </GlanceButton>
      <Divider />
      <RailButton
        icon={StickyNote}
        label="Notes: opens in its own window"
        onClick={() => openNotes()}
      />
      <CaptureLauncher variant="icon" />
      <SettingsMenu frame={frame} icon />
    </div>
  )
}
