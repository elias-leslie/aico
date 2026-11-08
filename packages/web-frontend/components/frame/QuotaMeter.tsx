'use client'

import { quotaGlances, quotaLine } from '@/lib/frame/quota'
import { useUsage } from '@/lib/hooks/use-usage'
import { GlancePopover } from './glance/GlancePopover'
import { GlanceQuota, useQuotaGlance } from './glance/GlanceQuota'
import { RailPopover } from './RailPopover'

/** At or under this much left, the meter turns amber. */
const LOW_PERCENT = 15

/** The lowest amount left among subscriptions that still have quota, as a few characters. One that is
 * used up is not a 0% to read past the others: it turns the meter's dot red and leads the tooltip. */
function useMeter() {
  const { report, loading, failed } = useUsage()
  const glances = quotaGlances(report)
  const head = useQuotaGlance()
  const usedUp = glances.filter((glance) => glance.state === 'used_up')
  const lefts = glances.flatMap((glance) =>
    glance.state === 'left' && glance.left !== null && glance.left > 0
      ? [glance.left]
      : [],
  )
  const low = lefts.length ? Math.min(...lefts) : null
  const credits = glances.some((glance) => glance.state === 'credits')
  const text =
    low !== null
      ? `${low}%`
      : usedUp.length > 0 && !credits
        ? '0%'
        : glances.length === 0
          ? loading
            ? '…'
            : failed
              ? '!'
              : '–'
          : credits
            ? 'cr'
            : '?'
  const label =
    glances.length > 0
      ? `Quota: ${quotaLine([...usedUp, ...glances.filter((glance) => glance.state !== 'used_up')])}`
      : loading
        ? 'Quota: checking'
        : failed
          ? 'Quota: couldn’t be read'
          : 'Quota: no reports yet'
  return {
    low,
    text,
    label,
    head,
    danger: usedUp.length > 0,
    warn: low !== null && low <= LOW_PERCENT,
  }
}

/** A small battery-like meter: filled to how much is left. */
function MeterIcon({ low, warn }: { low: number | null; warn: boolean }) {
  return (
    <svg
      width="18"
      height="10"
      viewBox="0 0 18 10"
      aria-hidden="true"
      style={{ color: warn ? 'var(--lantern)' : 'currentColor' }}
    >
      <rect
        x="0.5"
        y="0.5"
        width="17"
        height="9"
        rx="2.5"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.7"
      />
      {low !== null && low > 0 && (
        <rect
          x="2"
          y="2"
          width={(14 * low) / 100}
          height="6"
          rx="1.25"
          fill="currentColor"
        />
      )}
    </svg>
  )
}

/** Quota in the side's footer: the meter and the lowest percentage left, popping out the full
 * breakdown. Beside the Settings gear in the Panel; the rail's own icon (`icon`) with the pop-out
 * beside the side. */
export function QuotaMeter({ icon = false }: { icon?: boolean }) {
  const meter = useMeter()
  return (
    <RailPopover
      label={meter.label}
      panelLabel="Quota"
      placement={icon ? 'beside' : 'above'}
      className={
        icon
          ? 'lantern-icon-btn compact relative flex-col gap-0.5'
          : 'lantern-btn ghost small relative'
      }
      extra={{ 'data-testid': 'quota-meter' }}
      icon={
        <>
          <MeterIcon low={meter.low} warn={meter.warn} />
          {meter.danger && (
            <span
              aria-hidden="true"
              className="lantern-mark"
              data-testid="quota-danger"
              style={{
                position: 'absolute',
                top: icon ? 6 : 3,
                right: icon ? 8 : 4,
                background: 'var(--ember)',
              }}
            />
          )}
          <span
            style={{
              font: icon
                ? '600 9.5px/1 var(--font-mono)'
                : '500 12.5px/1 var(--font-mono)',
              color: meter.warn ? 'var(--lantern)' : undefined,
            }}
          >
            {meter.text}
          </span>
        </>
      }
    >
      <GlancePopover title="Quota" head={meter.head}>
        <GlanceQuota />
      </GlancePopover>
    </RailPopover>
  )
}
