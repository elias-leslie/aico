'use client'

import { clsx } from 'clsx'
import { ChevronRight } from 'lucide-react'
import { CHAT_STATE } from '@/lib/chat'
import { useLiveSessions } from '@/lib/frame/live'
import { askText, type MarkTone, rowState } from '@/lib/frame/triage'
import { useAgentTools } from '@/lib/hooks/use-agent-tools'
import { useClock } from '@/lib/hooks/use-clock'
import { sessionHostLabel } from '@/lib/machines'
import {
  getSlotSessionId,
  type PaneSlot,
  type TerminalSlot,
} from '@/lib/utils/slot'
import { AgentIcon, getAgentColor } from '../AgentIcon'
import { CheckInBadge } from '../CheckInBadge'
import { CoordinatorBadge } from '../CoordinatorBadge'
import { HostBadge } from '../HostBadge'
import { alsoRunningText, useTeamFolds } from '../SessionList'
import { usePopoverClose } from './RailPopover'
import {
  laneTitle,
  type TeamEntry,
  type TeamRow,
  teamMembers,
} from './session-entries'

/** The state chip a session wears: shape and colour carry the state, amber only for waiting. */
const CHIP: Record<MarkTone, { kind: string; text: string }> = {
  need: { kind: 'warn', text: 'Waiting for you' },
  work: { kind: 'running', text: 'Working' },
  quiet: { kind: 'running', text: 'Working' },
  idle: { kind: 'unknown', text: 'Idle' },
  done: { kind: 'ok', text: 'Finished' },
}

export interface RowsContext {
  currentId?: string
  onSelect: (slot: TerminalSlot | PaneSlot) => void
  /** Sessions run in more than one place, so where one runs is worth saying. */
  severalHosts: boolean
}

/** One session as a row: agent, name, state chip, and what it is doing. A coordinator's row
 * carries its team (`children`) under a fold. */
export function SessionRow({
  row,
  lead = null,
  ctx,
  prefix,
  showProject = false,
}: {
  row: TeamRow<TeamEntry>
  /** The coordinator this is a lane of: its title is trimmed of the project the coordinator names. */
  lead?: TeamEntry | null
  ctx: RowsContext
  /** A project's name in front of the title, when the row stands for the whole project. */
  prefix?: string
  /** Say which project it is in (rows that are not under their project). */
  showProject?: boolean
}) {
  const { agentTools } = useAgentTools()
  const live = useLiveSessions()
  const now = useClock(30_000)
  const closePopover = usePopoverClose()
  const folds = useTeamFolds(false)
  const { entry } = row.item
  const { slot, mode, label } = entry
  const isTeam = row.children.length > 0
  const sessionKey = getSlotSessionId(slot) ?? entry.id
  const teamOpen = isTeam && folds.isOpen(sessionKey)
  const sessionId = getSlotSessionId(slot)
  const state = rowState(
    entry.state,
    sessionId ? live.bySession.get(sessionId) : undefined,
    now,
    mode === 'shell',
  )
  const tool = agentTools.find((candidate) => candidate.slug === mode)
  const agent =
    tool?.name ?? (mode === 'shell' ? 'Shell' : mode === 'chat' ? 'Chat' : mode)
  // A folded team waiting on a lane is highlighted; open, the lane is.
  const needs =
    entry.state?.group === 'needs-you' ||
    (isTeam && !teamOpen && row.group === 'needs-you')
  const chip = CHIP[needs ? 'need' : state.tone]
  const name = lead ? laneTitle(label, lead.entry.label) : label
  const chat = slot.chatSummary
  const doing =
    state.tone === 'work' || state.tone === 'quiet' ? slot.doing : null
  const checkIns =
    isTeam && !teamOpen
      ? teamMembers(row).flatMap((member) => member.entry.slot.checkIns ?? [])
      : slot.checkIns
  const meta = chat
    ? `${chat.role} · ${chat.model ?? '—'} · ${CHAT_STATE[chat.state] ?? chat.state}`
    : [
        agent,
        state.quiet === null ? null : `quiet ${state.quiet} min`,
        askText(entry.asks),
        alsoRunningText(slot, agentTools),
        showProject ? slot.projectLabel : null,
        slot.host || !ctx.severalHosts ? null : sessionHostLabel(null),
        isTeam ? row.summary : null,
        row.orphaned ? 'coordinator ended' : null,
      ]
        .filter(Boolean)
        .join(' · ')
  return (
    <div className={clsx(isTeam && 'lantern-team')}>
      <button
        type="button"
        onClick={() => {
          ctx.onSelect(slot)
          closePopover?.()
        }}
        aria-current={entry.id === ctx.currentId ? 'true' : undefined}
        data-testid="project-session"
        className={clsx('lantern-row', needs && 'needs', isTeam && 'lead')}
      >
        <AgentIcon
          slug={mode}
          size={16}
          color={getAgentColor(mode, tool?.color)}
        />
        <span className="name" title={chat?.last ?? name}>
          {prefix && (
            <>
              <b style={{ fontWeight: 600 }}>{prefix}</b>
              {' · '}
            </>
          )}
          {name}
        </span>
        <span className="when">{entry.state?.age ?? ''}</span>
        <span className="meta">
          <span className={`status-chip ${chip.kind}`}>{chip.text}</span>
          {!(lead && slot.badge?.label.startsWith('↳')) && (
            <CoordinatorBadge badge={slot.badge} ownLine />
          )}
          <HostBadge host={slot.host} state={slot.hostState} />
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
          style={lead ? { marginLeft: 10 } : undefined}
        >
          {row.children.map((child) => (
            <SessionRow
              key={child.item.id}
              row={child}
              lead={row.item}
              ctx={ctx}
            />
          ))}
        </div>
      )}
    </div>
  )
}
