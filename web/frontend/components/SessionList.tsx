'use client'

import { clsx } from 'clsx'
import { ChevronRight, Workflow } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import type { RunMember } from 'tether/teams'
import { foldTeams, laneTitle, type TeamRow, teamMembers } from 'tether/teams'
import type { Attention } from '@/lib/attention'
import { useAgentTools } from '@/lib/hooks/use-agent-tools'
import { useLocalStorageState } from '@/lib/hooks/use-local-storage-state'
import type { SessionAttention } from '@/lib/hooks/use-session-attention'
import type { RunAct } from '@/lib/hooks/use-workflow-runs'
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
import { pageUrl, RunRow, runMeta, StepRow } from './RunRow'

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
 * a session (`entry`) or a workflow run or step (`run`). */
interface TeamEntry {
  id: string
  coordinator: boolean
  coordinatorId: string | null
  group: Attention['group']
  at: number | null
  kind?: RunMember['kind']
  summary?: string | null
  entry: SessionListEntry | null
  run: RunMember | null
}

/** Fold entries into coordinator teams. A lane names its coordinator by
 * session id; rows are keyed by slot. A workflow run folds under the session
 * that launched it, and its steps under the run. */
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
      run: null,
    }
  })
  const members: TeamEntry[] = runs.map((run) => ({
    id: run.id,
    coordinator: false,
    // A run names its launcher by session id; a step names its run.
    coordinatorId:
      run.kind === 'run'
        ? (rowOf.get(run.coordinatorId ?? '') ?? run.coordinatorId)
        : run.coordinatorId,
    group: run.group,
    at: run.at,
    kind: run.kind,
    summary: run.summary,
    entry: null,
    run,
  }))
  return foldTeams([...sessions, ...members])
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

/** Without the runs list there are no run rows to act on. */
const noRunControls = (_action: RunAct): Promise<void> =>
  Promise.reject(new Error('Workflow runs are not available'))

const TEAMS_OPEN_KEY = 'aico:teams-open'

/** Which teams show their lanes. A desktop remembers each coordinator in
 * this browser (open by default); a phone starts every team folded. */
function useTeamFolds(phone: boolean) {
  const [remembered, setRemembered] = useLocalStorageState<
    Record<string, boolean>
  >(TEAMS_OPEN_KEY, {})
  const [onPhone, setOnPhone] = useState<Record<string, boolean>>({})
  // `fallback`: whether a team the owner has not folded or opened shows its
  // lanes (sessions and going runs do; ended runs start folded).
  const isOpen = useCallback(
    (id: string, fallback = true) =>
      phone ? onPhone[id] === true : (remembered[id] ?? fallback),
    [phone, onPhone, remembered],
  )
  const toggle = useCallback(
    (id: string, fallback = true) => {
      if (phone) setOnPhone((open) => ({ ...open, [id]: !open[id] }))
      else setRemembered((open) => ({ ...open, [id]: !(open[id] ?? fallback) }))
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
  const runs = attention?.runs
  const teams = useMemo(
    () => foldSessionEntries(sortSessionEntries(slots, attention), runs?.items),
    [slots, attention, runs?.items],
  )
  const folds = useTeamFolds(phone)
  const agentName = (mode: string) =>
    agentTools.find((tool) => tool.slug === mode)?.name ??
    (mode === 'shell' ? 'Shell' : mode)
  // Headings only while something needs you: Needs you, then the rest.
  const waiting = teams.filter((row) => row.group === 'needs-you').length
  const headings = waiting > 0 && waiting < teams.length

  const renderRun = (
    row: TeamRow<TeamEntry>,
    member: RunMember,
  ): React.ReactNode => {
    // A run is one line; its steps show when the owner opens it.
    const open = row.children.length > 0 && folds.isOpen(member.id, false)
    const act = runs?.act ?? noRunControls
    return (
      <RunRow
        key={member.id}
        member={member}
        open={open}
        onToggle={() => folds.toggle(member.id, false)}
        orphaned={row.orphaned}
        act={act}
        needs={member.group === 'needs-you' || row.group === 'needs-you'}
      >
        {row.children.map((child) => (
          <StepRow
            key={child.item.id}
            member={child.item.run as RunMember}
            orphaned={row.orphaned}
            act={act}
          />
        ))}
      </RunRow>
    )
  }

  const renderRow = (
    row: TeamRow<TeamEntry>,
    lead: SessionListEntry | null,
  ): React.ReactNode => {
    if (!row.item.entry) return renderRun(row, row.item.run as RunMember)
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
        ? teamMembers(row).flatMap(
            (member) => member.entry?.slot.checkIns ?? [],
          )
        : slot.checkIns
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
}: Omit<SessionListProps, 'phone'>) {
  const { agentTools } = useAgentTools()
  const runs = attention?.runs
  const teams = useMemo(
    () => foldSessionEntries(sortSessionEntries(slots, attention), runs?.items),
    [slots, attention, runs?.items],
  )
  return (
    <>
      {teams.map((row) => {
        if (!row.item.entry) {
          // A run whose session has ended: its page is all there is to open.
          const run = row.item.run as RunMember
          const url = pageUrl(run.url)
          const needs = row.group === 'needs-you'
          const name = `Workflow run ${run.title}: ${runMeta(run)}`
          return (
            <a
              key={run.id}
              href={url ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${name}. Opens in Agent Hub`}
              title={name}
              className={clsx('lantern-rail-item', needs && 'needs')}
            >
              <Workflow
                aria-hidden="true"
                className="h-[18px] w-[18px]"
                strokeWidth={1.7}
                style={{ color: 'var(--mist)' }}
              />
              {needs && (
                <span
                  aria-hidden="true"
                  className="dot"
                  style={{ backgroundColor: 'var(--beacon)' }}
                />
              )}
            </a>
          )
        }
        const { id, label, mode, slot, state } = row.item.entry
        const tool = agentTools.find((t) => t.slug === mode)
        const agent = tool?.name ?? (mode === 'shell' ? 'Shell' : mode)
        const needs = row.group === 'needs-you'
        const current = teamMembers(row).some((m) => m.id === currentId)
        const name = [label, rowMeta(agent, state), row.summary]
          .filter(Boolean)
          .join(' · ')
        return (
          <button
            key={id}
            type="button"
            onClick={() => onSelect(slot)}
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
