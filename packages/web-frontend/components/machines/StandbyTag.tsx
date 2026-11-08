'use client'

import { STANDBY_TIP, type Standby } from '@/lib/machines'

/** The standby's badge: a dot that is green when it is ready to take over and amber when some
 * copy it needs is behind; the tooltip says what it does and what is behind. */
export function StandbyTag({
  standby,
  className,
}: {
  standby: Standby
  className: string
}) {
  const tip = standby.ready
    ? `${STANDBY_TIP}\nReady to take over.`
    : `${STANDBY_TIP}\nNot fully in sync:\n${standby.behind.map((line) => `• ${line}`).join('\n')}`
  return (
    <span
      className={`${className} gap-[5px]`}
      title={tip}
      aria-label={
        standby.ready ? 'Standby, ready' : 'Standby, not fully in sync'
      }
      data-testid="standby-tag"
    >
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 flex-none rounded-full"
        style={{
          backgroundColor: standby.ready ? 'var(--jade)' : 'var(--beacon)',
        }}
      />
      Standby
    </span>
  )
}
