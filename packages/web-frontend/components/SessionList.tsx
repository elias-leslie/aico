'use client'

import {
  foldTeams,
  laneTitle,
  type TeamRow,
  teamMembers,
} from '@aico/tether-client/teams'
import { clsx } from 'clsx'
import { ChevronRight } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import type { Attention } from '@/lib/attention'
import { CHAT_STATE } from '@/lib/chat'
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
import { HostBadge } from './HostBadge'
import { KeptCheckIns } from './KeptCheckIns'

/** The agent a session runs (its tool slug), or `shell`. */
export function slotMode(slot: TerminalSlot | PaneSlot): string {
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
function sortSessionEntries(
  slots: Array<TerminalSlot | PaneSlot>,
  attention?: SessionAttention,
): SessionListEntry[] {
  const key = (slot: TerminalSlot | PaneSlot) =>
    `${getSlotName(slot)} [${slotMode(slot)}]`
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
      mode: slotMode(slot),
      slot,
      state: attention?.forSlot(slot) ?? null,
    }
  })
}

/** A list entry as a team member (@aico/tether-client/teams): lineage by row id. A row is
 * a session (`entry`) or a running workflow step shown as a child agent (`step`). */
interface TeamEntry {
  id: string
  coordinator: boolean
  coordinatorId: string | null
  parentId: string | null
  group: Attention['group']
  at: number | null
  entry: SessionListEntry
}

/** Fold entries into coordinator teams. A lane names its coordinator and
 * the session that launched it by session id, and nests under that session
 * while it is listed; rows are keyed by slot. A workflow step that is running
 * or waiting for the owner folds under the session that launched its run,
 * like any other child agent. */
function foldSessionEntries(
  entries: readonly SessionListEntry[],
): TeamRow<TeamEntry>[] {
  const rowOf = new Map<string, string>()
  for (const entry of entries) {
    const sessionId = getSlotSessionId(entry.slot)
    if (sessionId) rowOf.set(sessionId, entry.id)
  }
  const sessions: TeamEntry[] = entries.map((entry) => {
    const lead = entry.slot.coordinatorId ?? null
    const parent = entry.slot.parentId ?? null
    return {
      id: entry.id,
      coordinator: entry.slot.coordinator === true,
      // A coordinator that is not listed here has ended.
      coordinatorId: lead ? (rowOf.get(lead) ?? lead) : null,
      // An unlisted launcher leaves the lane under its coordinator.
      parentId: parent ? (rowOf.get(parent) ?? null) : null,
      group: entry.state?.group ?? 'no-status',
      at: entry.state?.at ?? null,
      entry,
    }
  })
  const teams = foldTeams(sessions)
  if (!entries.some((entry) => entry.slot.chat)) return teams
  const order = {
    'needs-you': 0,
    working: 1,
    idle: 2,
    'no-status': 2,
    finished: 3,
  }
  return teams.sort(
    (a, b) =>
      order[a.group] - order[b.group] || (b.item.at ?? 0) - (a.item.at ?? 0),
  )
}

function rowFacts(item: TeamEntry) {
  return {
    label: item.entry.label,
    mode: item.entry.mode,
    state: item.entry.state,
    slot: item.entry.slot,
  }
}

/** The agent's name for a tool slug. */
export const toolName = (
  tools: readonly { slug: string; name: string }[],
  mode: string,
): string =>
  tools.find((tool) => tool.slug === mode)?.name ??
  (mode === 'shell' ? 'Shell' : mode)

/** A session as its list row names it: its name, numbered when another
 * session of the same agent has the same name. The header, the list and the
 * End dialog all say this. */
export function sessionLabel(
  slots: Array<TerminalSlot | PaneSlot>,
  slot: TerminalSlot | PaneSlot,
): string {
  const id = getSlotPanelId(slot)
  return (
    sortSessionEntries(slots).find((entry) => entry.id === id)?.label ??
    getSlotName(slot)
  )
}

/** A session as its list row names it, with its agent and where it runs, so
 * one of several same-named sessions can be told apart:
 * `“Fix login #3” (Pi on agent-work)`. */
export function sessionWhoWhere(
  slots: Array<TerminalSlot | PaneSlot>,
  slot: TerminalSlot | PaneSlot,
  tools: readonly { slug: string; name: string }[],
): string {
  const label = sessionLabel(slots, slot)
  return `“${label}” (${toolName(tools, slotMode(slot))} on ${slot.host ?? 'this computer'})`
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
  const agentName = (mode: string) => toolName(agentTools, mode)
  // Headings only while something needs you: Needs you, then the rest.
  const hasChats = slots.some((slot) => slot.chat)
  const waiting = teams.filter((row) => row.group === 'needs-you').length
  const headings = hasChats || (waiting > 0 && waiting < teams.length)

  const renderRow = (
    row: TeamRow<TeamEntry>,
    lead: SessionListEntry | null,
  ): React.ReactNode => {
    const { id } = row.item
    const { label, mode, state, slot } = rowFacts(row.item)
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
    const chat = slot?.chatSummary
    const meta = chat
      ? `${chat.role} · ${chat.model ?? '—'} · ${CHAT_STATE[chat.state] ?? chat.state} · ${chat.cwd.split('/').pop()}`
      : [
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
          <span className="name" title={chat?.last}>
            {name}
          </span>
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
            <HostBadge host={slot?.host} state={slot?.hostState} />
            <span className="truncate" style={{ flexShrink: 100 }}>
              {meta}
            </span>
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
            // A lane's own helpers nest a step further, kept narrow for phone width.
            style={lead ? { marginLeft: 10 } : undefined}
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
        const labels = {
          'needs-you': 'Needs you',
          working: 'Working',
          idle: 'Idle',
          finished: 'Finished',
          'no-status': 'Idle',
        }
        const header = hasChats
          ? index === 0 || teams[index - 1]?.group !== row.group
            ? labels[row.group]
            : null
          : !headings
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
                  {hasChats
                    ? teams.filter((item) => item.group === row.group).length
                    : index === 0
                      ? waiting
                      : teams.length - waiting}
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
  const teams = useMemo(
    () => foldSessionEntries(sortSessionEntries(slots, attention)),
    [slots, attention],
  )
  return (
    <>
      {teams.map((row) => {
        const { id } = row.item
        const { label, mode, state, slot } = rowFacts(row.item)
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
