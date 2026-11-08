'use client'

import {
  type AskCounts,
  askCounts,
  askCountsParts,
  useApprovals,
  useOwnerAsks,
} from '@/lib/hooks/use-asks'
import { plural } from '@/lib/status'
import { useSessionAttention } from './use-session-attention'

export interface NeedsYouCounts {
  /** Agent questions, notices and failed checks open now, each by itself. */
  asks: AskCounts
  /** Everything open in the Asks tab: all three kinds. */
  questions: number
  approvals: number
  /** Sessions waiting on the owner with no question of their own. */
  sessions: number
  count: number
  /** The lists have been read. False means the count is not known, which is
   * not the same as none waiting. */
  known: boolean
  /** What the count says in words, for labels and tooltips. */
  summary: string
}

/** What waits on the owner: agent questions, notices, failed checks,
 * access requests and sessions that stopped for the owner. One count for the side button, the Rail and the side, so
 * they never disagree; the words name each kind for what it is. */
export function useNeedsYouCounts(): NeedsYouCounts {
  const { asks, known: asksKnown } = useOwnerAsks()
  const { approvals, known: approvalsKnown } = useApprovals()
  const kinds = askCounts(asks)
  const questions = kinds.questions + kinds.notices + kinds.checks
  const taps = approvals?.taps.length ?? 0
  const sessions = useSessionAttention().waitingNoAsk
  const count = questions + taps + sessions
  // Something counted is known to be waiting; zero only counts once both
  // lists have been read.
  const known = count > 0 || (asksKnown === true && approvalsKnown === true)
  const summary = !known
    ? 'Needs you: not loaded yet'
    : count === 0
      ? 'Needs you: nothing waiting'
      : `Needs you: ${[
          ...askCountsParts(kinds),
          taps ? plural(taps, 'grant') : null,
          sessions ? plural(sessions, 'waiting session') : null,
        ]
          .filter(Boolean)
          .join(', ')} waiting`
  return {
    asks: kinds,
    questions,
    approvals: taps,
    sessions,
    count,
    known,
    summary,
  }
}
