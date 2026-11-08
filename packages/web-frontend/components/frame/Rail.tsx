'use client'

import { Folder, Plus, Server } from 'lucide-react'
import type { PaneSlot, TerminalSlot } from '@/lib/utils/slot'
import { NeedsYouLauncher } from '../asks/NeedsYou'
import { useFrame } from './FrameContext'
import { GlancePopover } from './glance/GlancePopover'
import { ProjectsSection, useProjectTree } from './ProjectsSection'
import { QuotaMeter } from './QuotaMeter'
import { RailPopover } from './RailPopover'
import { SettingsMenu } from './Settings'
import { SystemSection, useSystemState } from './SystemSection'

const Divider = () => (
  <span
    aria-hidden="true"
    className="my-1 h-px w-6 flex-none"
    style={{ background: 'var(--paper-veil)' }}
  />
)

const DOT: Record<string, string> = {
  ok: 'var(--jade)',
  warn: 'var(--lantern)',
  failed: 'var(--ember)',
  pending: 'var(--mist)',
}

/** The rail: one icon for each section of the Panel. Needs you carries its count, System the dot of its
 * worst state, Projects what is running; each pops out beside the rail with the same content the
 * Panel shows, without widening it. New session sits above; the Quota meter and Settings below. The
 * side's one toggle sits above, in the head. */
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
  const system = useSystemState()
  const { tree } = useProjectTree(slots)
  const sessions = tree.groups.reduce(
    (total, group) => total + group.teams.length,
    0,
  )
  const systemLabel = system.chips.length
    ? `System: ${system.chips.map((chip) => chip.text).join(', ')}`
    : system.pending
      ? 'System: checking'
      : `System: all OK${system.machines ? `, ${system.machines}` : ''}`
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
      <Divider />
      <NeedsYouLauncher
        slots={slots}
        currentId={currentId}
        onSelect={onSelect}
      />
      <RailPopover
        label={systemLabel}
        panelLabel="System"
        className="lantern-icon-btn compact relative"
        extra={{ 'data-testid': 'rail-system', 'data-worst': system.worst }}
        icon={
          <>
            <Server className="h-[18px] w-[18px]" strokeWidth={1.7} />
            <span
              aria-hidden="true"
              className="lantern-mark"
              style={{
                position: 'absolute',
                top: 6,
                right: 6,
                background: DOT[system.worst],
              }}
            />
          </>
        }
      >
        <SystemSection popout />
      </RailPopover>
      <RailPopover
        label={
          sessions
            ? `Projects: ${sessions} ${sessions === 1 ? 'session' : 'sessions'} in ${tree.groups.length} ${tree.groups.length === 1 ? 'project' : 'projects'}`
            : 'Projects'
        }
        panelLabel="Projects"
        className="lantern-icon-btn compact relative"
        extra={{ 'data-testid': 'rail-projects' }}
        icon={
          <>
            <Folder className="h-[18px] w-[18px]" strokeWidth={1.7} />
            {sessions > 0 && (
              <span
                aria-hidden="true"
                className="lantern-rail-count"
                data-calm=""
              >
                {sessions}
              </span>
            )}
          </>
        }
      >
        <GlancePopover
          title="Projects"
          head={{
            value: tree.groups.length
              ? `${tree.groups.length} with sessions`
              : 'No sessions',
            tone: null,
          }}
        >
          <ProjectsSection
            slots={slots}
            currentId={currentId}
            onSelect={onSelect}
            bare
          />
        </GlancePopover>
      </RailPopover>
      <span className="flex-1" />
      <Divider />
      <QuotaMeter icon />
      <SettingsMenu frame={frame} icon />
    </div>
  )
}
