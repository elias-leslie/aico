// Which sessions need the owner, from Tether's per-session agent state
// (`activity` on each session; tether docs/agent-state.md): Needs you,
// Finished, Working, Idle, or No status (Tether reads no state for the
// session, e.g. a shell). As in Aico's tray menu, only Needs you moves a
// session in the list (components/SessionList.tsx).
//
// "Seen" is when the owner last had each session open: this browser's own
// record (localStorage, at once) or any device's (the server's `seen_at`,
// shared through the session list). A blocked session is "needs you" until it
// is opened; a turn that finished since it was last open is "finished".

import type { TerminalSession } from './hooks/use-terminal-sessions'

export type Activity = 'working' | 'idle' | 'blocked' | 'unknown'
export type AttentionGroup =
  | 'needs-you'
  | 'finished'
  | 'working'
  | 'idle'
  | 'no-status'

export interface Attention {
  group: AttentionGroup
  activity: Activity
  /** When the activity began (ms), or null. */
  at: number | null
  /** State and age, e.g. `waiting 3m`, `done 1m`. */
  detail: string | null
  /** Time since the activity began, e.g. `3m`, or null. */
  age: string | null
}

type ActivitySession = Pick<
  TerminalSession,
  'activity' | 'activity_previous' | 'activity_at'
>

/** Compact age: `<1m`, `3m`, `2h`, `4d`. */
export function formatAge(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

export function attentionOf(
  session: ActivitySession,
  seenAt: number,
  now: number,
): Attention {
  const activity = (session.activity ?? 'unknown') as Activity
  const at = session.activity_at ?? null
  const unseen = at !== null && at > seenAt
  const previous = session.activity_previous ?? 'unknown'
  let group: AttentionGroup = 'idle'
  if (activity === 'blocked' && unseen) group = 'needs-you'
  else if (
    activity === 'idle' &&
    unseen &&
    (previous === 'working' || previous === 'blocked')
  )
    group = 'finished'
  else if (activity === 'working') group = 'working'
  else if (activity === 'unknown') group = 'no-status'
  const word =
    activity === 'blocked'
      ? 'waiting'
      : group === 'finished'
        ? 'done'
        : activity === 'working' || activity === 'idle'
          ? activity
          : null
  const age = at ? formatAge(now - at) : null
  const detail = word && age ? `${word} ${age}` : word
  return { group, activity, at, detail, age }
}

/** A running workflow step as an agent's state: working, or waiting for the
 * owner (the session list shows only those). */
export function stepAttention(
  step: { group: AttentionGroup; at: number | null },
  now: number,
): Attention {
  const blocked = step.group === 'needs-you'
  const word = blocked ? 'waiting' : 'working'
  const age = step.at ? formatAge(now - step.at) : null
  return {
    group: blocked ? 'needs-you' : 'working',
    activity: blocked ? 'blocked' : 'working',
    at: step.at,
    detail: age ? `${word} ${age}` : word,
    age,
  }
}

const RANK: Record<AttentionGroup, number> = {
  'needs-you': 0,
  finished: 1,
  working: 2,
  idle: 3,
  'no-status': 4,
}

/** The most urgent of several (a pane's shell and agent sessions). */
export function mostUrgent(items: Attention[]): Attention | null {
  let best: Attention | null = null
  for (const item of items) {
    if (!best || RANK[item.group] < RANK[best.group]) best = item
    else if (
      RANK[item.group] === RANK[best.group] &&
      item.activity !== 'unknown' &&
      best.activity === 'unknown'
    )
      best = item
  }
  return best
}

// --- seen store (per browser) -------------------------------------------------

const SEEN_KEY = 'aTerm:attention-seen'
const SEEN_MAX = 500
type SeenMap = Record<string, number>
let seenCache: SeenMap | null = null
const listeners = new Set<() => void>()

function readSeen(): SeenMap {
  if (seenCache) return seenCache
  try {
    const parsed = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}')
    seenCache =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as SeenMap)
        : {}
  } catch {
    seenCache = {}
  }
  return seenCache
}

export function seenSnapshot(): SeenMap {
  return typeof window === 'undefined' ? EMPTY : readSeen()
}

const EMPTY: SeenMap = {}

export function subscribeSeen(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key !== SEEN_KEY) return
    seenCache = null
    listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

/** The later of this browser's record and every device's (`seen_at`). */
export function seenAtOf(
  session: { id: string; seen_at?: number | null },
  local: Readonly<Record<string, number>>,
): number {
  return Math.max(local[session.id] ?? 0, session.seen_at ?? 0)
}

/** Tell the server too, so the owner's other devices count them as opened.
 * Best effort: this browser's own record already has them. */
export function shareSeen(ids: readonly string[]): void {
  if (!ids.length) return
  void fetch('/api/sessions/seen', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  }).catch(() => {})
}

/** Record that the owner has these sessions open now. */
export function markSeen(ids: readonly string[], now = Date.now()): void {
  if (!ids.length) return
  const next: SeenMap = { ...readSeen() }
  for (const id of ids) next[id] = now
  const entries = Object.entries(next)
  if (entries.length > SEEN_MAX) {
    entries.sort((a, b) => b[1] - a[1])
    seenCache = Object.fromEntries(entries.slice(0, SEEN_MAX))
  } else seenCache = next
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seenCache))
  } catch {
    // Private mode or full storage: seen stays in memory for this tab.
  }
  for (const listener of listeners) listener()
}

/** Test support. */
export function resetSeenForTests(): void {
  seenCache = null
}
