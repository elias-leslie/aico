import {
  foldTeams,
  laneTitle,
  type TeamRow,
  teamMembers,
} from '@aico/tether-client/teams'
import type { Attention } from '@/lib/attention'
import { type AskCounts, NO_ASKS } from '@/lib/frame/triage'
import type { SessionAttention } from '@/lib/hooks/use-session-attention'
import {
  getSlotName,
  getSlotPanelId,
  getSlotSessionId,
  type PaneSlot,
  type TerminalSlot,
} from '@/lib/utils/slot'

// The one place the web side reads the team rule from @aico/tether-client/teams.
export { laneTitle, type TeamRow, teamMembers }

/** The agent a session runs (its tool slug), or `shell`. */
export function slotMode(slot: TerminalSlot | PaneSlot): string {
  if (slot.type === 'project') {
    return slot.activeMode
  }
  return slot.sessionMode ?? 'shell'
}

export interface SessionListEntry {
  id: string
  label: string
  mode: string
  slot: TerminalSlot | PaneSlot
  state: Attention | null
  asks: AskCounts
}

/** Sessions oldest first, so a state change never moves one; the same name
 * with the same agent is numbered. */
export function sortSessionEntries(
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
      asks: attention?.asksFor?.(slot) ?? NO_ASKS,
    }
  })
}

/** A list entry as a team member (@aico/tether-client/teams): lineage by row id. A row is
 * a session (`entry`) or a running workflow step shown as a child agent (`step`). */
export interface TeamEntry {
  id: string
  coordinator: boolean
  coordinatorId: string | null
  parentId: string | null
  group: Attention['group']
  entry: SessionListEntry
}

/** Fold entries into coordinator teams. A lane names its coordinator and
 * the session that launched it by session id, and nests under that session
 * while it is listed; rows are keyed by slot. A workflow step that is running
 * or waiting for the owner folds under the session that launched its run,
 * like any other child agent. */
export function foldSessionEntries(
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
      entry,
    }
  })
  return foldTeams(sessions)
}

/** A session on its own as a team row, for lists that show sessions flat. */
export function asTeamRow(entry: SessionListEntry): TeamRow<TeamEntry> {
  const group = entry.state?.group ?? 'no-status'
  return {
    item: {
      id: entry.id,
      coordinator: false,
      coordinatorId: null,
      parentId: null,
      group,
      entry,
    },
    group,
    children: [],
    summary: null,
    orphaned: false,
  }
}
