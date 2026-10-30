'use client'

import { Activity } from 'lucide-react'
import { useState } from 'react'
import { pillState, TONE_COLOR } from '@/lib/health'
import { useHealth } from '@/lib/hooks/use-health'
import { HealthSheet } from './HealthSheet'

type Variant = 'icon' | 'row'

/** The Health entry: a square icon with a problem count (session list header
 * and rail) or a short labelled row with the count (session switcher). Its
 * colour is Nightshift's state; the tooltip says it in words. */
export function HealthButton({
  onClick,
  variant = 'icon',
}: {
  onClick: () => void
  variant?: Variant
}) {
  const { result, isLoading, isError } = useHealth()
  const pill = pillState(result, isError, isLoading)
  const color = TONE_COLOR[pill.tone]
  if (variant === 'icon')
    return (
      <button
        type="button"
        className="lantern-icon-btn compact relative"
        onClick={onClick}
        aria-label={pill.title}
        title={pill.title}
        data-testid="health-btn"
        data-tone={pill.tone}
      >
        <Activity
          className="h-[18px] w-[18px]"
          strokeWidth={1.7}
          style={{ color }}
        />
        {pill.count > 0 && (
          <span
            aria-hidden="true"
            className="lantern-rail-count"
            style={{ backgroundColor: color }}
          >
            {pill.count}
          </span>
        )}
      </button>
    )
  return (
    <button
      type="button"
      className="lantern-btn ghost small"
      onClick={onClick}
      aria-label={pill.title}
      title={pill.title}
      data-testid="health-btn"
      data-tone={pill.tone}
    >
      <Activity className="h-4 w-4" strokeWidth={1.7} style={{ color }} />
      {pill.label}
      {pill.count > 0 && (
        <span aria-hidden="true" style={{ color }}>
          {pill.count}
        </span>
      )}
    </button>
  )
}

/** The Health entry with its sheet, for places that stay mounted. */
export function HealthLauncher({ variant = 'icon' }: { variant?: Variant }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <HealthButton variant={variant} onClick={() => setOpen(true)} />
      {open && <HealthSheet open onOpenChange={setOpen} />}
    </>
  )
}
