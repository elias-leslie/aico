import {
  agentsText,
  type ProblemKind,
  type ProblemWorst,
  problemText,
  type RunState,
  runStateText,
} from '@/lib/projects'
import { PersonIcon, ProblemIcon } from './icons'
import styles from './ProjectsPage.module.css'

/** Only Status's failed state is ember; warnings and quiet checks are amber. */
/** The one short word beside a badge's count; the full sentence stays in its tooltip. */
const PROBLEM_WORD: Record<ProblemKind, string> = {
  fail: 'failed',
  warn: 'warn',
  quiet: 'quiet',
  publish: 'publish',
  backup: 'backup',
}

const tone = (kind: ProblemKind, worst?: ProblemWorst) =>
  kind === 'quiet' || kind === 'warn' || worst === 'warn' ? 'warn' : 'fail'

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
      data-tone={tone(kind, worst)}
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
