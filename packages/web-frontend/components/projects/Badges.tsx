import {
  agentsText,
  PROBLEM_WORD,
  type ProblemKind,
  type ProblemWorst,
  problemText,
  problemTone,
  type RunState,
  runStateText,
} from '@/lib/projects'
import { PersonIcon, ProblemIcon } from './icons'
import styles from './ProjectsPage.module.css'

interface BadgeProps {
  onClick: () => void
  expanded?: boolean
}

export function ProblemBadge({
  kind,
  count,
  worst,
  onClick,
  expanded,
}: BadgeProps & { kind: ProblemKind; count: number; worst?: ProblemWorst }) {
  const text = problemText(kind, count, worst)
  return (
    <button
      type="button"
      className={styles.badge}
      data-tone={problemTone(kind, worst)}
      aria-label={text}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      title={text}
      onClick={onClick}
    >
      <ProblemIcon kind={kind} />
      {count} {PROBLEM_WORD[kind]}
    </button>
  )
}

export function AgentsBadge({
  count,
  onClick,
  expanded,
}: BadgeProps & { count: number }) {
  const text = agentsText(count)
  return (
    <button
      type="button"
      className={styles.badge}
      data-tone="agents"
      aria-label={text}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      title={text}
      onClick={onClick}
    >
      <PersonIcon />
      {count} working
    </button>
  )
}

/** The project's run state as a shape: filled circle, ring, diamond, dashed ring, open arc. */
export function RunMark({ state }: { state: RunState | null }) {
  const text = state ? runStateText[state] : ''
  return (
    <span
      className={styles.mark}
      data-state={state ?? 'none'}
      role={state ? 'img' : undefined}
      aria-label={state ? text : undefined}
      aria-hidden={state ? undefined : true}
      title={state ? text : undefined}
    />
  )
}

/** A project waiting on the owner. */
export function Beacon() {
  return (
    <span
      className={styles.wait}
      role="img"
      aria-label="Waiting on you"
      title="Waiting on you"
    />
  )
}
