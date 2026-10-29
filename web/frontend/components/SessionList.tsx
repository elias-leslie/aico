'use client'

import { clsx } from 'clsx'
import { ChevronRight } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import type { RunMember } from 'tether/teams'
import {
  childAgents,
  foldTeams,
  laneTitle,
  type TeamRow,
  teamMembers,
} from 'tether/teams'
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
import { useStepViewer } from './StepViewer'

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

/** A list entry as a team member (tether/teams): lineage by row id. A row is
 * a session (`entry`) or a running workflow step shown as a child agent (`step`). */
interface TeamEntry {
  id: string
  coordinator: boolean
  coordinatorId: string | null
  group: Attention['group']
  at: number | null
  entry: SessionListEntry | null
  step: RunMember | null
}

/** Fold entries into coordinator teams. A lane names its coordinator by
 * session id; rows are keyed by slot. A workflow step that is running or
 * waiting for the owner folds under the session that launched its run, like
 * any other child agent. */
export function foldSessionEntries(
  entries: readonly SessionListEntry[],
  runs: readonly RunMember[] = [],
): TeamRow<TeamEntry>[] {
  const rowOf = new Map<string, string>()
  for (const entry of entries) {
    const sessionId = getSlotSessionId(entry.slot)
    if (sessionId) rowOf.set(sessionId, entry.id)
  }
  const sessions: TeamEntry[] = entries.map((entry) => {
    const lead = entry.slot.coordinatorId ?? null
    return {
      id: entry.id,
      coordinator: entry.slot.coordinator === true,
      // A coordinator that is not listed here has ended.
      coordinatorId: lead ? (rowOf.get(lead) ?? lead) : null,
      group: entry.state?.group ?? 'no-status',
      at: entry.state?.at ?? null,
      entry,
      step: null,
    }
  })
  const steps: TeamEntry[] = childAgents(runs).map((step) => ({
    id: step.id,
    coordinator: false,
    coordinatorId: rowOf.get(step.coordinatorId) ?? step.coordinatorId,
    group: step.group,
    at: step.at,
    entry: null,
    step,
  }))
  return foldTeams([...sessions, ...steps])
}

/** What a row shows, whether it is a session or a workflow step: the step's
 * tool is its executor's, its state the one Tether reports. */
function rowFacts(item: TeamEntry, attention: SessionAttention | undefined) {
  const { entry, step } = item
  if (entry)
    return {
      label: entry.label,
      mode: entry.mode,
      state: entry.state,
      slot: entry.slot,
    }
  const member = step as RunMember
  return {
    label: member.title,
    mode: member.tool ?? 'agent-hub',
    state: attention?.forStep?.(member) ?? null,
    slot: null,
  }
}

/** The agent's name for a tool slug. */
const toolName = (
  tools: readonly { slug: string; name: string }[],
  mode: string,
): string =>
  tools.find((tool) => tool.slug === mode)?.name ??
  (mode === 'shell' ? 'Shell' : mode)

/** What a row says under its name: its agent and what it is doing. The
 * list no longer groups by state, so the row says it. */
function rowMeta(agent: string, state: Attention | null): string {
  if (state?.group === 'needs-you') return `${agent} is waiting for you`
  if (state?.group === 'finished') return `${agent} finished · not opened yet`
  if (state?.group === 'working' || state?.group === 'idle')
    return `${agent} · ${state.group}`
  return agent
}

/** What clicking a row does: a session opens as the main view (closing any step
 * open there), a running step opens read-only through `onOpenStep` or else the
 * main view's step viewer. */
