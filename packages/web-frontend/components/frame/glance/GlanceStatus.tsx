'use client'

import { ChevronDown, ChevronRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useClock } from '@/lib/hooks/use-clock'
import { useHosts } from '@/lib/hooks/use-hosts'
import { useProjectSettings } from '@/lib/hooks/use-project-settings'
import { useStatus } from '@/lib/hooks/use-status'
import { useStatusSessions } from '@/lib/hooks/use-status-sessions'
import { machineLabel } from '@/lib/machine-name'
import { machineCount } from '@/lib/machines'
import {
  type ActionContext,
  type ButtonKind,
  isProblem,
  matches,
  NO_FILTER,
  plural,
  reason,
  rollup,
  type Shown,
  type StatusFilter,
  type StatusRow,
  sortRows,
  tierLabel,
  tierOf,
  when,
  withSessionNames,
} from '@/lib/status'
import { RollupChips, SearchField } from '../../status/StatusFilterControls'
import { statusSub } from '../../status/StatusHeader'
import { StatusNotices } from '../../status/StatusNotices'
import { StatusOverlays } from '../../status/StatusOverlays'
import { ActionButtons, Meaning, StateChip } from '../../status/StatusRow'
import { type Sheet, useStatusActions } from '../../status/use-status-actions'
import styles from './GlanceStatus.module.css'
import type { GlanceHead } from './glance-types'

/** Status for the collapsed row: the problem count as a chip of the worst state, or why there is none to show. */
export function useStatusGlance(): GlanceHead & { problems: number | null } {
  const { view, loading } = useStatus()
  const problems = view?.summary.problems ?? null
  if (problems === null)
    return {
      problems,
      value: loading ? 'Checking…' : 'Couldn’t read',
      tone: loading ? null : 'failed',
    }
  if (problems === 0) return { problems, value: 'All healthy', tone: 'ok' }
  const worst = view?.summary.top[0]?.shown
  return {
    problems,
    value: plural(problems, 'problem'),
    tone: worst && isProblem(worst) ? worst : 'warn',
  }
}

/** One row: its chip, name and why on one line; opened, the whole meaning, when, and the row's own actions. */
function StatusLine({
  row,
  now,
  open,
  running,
  context,
  onToggle,
  onAction,
}: {
  row: StatusRow
  now: number
  open: boolean
  running: boolean
  context: ActionContext
  onToggle: () => void
  onAction: (kind: ButtonKind, row: StatusRow, ref: string) => void
}) {
  const time = when(row, now)
  const Chevron = open ? ChevronDown : ChevronRight
  const why = withSessionNames(
    reason(row) || row.meaning,
    context.sessions?.names ?? null,
  )
  return (
    <li className={styles.row} data-open={open ? 'true' : undefined}>
      <button
        type="button"
        className={styles.head}
        aria-expanded={open}
        onClick={onToggle}
      >
        <Chevron className={styles.chevron} strokeWidth={1.7} aria-hidden />
        <StateChip state={running ? 'running' : row.shown} />
        <span className={styles.main}>
          <span className={styles.what}>{row.what}</span>
          {!open && (
            <span className={styles.why}>
              {machineLabel(row.machine)} · {why}
            </span>
          )}
        </span>
        <span
          className={styles.when}
          data-late={time.tone === 'late' ? 'true' : undefined}
        >
          {time.short}
        </span>
      </button>
      {open && (
        <div className={styles.more}>
          <p className={styles.meaning}>
            <Meaning row={row} names={context.sessions?.names} />
          </p>
          <dl className={styles.facts}>
            <dt>On</dt>
            <dd>
              {row.kind} · {machineLabel(row.machine)}
              {row.project ? ` · ${row.project}` : ''}
            </dd>
            <dt>{time.lead}</dt>
            <dd>{time.sub ?? ''}</dd>
            {isProblem(row.shown) && (
              <>
                <dt>Matters</dt>
                <dd>{tierLabel(tierOf(row))}</dd>
              </>
            )}
          </dl>
          <div className={styles.acts}>
            <ActionButtons
              row={row}
              context={context}
              running={running}
              onAction={onAction}
            />
          </div>
        </div>
      )}
    </li>
  )
}

function Fold({
  label,
  note,
  open,
  onToggle,
}: {
  label: string
  note?: string
  open: boolean
  onToggle: () => void
}) {
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <button
      type="button"
      className={styles.fold}
      aria-expanded={open}
      onClick={onToggle}
    >
      <Chevron className={styles.chevron} strokeWidth={1.7} aria-hidden />
      <b>{label}</b>
      {note && <span>{note}</span>}
    </button>
  )
}

/** Every row Status has, problems first: search and the state chips narrow them; a row opens in place for
 * its meaning and its own actions (run now, log, look into it, resume, open). Healthy and off rows fold. */
