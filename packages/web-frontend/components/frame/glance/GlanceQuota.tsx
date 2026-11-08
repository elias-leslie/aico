'use client'

import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { detailOf, ProviderDetails } from '@/components/quota/QuotaPage'
import { type QuotaGlance, quotaGlances } from '@/lib/frame/quota'
import { useClock } from '@/lib/hooks/use-clock'
import { useUsage } from '@/lib/hooks/use-usage'
import { COLLECTION_OLD_MS, type UsageProvider } from '@/lib/quota-usage'
import { ago } from '@/lib/status'
import styles from './Glance.module.css'
import own from './GlanceQuota.module.css'
import type { GlanceHead } from './glance-types'

/** At or under this much left, the heading turns amber. */
const LOW_PERCENT = 15

/** One subscription: its name and short line, and a bar of how much is left with a tick for how far into the window we are. */
function QuotaBar({ glance }: { glance: QuotaGlance }) {
  const unknown = glance.left === null
  return (
    <>
      <span className={styles.quotaLine}>
        <b>{glance.name}</b>
        <span>{glance.short}</span>
      </span>
      <span
        className={styles.bar}
        data-unknown={unknown ? 'true' : undefined}
        role="img"
        aria-label={
          glance.state !== 'left'
            ? `${glance.name}: ${glance.answer}`
            : `${glance.name}: ${glance.left}% left${glance.gone === null ? '' : `, ${glance.gone}% of the way through the window`}`
        }
      >
        {!unknown && <span style={{ width: `${glance.left}%` }} />}
        {!unknown && glance.gone !== null && (
          <i className={styles.tick} style={{ left: `${glance.gone}%` }} />
        )}
      </span>
    </>
  )
}

/** A subscription's row: its bar always; open, its windows with reset times, credits, spend and the project split. */
function QuotaRow({
  glance,
  provider,
  now,
}: {
  glance: QuotaGlance
  provider: UsageProvider | undefined
  now: number
}) {
  const [open, setOpen] = useState(false)
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <li className={own.row} title={glance.meaning}>
      <button
        type="button"
        className={own.toggle}
        aria-expanded={open}
        aria-label={`${glance.name}: ${glance.short}`}
        onClick={() => setOpen((now) => !now)}
      >
        <Chevron className="h-3.5 w-3.5" strokeWidth={1.7} aria-hidden="true" />
        <span className={own.bars}>
          <QuotaBar glance={glance} />
        </span>
      </button>
      {open && provider && (
        <div className={own.details}>
          {provider.plan && <p className={own.plan}>{provider.plan} plan</p>}
          <ProviderDetails provider={provider} now={now} />
        </div>
      )}
    </li>
  )
}

/** Quota for the heading: the lowest amount left across subscriptions, or which are used up; amber when low. */
export function useQuotaGlance(): GlanceHead {
  const { report, loading, failed } = useUsage()
  const glances = quotaGlances(report)
  if (glances.length === 0)
    return loading
      ? { value: 'Checking…', tone: null }
      : failed
        ? { value: 'Couldn’t read', tone: 'failed' }
        : { value: 'No reports yet', tone: null }
  const usedUp = glances.filter((glance) => glance.state === 'used_up')
  const unknown = glances.filter((glance) => glance.state === 'unknown').length
  const lefts = glances.flatMap((glance) =>
    glance.state === 'left' && glance.left !== null ? [glance.left] : [],
  )
  // One by name ("OpenCode Go used up"); more as a count of subscriptions.
  if (usedUp.length)
    return {
      value:
        usedUp.length === 1
          ? `${usedUp[0]?.name} used up`
          : `${usedUp.length} subscriptions used up`,
      tone: 'warn',
    }
  if (lefts.length) {
    const low = Math.min(...lefts)
    return {
      value: `${low}% left`,
      tone: low <= LOW_PERCENT || unknown > 0 ? 'warn' : null,
    }
  }
  if (unknown) return { value: 'Unknown', tone: 'unknown' }
  return { value: 'On credits', tone: null }
}

/** One row per subscription; each opens to its windows, credits, spend and where it went. */
export function GlanceQuota() {
  const { query, report, loading, failed, stale } = useUsage()
  const now = useClock(60_000)
  const glances = quotaGlances(report)
  if (loading)
    return (
      <p className={styles.note} role="status">
        Checking quota…
      </p>
    )
  if (failed)
    return (
      <div className={own.notice} role="alert">
        <p>
          <b>Quota couldn’t be read.</b> {detailOf(query.error)}
        </p>
        <button
          type="button"
          className="lantern-btn small"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {query.isFetching ? 'Retrying…' : 'Retry'}
        </button>
      </div>
    )
  if (glances.length === 0)
    return <p className={styles.note}>No quota reports yet.</p>
  const collected = report ? Date.parse(report.collected_at) : Number.NaN
  const old = !Number.isNaN(collected) && now - collected > COLLECTION_OLD_MS
  return (
    <div className={own.wrap} data-stale={stale ? 'true' : undefined}>
      {stale && (
        <div className={own.notice} role="status">
          <p>
            <b>Can’t refresh usage.</b> Showing the last numbers it read.
          </p>
          <button
            type="button"
            className="lantern-btn small"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            {query.isFetching ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      )}
      {!stale && old && (
        <p className={own.notice} role="status">
          Usage was last collected {ago(collected, now)}, so these numbers may
          be out of date.
        </p>
      )}
      <ul className={styles.quotas}>
        {glances.map((glance) => (
          <QuotaRow
            key={glance.id}
            glance={glance}
            provider={report?.providers.find((item) => item.id === glance.id)}
            now={now}
          />
        ))}
      </ul>
      <p className={own.legend}>
        Bar: how much is left. Tick: how far into the window we are.
      </p>
    </div>
  )
}
