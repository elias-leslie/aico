'use client'

import { clsx } from 'clsx'
import { ChevronRight } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { foldTeams, laneTitle, type TeamRow, teamMembers } from 'tether/teams'
import type { Attention } from '@/lib/attention'
import { useAgentTools } from '@/lib/hooks/use-agent-tools'
import { useLocalStorageState } from '@/lib/hooks/use-local-storage-state'
import type { SessionAttention } from '@/lib/hooks/use-session-attention'
import {
  getSlotName,
  getSlotPanelId,
  getSlotSessionId,
  type PaneSlot,
  type TerminalSlot,
} from '@/lib/utils/slot'
import { AgentIcon, getAgentColor } from './AgentIcon'
import { CheckInBadge } from './CheckInBadge'
import { CoordinatorBadge } from './CoordinatorBadge'
import { KeptCheckIns } from './KeptCheckIns'

function getSlotMode(slot: TerminalSlot | PaneSlot): string {
  if (slot.type === 'project') {
    return slot.activeMode
  }
  return slot.sessionMode ?? 'shell'
}

interface SessionListEntry {
  id: string
  label: string
  mode: string
  slot: TerminalSlot | PaneSlot
  state: Attention | null
}

/** Sessions oldest first, so a state change never moves one (foldSessionEntries
 * lifts Needs you to the top); the same name with the same agent is numbered. */
export function sortSessionEntries(
  slots: Array<TerminalSlot | PaneSlot>,
  attention?: SessionAttention,
): SessionListEntry[] {
  const key = (slot: TerminalSlot | PaneSlot) =>
    `${getSlotName(slot)} [${getSlotMode(slot)}]`
  // No start time sorts last.
  const created = (slot: TerminalSlot | PaneSlot) => slot.createdAt || '\uffff'
  const sorted = [...slots].sort(
    (slotA, slotB) =>
      created(slotA).localeCompare(created(slotB)) ||
      getSlotPanelId(slotA).localeCompare(getSlotPanelId(slotB)),
  )
  const seenCounts = new Map<string, number>()
  return sorted.map((slot) => {
    const count = (seenCounts.get(key(slot)) ?? 0) + 1
    seenCounts.set(key(slot), count)
    const name = getSlotName(slot)
    return {
      id: getSlotPanelId(slot),
      label: count > 1 ? `${name} #${count}` : name,
      mode: getSlotMode(slot),
      slot,
      state: attention?.forSlot(slot) ?? null,
    }
  })
}

/** A list entry as a team member (tether/teams): lineage by row id. */
interface TeamEntry {
  id: string
  coordinator: boolean
  coordinatorId: string | null
  group: Attention['group']
  at: number | null
  entry: SessionListEntry
}

/** Fold entries into coordinator teams. A lane names its coordinator by
 * session id; rows are keyed by slot. */
export function foldSessionEntries(
  entries: readonly SessionListEntry[],
): TeamRow<TeamEntry>[] {
  const rowOf = new Map<string, string>()
  for (const entry of entries) {
    const sessionId = getSlotSessionId(entry.slot)
    if (sessionId) rowOf.set(sessionId, entry.id)
  }
  return foldTeams(
    entries.map((entry) => {
      const lead = entry.slot.coordinatorId ?? null
      return {
        id: entry.id,
        coordinator: entry.slot.coordinator === true,
        // A coordinator that is not listed here has ended.
        coordinatorId: lead ? (rowOf.get(lead) ?? lead) : null,
        group: entry.state?.group ?? 'no-status',
        at: entry.state?.at ?? null,
        entry,
      }
    }),
  )
}

/** What a row says under its name: its agent and what it is doing. The
 * list no longer groups by state, so the row says it. */
function rowMeta(agent: string, state: Attention | null): string {
  if (state?.group === 'needs-you') return `${agent} is waiting for you`
  if (state?.group === 'finished') return `${agent} finished · not opened yet`
  if (state?.group === 'working' || state?.group === 'idle')
    return `${agent} · ${state.group}`
  return agent
}

const TEAMS_OPEN_KEY = 'aico:teams-open'

/** Which teams show their lanes. A desktop remembers each coordinator in
 * this browser (open by default); a phone starts every team folded. */
function useTeamFolds(phone: boolean) {
  const [remembered, setRemembered] = useLocalStorageState<
    Record<string, boolean>
  >(TEAMS_OPEN_KEY, {})
  const [onPhone, setOnPhone] = useState<Record<string, boolean>>({})
  const isOpen = useCallback(
    (id: string) => (phone ? onPhone[id] === true : remembered[id] !== false),
    [phone, onPhone, remembered],
  )
  const toggle = useCallback(
    (id: string) => {
      if (phone) setOnPhone((open) => ({ ...open, [id]: !open[id] }))
      else setRemembered((open) => ({ ...open, [id]: open[id] === false }))
    },
    [phone, setRemembered],
  )
  return { isOpen, toggle }
}

