'use client'

import { openAsks, useApprovals, useOwnerAsks } from '@/lib/hooks/use-asks'
import { plural } from '@/lib/status'

export interface NeedsYouCounts {
  questions: number
  approvals: number
  count: number
  /** The lists have been read. False means the count is not known, which is
   * not the same as none waiting. */
  known: boolean
  /** What the count says in words, for labels and tooltips. */
  summary: string
}

/** What waits on the owner: agent questions and access requests. One count
 * for the top bar, the launchers and the side, so they never disagree. */
export function useNeedsYouCounts(): NeedsYouCounts {
  const { asks, known: asksKnown } = useOwnerAsks()
  const { approvals, known: approvalsKnown } = useApprovals()
  const questions = openAsks(asks).length
  const taps = approvals?.taps.length ?? 0
  const count = questions + taps
  // Something counted is known to be waiting; zero only counts once both
  // lists have been read.
  const known = count > 0 || (asksKnown === true && approvalsKnown === true)
  const summary = !known
    ? 'Needs you: not loaded yet'
    : count === 0
      ? 'Needs you: no agent questions or grants waiting'
      : `Needs you: ${[
          questions ? plural(questions, 'agent question') : null,
          taps ? plural(taps, 'grant') : null,
        ]
          .filter(Boolean)
          .join(' and ')} waiting`
  return { questions, approvals: taps, count, known, summary }
}
