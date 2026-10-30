'use client'

import { Activity } from 'lucide-react'
import { useState } from 'react'
import { pillState, TONE_COLOR } from '@/lib/health'
import { useHealth } from '@/lib/hooks/use-health'
import { HealthSheet } from './HealthSheet'

type Variant = 'icon' | 'pill' | 'row'

/** The Health entry: a square icon (rail), a short pill (session list
 * header) or a labelled row (phone list). Its colour is Nightshift's state. */
export function HealthButton({
  onClick,
  variant = 'pill',
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
  const short =
    variant === 'pill' && pill.count > 0 ? `Health ${pill.count}` : pill.label
  return (
    <button
      type="button"
      className={
        variant === 'row'
          ? 'lantern-btn ghost small'
          : 'inline-flex h-7 flex-none items-center gap-1.5 rounded-full px-2.5 text-[12px] transition-colors hover:bg-[var(--paper-veil)]'
      }
      style={
        variant === 'pill'
          ? {
              border: `1px solid color-mix(in srgb, ${color} 40%, transparent)`,
              color: pill.tone === 'quiet' ? 'var(--mist)' : color,
            }
          : undefined
      }
      onClick={onClick}
      aria-label={pill.title}
      title={pill.title}
      data-testid="health-btn"
      data-tone={pill.tone}
    >
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 flex-none rounded-full"
        style={{ backgroundColor: color }}
      />
      {variant === 'row' ? pill.label : short}
    </button>
  )
}

/** The Health entry with its sheet, for places that stay mounted. */
export function HealthLauncher({ variant = 'pill' }: { variant?: Variant }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <HealthButton variant={variant} onClick={() => setOpen(true)} />
      {open && <HealthSheet open onOpenChange={setOpen} />}
    </>
  )
}
