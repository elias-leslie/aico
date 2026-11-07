'use client'

import { useQuery } from '@tanstack/react-query'
import { ApiError, apiFetch } from '@/lib/api-fetch'
import { useClock } from '@/lib/hooks/use-clock'
import {
  barHeights,
  COLLECTION_OLD_MS,
  compact,
  dayLabel,
  dayText,
  dayValue,
  localDay,
  sentence,
  summarize,
  type UsageProvider,
  type UsageReport,
  type UsageWindow,
  unitCaption,
  windowGone,
} from '@/lib/quota-usage'
import { ago } from '@/lib/status'
import styles from './QuotaPage.module.css'

const POLL_MS = 60_000

/** Quota: what each provider has left, when it resets, and what was spent per day (#24). */
export function QuotaPage() {
  const now = useClock(POLL_MS)
  const query = useQuery({
    queryKey: ['usage'],
    queryFn: () =>
      apiFetch<UsageReport>('/api/usage', undefined, 'Aico did not answer'),
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
    retry: 1,
  })
  const report = query.data ?? null
  const collectedMs = report ? Date.parse(report.collected_at) : null
  const old = collectedMs !== null && now - collectedMs > COLLECTION_OLD_MS

  return (
    <main className={styles.page} aria-label="Quota">
      <header className={styles.head}>
        <h1>Quota</h1>
        {collectedMs !== null && (
          <span className={styles.muted}>Read {ago(collectedMs, now)}</span>
        )}
      </header>
      {query.isPending && (
        <>
          <p className={styles.muted} role="status">
            Reading usage…
          </p>
          <div className={styles.cards} aria-hidden="true">
            <div className={styles.skeleton} />
          </div>
        </>
      )}
      {!report && query.isError && (
        <Problem
          lead="Can’t read usage."
          detail={detailOf(query.error)}
          onRetry={() => query.refetch()}
          busy={query.isFetching}
        />
      )}
      {report && query.isError && (
        <Problem
          lead="Can’t refresh usage."
          detail="Showing the last numbers it read."
          onRetry={() => query.refetch()}
          busy={query.isFetching}
          warn
        />
      )}
      {report && old && !query.isError && (
        <div className={`${styles.notice} ${styles.warn}`} role="status">
          <p>
            Usage was last collected {ago(collectedMs as number, now)}, so these
            numbers may be out of date.
          </p>
        </div>
      )}
      {report && (
        <div className={styles.cards}>
          {report.providers.map((provider) => (
            <ProviderCard key={provider.id} provider={provider} now={now} />
          ))}
        </div>
      )}
    </main>
  )
}

function detailOf(error: unknown): string {
  if (error instanceof ApiError)
    return error.status === 503
      ? `${error.message} It is read every few minutes once Aico has collected it.`
      : error.message
  return 'Aico did not answer.'
}

function Problem({
  lead,
  detail,
  onRetry,
  busy,
  warn,
}: {
  lead: string
  detail: string
  onRetry: () => void
  busy: boolean
  warn?: boolean
}) {
  return (
    <div
      className={`${styles.notice}${warn ? ` ${styles.warn}` : ''}`}
      role="alert"
    >
      <p>
        <strong>{lead}</strong> {detail}
      </p>
      <button
        type="button"
        className={`lantern-btn small ${styles.retry}`}
        onClick={onRetry}
        disabled={busy}
      >
        {busy ? 'Retrying…' : 'Retry'}
      </button>
    </div>
  )
}

function ProviderCard({
  provider,
  now,
}: {
  provider: UsageProvider
  now: number
}) {
  const stateChip =
    provider.status === 'used_up'
      ? 'warn'
      : provider.status === 'unknown'
        ? 'unknown'
        : null
  return (
    <section className={styles.card} aria-label={`${provider.name} usage`}>
      <div className={styles.cardHead}>
        <h2>{provider.name}</h2>
        {stateChip && (
          <span className={`status-chip ${stateChip}`}>
            {provider.status === 'used_up' ? 'Used up' : 'Unknown'}
          </span>
        )}
        {provider.plan && (
          <span className={styles.muted}>{provider.plan} plan</span>
        )}
      </div>
      {provider.summary && (
        <p className={styles.summary}>{provider.summary}.</p>
      )}
      {provider.problem && (
        <p className={styles.problem}>
          Couldn’t read it fully: {provider.problem}.
        </p>
      )}
      {provider.windows.length > 0 ? (
        <ul className={styles.windows} aria-label="Windows">
          {provider.windows.map((window) => (
            <WindowRow key={window.label} window={window} />
          ))}
        </ul>
      ) : (
        <p className={styles.spendNote}>
          No usage windows read yet for {provider.name}.
        </p>
      )}
      {provider.credits && (
        <p className={styles.credits}>{sentence(provider.credits.text)}.</p>
      )}
      <Spend provider={provider} now={now} />
    </section>
  )
}

