'use client'

import { STANDBY_TIP, type Standby } from '@/lib/machines'

const WORD = {
  ready: 'Ready',
  behind: 'Behind',
  off: 'Off',
  unknown: 'Unknown',
} as const
const DOT = {
  ready: 'var(--jade)',
  behind: 'var(--beacon)',
  off: 'var(--mist)',
  unknown: 'var(--mist)',
} as const
const LABEL = {
  ready: 'Standby, ready',
  behind: 'Standby, not fully in sync',
  off: 'Standby, off',
  unknown: 'Standby, state unknown',
} as const

/** The standby's badge: a dot that is green only when it is up and every copy it needs is fine,
 * amber when some copy is behind, grey when it is off or can't be judged; the tooltip says what it
 * does and what is behind. */
export function StandbyTag({
  standby,
  name,
  className,
}: {
  standby: Standby
  /** What the row calls this machine: the tag says Standby itself when the row doesn't. */
  name: string
  className: string
}) {
  const { state } = standby
  const detail = {
    ready: 'Ready to take over.',
    behind: `Not fully in sync:\n${standby.behind.map((line) => `• ${line}`).join('\n')}`,
    off: 'It is not up, so it can’t take over.',
    unknown:
      'Status can’t say how its copies are right now, so it can’t be called ready.',
  }[state]
  return (
    <span
      className={`${className} gap-[5px]`}
      title={`${STANDBY_TIP}\n${detail}`}
      aria-label={LABEL[state]}
      data-testid="standby-tag"
    >
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 flex-none rounded-full"
        style={{ backgroundColor: DOT[state] }}
      />
      {name === 'Standby' ? WORD[state] : `Standby · ${WORD[state]}`}
    </span>
  )
}