interface SessionListProps {
  slots: Array<TerminalSlot | PaneSlot>
  currentId?: string
  attention?: SessionAttention
  onSelect: (slot: TerminalSlot | PaneSlot) => void
  /** Phone: teams start folded and are not remembered. */
  phone?: boolean
}

/** Every session oldest first, with Needs you on top, and each coordinator's
 * lanes folded under it. */
export function SessionList({
  slots,
  currentId,
  attention,
  onSelect,
  phone = false,
}: SessionListProps) {
  const { agentTools } = useAgentTools()
  const teams = useMemo(
    () => foldSessionEntries(sortSessionEntries(slots, attention)),
    [slots, attention],
  )
  const folds = useTeamFolds(phone)
  const agentName = (mode: string) =>
    agentTools.find((tool) => tool.slug === mode)?.name ??
    (mode === 'shell' ? 'Shell' : mode)
  // Headings only while something needs you: Needs you, then the rest.
  const waiting = teams.filter((row) => row.group === 'needs-you').length
  const headings = waiting > 0 && waiting < teams.length

  const renderRow = (
    row: TeamRow<TeamEntry>,
    lead: SessionListEntry | null,
  ): React.ReactNode => {
    const { id, label, mode, slot, state } = row.item.entry
    const isTeam = row.children.length > 0
    const sessionKey = getSlotSessionId(slot) ?? id
    const teamOpen = isTeam && folds.isOpen(sessionKey)
    const tool = agentTools.find((t) => t.slug === mode)
    const group = state?.group
    // A folded team waiting on a lane is highlighted; open, the lane is.
    const needs =
      group === 'needs-you' ||
      (isTeam && !teamOpen && row.group === 'needs-you')
    const name = lead ? laneTitle(label, lead.label) : label
    const checkIns =
      isTeam && !teamOpen
        ? teamMembers(row).flatMap((member) => member.entry.slot.checkIns ?? [])
        : slot.checkIns
    const meta = [
      // A team row leads with its summary (the icon names the agent), after
      // the coordinator's own wait or finish.
      isTeam
        ? group === 'needs-you' || group === 'finished'
          ? `${rowMeta(agentName(mode), state)} · ${row.summary}`
          : row.summary
        : rowMeta(agentName(mode), state),
      row.orphaned ? 'coordinator ended' : null,
    ]
      .filter(Boolean)
      .join(' · ')
    return (
      <div key={id} className={clsx(isTeam && 'lantern-team')}>
        <button
          type="button"
          onClick={() => onSelect(slot)}
          aria-current={id === currentId ? 'true' : undefined}
          className={clsx('lantern-row', needs && 'needs', isTeam && 'lead')}
        >
          <AgentIcon
            slug={mode}
            size={16}
            color={getAgentColor(mode, tool?.color)}
          />
          <span className="name">{name}</span>
          <span className="when">{state?.age ?? ''}</span>
          <span className="meta">
            {(needs || group === 'finished') && (
              <span
                aria-hidden="true"
                className="h-[7px] w-[7px] flex-none rounded-full"
                style={{
                  backgroundColor: needs ? 'var(--beacon)' : 'var(--jade)',
                }}
              />
            )}
            {/* A lane under its coordinator needs no "↳ coordinator" chip. */}
            {!(lead && slot.badge?.label.startsWith('↳')) && (
              <CoordinatorBadge badge={slot.badge} ownLine />
            )}
            <span className="truncate">{meta}</span>
            <CheckInBadge checkIns={checkIns} />
          </span>
        </button>
        {isTeam && (
          <button
            type="button"
            className="lantern-fold"
            aria-expanded={teamOpen}
            aria-label={`${teamOpen ? 'Hide' : 'Show'} ${name} team`}
            title={teamOpen ? 'Hide team' : 'Show team'}
            onClick={() => folds.toggle(sessionKey)}
          >
            <ChevronRight
              aria-hidden="true"
              className="h-4 w-4"
              strokeWidth={1.7}
            />
          </button>
        )}
        {teamOpen && (
          <div
            role="group"
            aria-label={`${name} team`}
            className="lantern-lanes"
          >
            {row.children.map((child) => renderRow(child, row.item.entry))}
          </div>
        )}
      </div>
    )
  }

  return (
    <>
      {teams.map((row, index) => {
        const header = !headings
          ? null
          : index === 0
            ? 'Needs you'
            : index === waiting
              ? 'Other sessions'
              : null
        return (
          <div key={row.item.id}>
            {header && (
              <h3
                data-testid="session-group-header"
                className="lantern-sec mx-2.5 mt-3.5 mb-1.5"
              >
                {header}
                <span className="n">
                  {index === 0 ? waiting : teams.length - waiting}
                </span>
              </h3>
            )}
            {renderRow(row, null)}
          </div>
        )
      })}
      <KeptCheckIns />
    </>
  )
}

/** The list's heading: `Sessions · 5`, and `· 1 needs you` when anything waits. */
export function sessionsHeading(count: number, needsYou: number): string {
  return [
    'Sessions',
    String(count),
    needsYou > 0 ? `${needsYou} need${needsYou === 1 ? 's' : ''} you` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}