function WindowRow({ window }: { window: UsageWindow }) {
  const unknown = window.state === 'unknown'
  const used = window.state === 'used_up'
  const left = used ? 0 : (window.left_percent ?? 0)
  const gone = windowGone(window)
  return (
    <li>
      <span className={styles.windowText}>{sentence(window.text)}</span>
      <div
        className={`${styles.bar}${unknown ? ` ${styles.unknown}` : ''}`}
        role="img"
        aria-label={
          unknown
            ? `${window.label}: unknown`
            : `${window.label}: ${left}% left${gone === null ? '' : `, ${Math.round(gone * 100)}% of the window gone`}`
        }
      >
        {!unknown && <span style={{ width: `${left}%` }} />}
        {!unknown && gone !== null && (
          <i className={styles.tick} style={{ left: `${gone * 100}%` }} />
        )}
      </div>
    </li>
  )
}

function Spend({ provider, now }: { provider: UsageProvider; now: number }) {
  const { unit, days } = provider.spend
  if (!unit)
    return (
      <div className={styles.spend}>
        <h3>Spend per day</h3>
        <p className={styles.spendNote}>
          Spend isn’t recorded for {provider.name}.
        </p>
      </div>
    )
  const today = localDay(now)
  const heights = barHeights(days, unit)
  const { total, peak, recordedDays } = summarize(days, unit)
  const slot = 20
  const width = slot * days.length
  const unrecorded = days.length - recordedDays
  return (
    <div className={styles.spend}>
      <h3>{unitCaption(unit)}</h3>
      <p className={`${styles.figures} ${styles.muted}`}>
        <span>
          {recordedDays} days: {compact(total)} {unit}
        </span>
        <span>
          Most in a day: {compact(peak)} {unit}
        </span>
      </p>
      <svg
        className={styles.chart}
        viewBox={`0 0 ${width} 64`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${provider.name} ${unit} per day, ${days.length} days. ${total > 0 ? `${compact(total)} ${unit} in all, most in a day ${compact(peak)}.` : 'Nothing spent.'} The table below has each day.`}
      >
        {days.map((day, i) => {
          const h = heights[i]
          const x = i * slot + 3
          const tip = dayText(day, unit, today)
          if (h === null)
            return (
              <rect
                key={day.day}
                className={styles.gap}
                x={x}
                y={61}
                width={slot - 6}
                height={2}
                rx={1}
              >
                <title>{tip}</title>
              </rect>
            )
          const barH = Math.max(h * 60, dayValue(day, unit) ? 2 : 0)
          return (
            <rect
              key={day.day}
              className={day.day === today ? styles.today : styles.bar1}
              x={x}
              y={62 - barH}
              width={slot - 6}
              height={barH}
              rx={2}
            >
              <title>{tip}</title>
            </rect>
          )
        })}
      </svg>
      <div className={styles.axis} aria-hidden="true">
        <span>{dayLabel(days[0]?.day ?? today, today)}</span>
        <span>Today</span>
      </div>
      {unrecorded > 0 && (
        <p className={styles.spendNote}>
          Spend isn’t recorded for {provider.name} before{' '}
          {dayLabel(provider.spend.recorded_since ?? today, today)}.
        </p>
      )}
      <details className={styles.table}>
        <summary>Show each day</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">{unit === 'credits' ? 'Credits' : 'Tokens'}</th>
              <th scope="col">Requests</th>
            </tr>
          </thead>
          <tbody>
            {[...days].reverse().map((day) => {
              const value = dayValue(day, unit)
              return (
                <tr key={day.day}>
                  <th scope="row">{dayLabel(day.day, today)}</th>
                  <td>{value === null ? 'Not recorded' : compact(value)}</td>
                  <td>
                    {value === null
                      ? '—'
                      : day.requests.toLocaleString('en-US')}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </details>
    </div>
  )
}
