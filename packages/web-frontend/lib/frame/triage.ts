// How a session row says its state (mockup 2, item 17): working, working and
// quiet, idle since, needs you, finished; plus the owner's non-blocking
// questions on the row. Pure: the callers hand in what they know.

import type { Attention } from '../attention'
import { at } from '../status'
import { type LiveSession, quietMinutes } from './live'

/** The dot a row or rail mark wears. */
export type MarkTone = 'need' | 'work' | 'quiet' | 'idle' | 'done'

export interface RowState {
  /** The state in words, after the agent: "working, quiet 14 min". */
  text: string
  tone: MarkTone
  /** Minutes a working session has written nothing, when it has been a while. */
  quiet: number | null
}

export interface AskCounts {
  /** Open questions that stop the session until answered. */
  blocking: number
  /** Open questions the session carries on without. */
  other: number
}

export const NO_ASKS: AskCounts = { blocking: 0, other: 0 }

/** "1 question for you", "2 questions for you": the non-blocking asks on a row. */
export function askText(asks: AskCounts): string | null {
  if (asks.other <= 0) return null
  return `${asks.other} question${asks.other === 1 ? '' : 's'} for you`
}

export function rowState(
  attention: Attention | null,
  live: LiveSession | undefined,
  now: number,
  shell = false,
): RowState {
  const group = attention?.group
  if (group === 'needs-you')
    return { text: 'waiting for you', tone: 'need', quiet: null }
  if (group === 'working') {
    const quiet = quietMinutes(live, now)
    return {
      text: quiet === null ? 'working' : `working, quiet ${quiet} min`,
      tone: quiet === null ? 'work' : 'quiet',
      quiet,
    }
  }
  if (group === 'finished')
    return {
      text: attention?.at
        ? `finished ${at(attention.at, now)}`
        : 'finished, not opened yet',
      tone: 'done',
      quiet: null,
    }
  if (group === 'idle')
    return {
      text: attention?.at ? `idle since ${at(attention.at, now)}` : 'idle',
      tone: 'idle',
      quiet: null,
    }
  // A shell has no agent state to read: it is running while the session is there.
  if (shell) return { text: 'running', tone: 'idle', quiet: null }
  return { text: 'no status', tone: 'idle', quiet: null }
}

/** The tooltip and accessible name for a rail mark or row. */
export function rowSummary(
  name: string,
  agent: string,
  state: RowState,
  asks: AskCounts,
): string {
  return [name, agent, state.text, askText(asks)].filter(Boolean).join(' · ')
}