function useRowOpener(
  onSelect: (slot: TerminalSlot | PaneSlot) => void,
  onOpenStep: ((step: RunMember) => void) | undefined,
) {
  const viewer = useStepViewer()
  return (slot: TerminalSlot | PaneSlot | null, step: RunMember | null) => {
    if (slot) {
      viewer.close()
      onSelect(slot)
    } else if (step) {
      ;(onOpenStep ?? viewer.open)(step)
    }
  }
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
    (id: string) => (phone ? onPhone[id] === true : (remembered[id] ?? true)),
    [phone, onPhone, remembered],
  )
  const toggle = useCallback(
    (id: string) => {
      if (phone) setOnPhone((open) => ({ ...open, [id]: !open[id] }))
      else setRemembered((open) => ({ ...open, [id]: !(open[id] ?? true) }))
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
  /** Open a running workflow step's current attempt, read-only. */
  onOpenStep?: (step: RunMember) => void
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
  onOpenStep,
  phone = false,
}: SessionListProps) {
  const { agentTools } = useAgentTools()
  const open = useRowOpener(onSelect, onOpenStep)
  const runs = attention?.runs
  const teams = useMemo(
    () => foldSessionEntries(sortSessionEntries(slots, attention), runs?.items),
    [slots, attention, runs?.items],
  )
  const folds = useTeamFolds(phone)
  const agentName = (mode: string) => toolName(agentTools, mode)
  // Headings only while something needs you: Needs you, then the rest.
  const waiting = teams.filter((row) => row.group === 'needs-you').length
  const headings = waiting > 0 && waiting < teams.length

  const renderRow = (
    row: TeamRow<TeamEntry>,
    lead: SessionListEntry | null,
  ): React.ReactNode => {
    const { id } = row.item
    const { label, mode, state, slot } = rowFacts(row.item, attention)
    const isTeam = row.children.length > 0
    const sessionKey = slot ? (getSlotSessionId(slot) ?? id) : id
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
        ? teamMembers(row).flatMap(
            (member) => member.entry?.slot.checkIns ?? [],
          )
        : slot?.checkIns
    const meta = [
      // A team row: the coordinator's own state, then its team summary.
      isTeam
        ? `${rowMeta(agentName(mode), state)} · ${row.summary}`
        : rowMeta(agentName(mode), state),
      row.orphaned ? 'coordinator ended' : null,
    ]
      .filter(Boolean)
      .join(' · ')
    return (
      <div key={id} className={clsx(isTeam && 'lantern-team')}>
        <button
          type="button"
          onClick={() => open(slot, row.item.step)}
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
            {!(lead && slot?.badge?.label.startsWith('↳')) && (
              <CoordinatorBadge badge={slot?.badge} ownLine />
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
      {runs?.notice && (
        <p role="status" className="lantern-run-notice">
          {runs.notice}
        </p>
      )}
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

/** The collapsed list: one agent mark per row, in the list's order and with
 * its teams folded, so the rail never disagrees with the list. A row holding
 * the session on screen is marked current, even when that session is a lane. */
export function SessionRail({
  slots,
  currentId,
  attention,
  onSelect,
  onOpenStep,
}: Omit<SessionListProps, 'phone'>) {
  const { agentTools } = useAgentTools()
  const open = useRowOpener(onSelect, onOpenStep)
  const runs = attention?.runs
  const teams = useMemo(
    () => foldSessionEntries(sortSessionEntries(slots, attention), runs?.items),
    [slots, attention, runs?.items],
  )
  return (
    <>
      {teams.map((row) => {
        const { id } = row.item
        const { label, mode, state, slot } = rowFacts(row.item, attention)
        const tool = agentTools.find((t) => t.slug === mode)
        const agent = toolName(agentTools, mode)
        const needs = row.group === 'needs-you'
        const current = teamMembers(row).some((m) => m.id === currentId)
        const name = [label, rowMeta(agent, state), row.summary]
          .filter(Boolean)
          .join(' · ')
        return (
          <button
            key={id}
            type="button"
            onClick={() => open(slot, row.item.step)}
            aria-current={current ? 'true' : undefined}
            aria-label={name}
            title={name}
            className={clsx('lantern-rail-item', needs && 'needs')}
          >
            <AgentIcon
              slug={mode}
              size={18}
              color={getAgentColor(mode, tool?.color)}
            />
            {(needs || state?.group === 'finished') && (
              <span
                aria-hidden="true"
                className="dot"
                style={{
                  backgroundColor: needs ? 'var(--beacon)' : 'var(--jade)',
                }}
              />
            )}
          </button>
        )
      })}
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
