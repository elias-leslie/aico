'use client'

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import {
  type Attention,
  attentionOf,
  markSeen,
  mostUrgent,
  seenSnapshot,
  subscribeSeen,
} from '../attention'
import type { ATermSlot, PaneSlot } from '../utils/slot'
import { getSlotSessionId, isPaneSlot } from '../utils/slot'
import { type ATermSession, useATermSessions } from './use-a-term-sessions'

const EMPTY_SEEN: Record<string, number> = {}
const AGE_TICK_MS = 30_000

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

/** Sessions that belong to a slot: every session of its pane, else its own. */
export function slotSessions(
  slot: ATermSlot | PaneSlot,
  sessions: readonly ATermSession[],
): ATermSession[] {
  if (isPaneSlot(slot)) {
    const inPane = sessions.filter((s) => s.pane_id === slot.paneId)
    if (inPane.length) return inPane
  }
  const id = getSlotSessionId(slot)
  return sessions.filter((s) => s.id === id)
}

export interface SessionAttention {
  /** A slot's most urgent session state, or null when unknown. */
  forSlot(slot: ATermSlot | PaneSlot): Attention | null
  /** Sessions that need the owner now. */
  needsYouCount: number
}

const NO_SESSIONS: ATermSession[] = []

export function useSessionAttention(): SessionAttention {
  const sessions = useATermSessions().sessions ?? NO_SESSIONS
  const seen = useSyncExternalStore(
    subscribeSeen,
    seenSnapshot,
    () => EMPTY_SEEN,
  )
  const now = useNow(AGE_TICK_MS)
  return useMemo(() => {
    const byId = new Map(
      sessions.map(
        (s) => [s.id, attentionOf(s, seen[s.id] ?? 0, now)] as const,
      ),
    )
    return {
      forSlot: (slot) =>
        mostUrgent(
          slotSessions(slot, sessions).flatMap((s) => {
            const item = byId.get(s.id)
            return item ? [item] : []
          }),
        ),
      needsYouCount: [...byId.values()].filter((a) => a.group === 'needs-you')
        .length,
    }
  }, [sessions, seen, now])
}

/**
 * While the page is visible, the owner sees the active session's pane: keep
 * it marked seen (opening a session clears its needs-you or finished state).
 */
export function useMarkActiveSeen(activeSessionId: string | null): void {
  const sessions = useATermSessions().sessions ?? NO_SESSIONS
  const active = sessions.find((s) => s.id === activeSessionId)
  const paneSessions = useMemo(
    () =>
      active
        ? sessions.filter(
            (s) =>
              s.id === active.id ||
              (active.pane_id && s.pane_id === active.pane_id),
          )
        : [],
    [sessions, active],
  )
  const ids = paneSessions.map((s) => s.id).join(',')
  const stamps = paneSessions.map((s) => s.activity_at ?? 0).join(',')
  // biome-ignore lint/correctness/useExhaustiveDependencies: stamps re-marks the open session when its state changes on screen
  useEffect(() => {
    if (!ids) return
    const mark = () => {
      if (document.visibilityState === 'visible') markSeen(ids.split(','))
    }
    mark()
    document.addEventListener('visibilitychange', mark)
    return () => document.removeEventListener('visibilitychange', mark)
  }, [ids, stamps])
}

/** Prefix the tab/app title with the needs-you count: `(2) Aico`. */
export function useAttentionTitle(count: number): void {
  useEffect(() => {
    const apply = () => {
      const base = document.title.replace(/^\(\d+\) /, '')
      const title = count > 0 ? `(${count}) ${base}` : base
      if (document.title !== title) document.title = title
    }
    apply()
    // Next re-renders its metadata <title> and drops the prefix: re-apply it.
    const observer = new MutationObserver(apply)
    observer.observe(document.head, {
      subtree: true,
      childList: true,
      characterData: true,
    })
    return () => observer.disconnect()
  }, [count])
}
