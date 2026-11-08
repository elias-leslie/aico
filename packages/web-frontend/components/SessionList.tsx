'use client'

import { clsx } from 'clsx'
import { ChevronRight } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import type { Attention } from '@/lib/attention'
import { CHAT_STATE } from '@/lib/chat'
import { useLiveSessions } from '@/lib/frame/live'
import {
  type AskCounts,
  askText,
  NO_ASKS,
  type RowState,
  rowState,
} from '@/lib/frame/triage'
import { useAgentTools } from '@/lib/hooks/use-agent-tools'
import { useClock } from '@/lib/hooks/use-clock'
import { useLocalStorageState } from '@/lib/hooks/use-local-storage-state'
import type { SessionAttention } from '@/lib/hooks/use-session-attention'
import { sessionHostLabel } from '@/lib/machines'
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
import {
  foldSessionEntries,
  laneTitle,
  type SessionListEntry,
  slotMode,
  sortSessionEntries,
  type TeamEntry,
  type TeamRow,
  teamMembers,
} from './frame/session-entries'
import { HostBadge } from './HostBadge'
import { KeptCheckIns } from './KeptCheckIns'

/** The state word on a row, only where its group heading doesn't say it
 * already (Needs you, Working, Finished and Idle carry their own words and the
 * age sits at the right). A working session quiet for a while still says how
 * long; a lane in another state than the team above it, or a session with no
 * state to read, says its own. */
function stateInGroup(
  state: RowState,
  group: Attention['group'] | undefined,
  under: Attention['group'],
): string | null {
  if (group === undefined || group === 'no-status' || group !== under)
    return state.text
  return state.quiet === null ? null : `quiet ${state.quiet} min`
}

function rowFacts(item: TeamEntry) {
  return {
    label: item.entry.label,
    mode: item.entry.mode,
    state: item.entry.state,
    slot: item.entry.slot,
    asks: item.entry.asks,
  }
}

/** The agent's name for a tool slug. */
const toolName = (
  tools: readonly { slug: string; name: string }[],
  mode: string,
): string =>
  tools.find((tool) => tool.slug === mode)?.name ??
  (mode === 'shell' ? 'Shell' : mode)

/** "Shell also running": the pane's other running session, so a row that
 * holds two never hides one. */
export function alsoRunningText(
  slot: TerminalSlot | PaneSlot | undefined,
  tools: readonly { slug: string; name: string }[],
): string | null {
  const modes = slot && 'alsoRunning' in slot ? slot.alsoRunning : undefined
  if (!modes?.length) return null
  return `${modes.map((mode) => toolName(tools, mode)).join(', ')} also running`
}

/** What ending the shown session does to the pane's other one: ending the
 * agent takes the shell beside it too; ending the shell leaves the agent. */
export function endAlongsideNote(
  slot: TerminalSlot | PaneSlot,
  tools: readonly { slug: string; name: string }[],
): string {
  const others = 'alsoRunning' in slot ? (slot.alsoRunning ?? []) : []
  if (others.length === 0 || slot.type !== 'project') return ''
  if (slot.activeMode !== 'shell')
    return others.every((mode) => mode === 'shell')
      ? ' This also ends the Shell running beside it.'
      : ''
  return ` ${others.map((mode) => toolName(tools, mode)).join(', ')} keeps running.`
}

/** A session as its list row names it: its name, numbered when another
 * session of the same agent has the same name. The header, the list and the
 * End dialog all say this. */
function sessionLabel(
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
  return `“${label}” (${toolName(tools, slotMode(slot))} on ${sessionHostLabel(slot.host ?? null)})`
}

const TEAMS_OPEN_KEY = 'aico:teams-open'

/** Which teams show their lanes. A desktop remembers each coordinator in
 * this browser (open by default); a phone starts every team folded. */
export function useTeamFolds(phone: boolean) {
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
  const live = useLiveSessions()
  const now = useClock(30_000)
  const agentName = (mode: string) => toolName(agentTools, mode)
  /** What the row says about its session's state, with its questions. */
  const stateOf = (
    item: TeamEntry,
  ): { state: RowState; asks: string | null } => {
    const sessionId = getSlotSessionId(item.entry.slot)
    return {
      state: rowState(
        item.entry.state,
        sessionId ? live.bySession.get(sessionId) : undefined,
        now,
        item.entry.mode === 'shell',
      ),
      asks: askText(item.entry.asks),
    }
  }

  // Where each runs says something only when sessions run in more than one place.
  const severalHosts = slots.some((candidate) => candidate.host)
  const renderRow = (
    row: TeamRow<TeamEntry>,
    lead: SessionListEntry | null,
    under: Attention['group'],
  ): React.ReactNode => {
    const { id } = row.item
    const { label, mode, state, slot } = rowFacts(row.item)
    const shown = stateOf(row.item)
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
    // The line shows only while the agent is working, so it never goes stale.
    const doing =
      shown.state.tone === 'work' || shown.state.tone === 'quiet'
        ? slot?.doing
        : null
    const stateWord = stateInGroup(shown.state, group, under)
    const meta = chat
      ? `${chat.role} · ${chat.model ?? '—'} · ${CHAT_STATE[chat.state] ?? chat.state} · ${chat.cwd.split('/').pop()}`
      : [
          agentName(mode),
          stateWord,
          shown.asks,
          alsoRunningText(slot, agentTools),
          slot?.projectLabel,
          // Where it runs: a remote host has its chip beside this; the local
          // one is said only where something runs elsewhere.
          slot?.host || !severalHosts ? null : sessionHostLabel(null),
          // A team row: the coordinator's own state, then its team summary.
          isTeam ? row.summary : null,
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
            {!chat && (
              <span
                aria-hidden="true"
                className="lantern-mark"
                data-tone={needs ? 'need' : shown.state.tone}
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
          {doing && (
            <span className="doing" title={doing}>
              {doing}
            </span>
          )}
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
            {row.children.map((child) =>
              renderRow(child, row.item.entry, under),
            )}
          </div>
        )}
      </div>
    )
  }

  const labels = {
    'needs-you': 'Needs you',
    working: 'Working',
    idle: 'Idle',
    finished: 'Finished',
    'no-status': 'Idle',
  }
  // The group each row sits in; no-status sessions read as idle.
  const groupOf = (row: TeamRow<TeamEntry>) => labels[row.group]

  return (
    <>
      {teams.map((row, index) => {
        const header =
          index === 0 ||
          groupOf(teams[index - 1] as TeamRow<TeamEntry>) !== groupOf(row)
            ? groupOf(row)
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
                  {teams.filter((item) => groupOf(item) === header).length}
                </span>
              </h3>
            )}
            {renderRow(row, null, row.group)}
          </div>
        )
      })}
      <KeptCheckIns />
    </>
  )
}