export function GlanceStatus() {
  const {
    view,
    loading,
    failed,
    stale,
    readAt,
    failedAt,
    refetch,
    refreshing,
  } = useStatus()
  const now = useClock(30_000)
  const sessions = useStatusSessions()
  const { hosts } = useHosts()
  const { projects } = useProjectSettings()
  const [filter, setFilter] = useState<StatusFilter>(NO_FILTER)
  const [openId, setOpenId] = useState<string | null>(null)
  const [healthyOpen, setHealthyOpen] = useState(false)
  const [offOpen, setOffOpen] = useState(false)
  const [sheet, setSheet] = useState<Sheet>(null)
  const { starting, toast, say, act } = useStatusActions(sessions, setSheet)
  const all = view?.rows ?? []
  const context: ActionContext = useMemo(
    () => ({
      here: view?.machine,
      hosts: new Set(hosts.map((host) => host.name)),
      sessions,
    }),
    [view?.machine, hosts, sessions],
  )
  if (!view)
    return (
      <p className={styles.note} role={loading ? 'status' : 'alert'}>
        {failed
          ? 'Status couldn’t be read. It comes back when the server answers.'
          : 'Checking Status…'}
      </p>
    )
  if (all.length === 0)
    return (
      <p className={styles.note}>
        No rows yet. Each check, job, backup and service adds its row the first
        time it reports.
      </p>
    )

  const running = new Set([...starting, ...(view.running ?? [])])
  const scope = all.filter((row) => matches(row, filter, false))
  const shown = sortRows(
    scope.filter((row) => matches(row, filter)),
    filter.sort,
  )
  const problems = shown.filter((row) => isProblem(row.shown))
  const healthy = shown.filter((row) => row.shown === 'ok')
  const off = shown.filter((row) => row.shown === 'off')
  const searching = !!filter.search.trim()
  const narrowed = searching || filter.states.length > 0
  const patch = (next: Partial<StatusFilter>) =>
    setFilter((current) => ({ ...current, ...next }))
  const toggleState = (state: Shown) =>
    patch({
      states: filter.states.includes(state)
        ? filter.states.filter((item) => item !== state)
        : [...filter.states, state],
    })
  const lines = (list: StatusRow[]) => (
    <ul className={styles.rows}>
      {list.map((row) => (
        <StatusLine
          key={row.id}
          row={row}
          now={now}
          open={openId === row.id}
          running={running.has(row.id)}
          context={context}
          onToggle={() =>
            setOpenId((current) => (current === row.id ? null : row.id))
          }
          onAction={act}
        />
      ))}
    </ul>
  )
  // Narrowing to a state or a search opens the groups it lands in.
  const showHealthy = healthyOpen || narrowed
  const showOff = offOpen || narrowed
  return (
    <div className={styles.status} data-stale={stale ? 'true' : undefined}>
      <p className={styles.sub}>
        {statusSub({
          mode: 'live',
          stale,
          readAt,
          now,
          narrowed,
          shownCount: shown.length,
          inProject: all.length,
          machines: machineCount(all),
        })}
      </p>
      <RollupChips
        mode="live"
        counts={rollup(scope)}
        states={filter.states}
        onToggle={toggleState}
      />
      <SearchField
        value={filter.search}
        autoFocus={false}
        onChange={(search) => patch({ search })}
      />
      <StatusNotices
        mode="live"
        rows={all}
        hostNames={context.hosts}
        stale={stale}
        readAt={readAt}
        failedAt={failedAt}
        now={now}
        refreshing={refreshing}
        onRefetch={() => void refetch()}
        onHosts={() => setSheet({ kind: 'hosts' })}
      />
      {shown.length === 0 ? (
        <p className={styles.note}>
          Nothing matches.{' '}
          <button
            type="button"
            className="lantern-btn ghost small"
            onClick={() => setFilter(NO_FILTER)}
          >
            Clear filters
          </button>
        </p>
      ) : (
        <>
          {problems.length > 0 ? (
            <section aria-label="Problems">
              <h3 className={styles.group}>
                Problems <span>{problems.length}</span>
              </h3>
              {lines(problems)}
            </section>
          ) : (
            !narrowed && <p className={styles.note}>No problems.</p>
          )}
          {healthy.length > 0 && (
            <section aria-label="Healthy">
              <Fold
                label={`${healthy.length} healthy`}
                open={showHealthy}
                onToggle={() => setHealthyOpen(!healthyOpen)}
              />
              {showHealthy && lines(healthy)}
            </section>
          )}
          {off.length > 0 && (
            <section aria-label="Off">
              <Fold
                label={`${off.length} off`}
                note="their machine is off, so nothing is reported"
                open={showOff}
                onToggle={() => setOffOpen(!offOpen)}
              />
              {showOff && lines(off)}
            </section>
          )}
        </>
      )}
      <StatusOverlays
        sheet={sheet}
        sheetRow={
          sheet && 'id' in sheet
            ? all.find((row) => row.id === sheet.id)
            : undefined
        }
        phone={false}
        now={now}
        running={running}
        context={context}
        sessions={sessions}
        projects={projects}
        filter={filter}
        project=""
        filterOptions={{ kinds: [], machines: [], projects: [] }}
        toast={toast}
        onAction={act}
        onFilterChange={patch}
        onFilterClear={() => setFilter(NO_FILTER)}
        onClose={() => setSheet(null)}
        onStarted={(session) => {
          setSheet(null)
          say({
            text: 'Session started: it’s in your session list.',
            href: session
              ? `/?session=${encodeURIComponent(session)}`
              : undefined,
          })
        }}
      />
    </div>
  )
}
