// What the session window says when the agent's model changed under it or a
// refusal paused it (Tether's `modelSwitch`). Short enough for a phone with
// the keyboard open; the facts behind it go in `detail`.

import type { SessionModelSwitch } from '@/lib/hooks/use-terminal-sessions'

export interface ModelSwitchCopy {
  text: string
  /** The longer word, shown on request; null when the line says it all. */
  detail: string | null
  /** `warn` stopped or holds the agent; `quiet` is information only. */
  tone: 'warn' | 'quiet'
}

/** `a cyber refusal`, `an abuse refusal`, `a refusal`. */
function refusal(category: string | null): string {
  const words = category ? `${category} refusal` : 'refusal'
  return `${/^[aeiou]/i.test(words) ? 'an' : 'a'} ${words}`
}

const yesNo = (value: boolean | null): string =>
  value === null ? 'unknown' : value ? 'yes' : 'no'

/** The facts Tether adds a few seconds after the switch, and the way back:
 * a rewind only where Tether has a prompt to rewind to (Claude Code). */
function facts(change: SessionModelSwitch): string {
  const known = change.checked
    ? `Last commit ${change.commit ?? 'none'}. Changed since: ${yesNo(change.worktree_changed)}.`
    : 'Last commit and changes not checked yet.'
  const back = change.rewind_to
    ? 'Rewind it, or relaunch from a handoff.'
    : 'No rewind for this session: relaunch from a handoff.'
  return `Was ${change.from}. ${known} ${back}`
}

export function modelSwitchCopy(change: SessionModelSwitch): ModelSwitchCopy {
  const stopped = change.stopped ? 'stopped' : 'not stopped'
  switch (change.kind) {
    case 'refusal':
      return {
        text: `Switched to ${change.to} after ${refusal(change.category)} · ${stopped}`,
        detail: facts(change),
        tone: 'warn',
      }
    case 'substituted':
      return {
        text: `Served ${change.to} instead of ${change.from} · ${stopped}`,
        detail: null,
        tone: 'warn',
      }
    case 'paused':
      return {
        text: `Stopped on ${refusal(change.category)} · waiting on you`,
        detail: null,
        tone: 'warn',
      }
    case 'changed':
      return {
        text: `Now on ${change.to} (was ${change.from})`,
        detail: null,
        tone: 'quiet',
      }
  }
}
