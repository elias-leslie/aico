'use client'

import { useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  ChevronDown,
  ListFilter,
  RefreshCw,
  Search,
  Server,
} from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState } from 'react'
import { HostsSheet } from '@/components/HostsSheet'
import { ApiError, apiFetch } from '@/lib/api-fetch'
import { useClock } from '@/lib/hooks/use-clock'
import { useHosts } from '@/lib/hooks/use-hosts'
import { useMediaQuery } from '@/lib/hooks/use-media-query'
import { useProjectSettings } from '@/lib/hooks/use-project-settings'
import { STATUS_QUERY_KEY, useStatus } from '@/lib/hooks/use-status'
import {
  RECOVERY_QUERY_KEY,
  useStatusSessions,
} from '@/lib/hooks/use-status-sessions'
import {
  type ActionContext,
  at,
  type ButtonKind,
  isProblem,
  KINDS,
  lookProject,
  matches,
  NO_FILTER,
  PROBLEMS,
  plural,
  rollup,
  type Shown,
  SORTS,
  type Sort,
  type StatusFilter,
  type StatusRow,
  silentMachines,
  sortRows,
  stateCount,
  when,
} from '@/lib/status'
import { ActionButtons, Meaning, StateChip, StatusRowItem } from './StatusRow'
import { LogSheet, LookSheet, StatusSheet } from './StatusSheets'

/** Status lives in the aico project: a row with no project of its own is looked into there. */
const HOME_PROJECT = 'aico'
const TOAST_MS = 2_600
/** The page width at which rows fold as on a phone (the frame's narrow-column rule in globals.css). */
const NARROW_PX = 760

type Mode = 'loading' | 'failed' | 'empty' | 'live'
type Sheet =
  | { kind: 'row'; id: string }
  | { kind: 'log'; id: string }
  | { kind: 'look'; id: string }
  | { kind: 'filters' }
  | { kind: 'hosts' }
  | null

interface Toast {
  text: string
  href?: string
}

function Select({
  name,
  value,
  options,
  all,
  onChange,
}: {
  name: string
  value: string
  options: readonly (readonly [string, string])[]
  all: string
  onChange: (value: string) => void
}) {
  return (
    <select
      className={`status-select${value ? ' set' : ''}`}
      aria-label={all}
      data-f={name}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">{all}</option>
      {options.map(([option, text]) => (
        <option key={option} value={option}>
          {text}
        </option>
      ))}
    </select>
  )
}

/** The Status screen: every row, problems first; `project` fixes the project filter (a project's page). */
export function StatusPage({
  project = '',
  search = '',
  kind = '',
}: {
  project?: string
  /** Opening search, as in /status?q=usage (the quota rows). */
  search?: string
  /** Opening kind, as in /status?kind=machine. */
  kind?: string
}) {
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
  const phone = useMediaQuery('(max-width: 767px)')
  const router = useRouter()
  const queryClient = useQueryClient()
  const sessions = useStatusSessions()
  const { hosts } = useHosts()
  const { projects } = useProjectSettings()
  const [filter, setFilter] = useState<StatusFilter>({
    ...NO_FILTER,
    project,
    search,
    kind,
  })
  const [healthyOpen, setHealthyOpen] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  // Runs this page started and is waiting on; the server's list covers the rest.
  const [starting, setStarting] = useState<ReadonlySet<string>>(new Set())
  const [sheet, setSheet] = useState<Sheet>(null)
  const [searching, setSearching] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  )
  // A row folds as on a phone when the page is narrow: in Wide's second column too, where a row opens
  // its detail sheet for the text and the actions.
  const pageRef = useRef<HTMLElement>(null)
  const [narrowColumn, setNarrowColumn] = useState(false)
  const narrow = phone || narrowColumn

  useEffect(() => setFilter((current) => ({ ...current, project })), [project])
  useEffect(() => () => clearTimeout(toastTimer.current), [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: the page element changes when the phone's search opens
  useEffect(() => {
    const page = pageRef.current
    if (!page || typeof ResizeObserver === 'undefined') return
    const watch = new ResizeObserver(([entry]) =>
      setNarrowColumn(entry.contentRect.width <= NARROW_PX),
    )
    watch.observe(page)
    return () => watch.disconnect()
  }, [searching])

  const all = view?.rows ?? []
  const running = new Set([...starting, ...(view?.running ?? [])])
  const mode: Mode = loading
    ? 'loading'
    : failed
      ? 'failed'
      : all.length === 0
        ? 'empty'
        : 'live'
  const context: ActionContext = useMemo(
    () => ({
      here: view?.machine,
      hosts: new Set(hosts.map((host) => host.name)),
      sessions,
    }),
    [view?.machine, hosts, sessions],
  )
  const scope = all.filter((row) => matches(row, filter, false))
  const shown = sortRows(
    scope.filter((row) => matches(row, filter)),
    filter.sort,
  )
  const problems = shown.filter((row) => isProblem(row.shown))
  const healthy = shown.filter((row) => !isProblem(row.shown))
  const counts = rollup(scope)
  const healthyCounts = rollup(healthy)
  const find = (id: string) => all.find((row) => row.id === id)

  const say = (next: Toast) => {
    clearTimeout(toastTimer.current)
    setToast(next)
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS)
  }
  const patch = (next: Partial<StatusFilter>) =>
    setFilter((current) => ({ ...current, ...next }))
  const clear = () => setFilter({ ...NO_FILTER, project, sort: filter.sort })
  const toggleState = (state: Shown) =>
    patch({
      states: filter.states.includes(state)
        ? filter.states.filter((item) => item !== state)
        : [...filter.states, state],
    })

  const run = async (row: StatusRow) => {
    setStarting((current) => new Set(current).add(row.id))
    try {
      const ran = await apiFetch<{ state: string; lines: string[] }>(
        '/api/status/run',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: row.id }),
        },
        'Couldn’t run it',
      )
      if (ran.state === 'failed')
        say({
          text: `“${row.what}” didn’t run: ${ran.lines.at(-1) ?? 'it ended with an error.'}`,
        })
      else
        say({ text: `Started “${row.what}”. The row updates when it reports.` })
    } catch (error) {
      say({
        text:
          error instanceof ApiError && error.status === 409
            ? `“${row.what}” is still running. The row updates when it reports.`
            : `“${row.what}” didn’t run: ${(error as Error).message}`,
      })
    } finally {
      // Read the rows again first: the server's running list takes over without a flicker.
      await queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY })
      setStarting((current) => {
        const next = new Set(current)
        next.delete(row.id)
        return next
      })
    }
  }
  const resume = async (id: string) => {
    const name = sessions.names?.get(id) ?? 'The session'
    try {
      const answer = await apiFetch<{
        results: { ok: boolean; reason: string | null }[]
      }>(
        '/api/recovery/resume',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        },
        'Couldn’t resume it',
      )
      const failed = answer.results.find((result) => !result.ok)
      say({
        text: failed
          ? `“${name}” didn’t resume: ${failed.reason ?? 'Tether refused it.'}`
          : `Resuming “${name}”. It’s back in your session list in a moment.`,
        href: failed ? undefined : `/?session=${encodeURIComponent(id)}`,
      })
    } catch (error) {
      say({ text: `“${name}” didn’t resume: ${(error as Error).message}` })
    } finally {
      await queryClient.invalidateQueries({ queryKey: RECOVERY_QUERY_KEY })
      await queryClient.invalidateQueries({ queryKey: ['terminal-sessions'] })
    }
  }
  const act = (kind: ButtonKind, row: StatusRow, ref: string) => {
    if (kind === 'run') return void run(row)
    if (kind === 'hosts') return setSheet({ kind: 'hosts' })
    if (kind === 'resume') return void resume(ref)
    if (kind === 'open')
      return router.push(`/?session=${encodeURIComponent(ref)}`)
    if (kind === 'log' || kind === 'look') return setSheet({ kind, id: row.id })
  }
  const toggle = (row: StatusRow) => {
    if (narrow) return setSheet({ kind: 'row', id: row.id })
    setOpenId((current) => (current === row.id ? null : row.id))
  }

  const machines = [...new Set(all.map((row) => row.machine))].sort()
  const projectIds = [
    ...new Set(all.map((row) => row.project).filter(Boolean) as string[]),
  ].sort()
  const active =
    filter.states.length +
    (filter.kind ? 1 : 0) +
    (filter.machine ? 1 : 0) +
    (filter.project && !project ? 1 : 0)
  const filtered = active > 0 || !!filter.search.trim()
  // The project in view: the project page's, or one picked in the filters.
  const inProject = filter.project
    ? all.filter((row) => row.project === filter.project)
    : all
  const narrowed =
    filter.states.length > 0 ||
    !!filter.kind ||
    !!filter.machine ||
    !!filter.search.trim()
  const showAll = () => setFilter({ ...NO_FILTER, sort: filter.sort })

  const sub =
    mode === 'loading'
      ? 'Loading…'
      : mode === 'failed'
        ? 'Not loaded'
        : mode === 'empty'
          ? 'No rows yet'
          : stale
            ? `As of ${at(readAt, now)} · couldn’t refresh`
            : narrowed
              ? `${shown.length} of ${plural(inProject.length, 'row')} · updated ${at(readAt, now)}`
              : `${plural(inProject.length, 'row')} from ${plural(new Set(inProject.map((row) => row.machine)).size, 'machine')} · updated ${at(readAt, now)}`

  const rollupChips =
    mode === 'live' ? (
      <div className="status-rollup" role="group" aria-label="Filter by state">
        {PROBLEMS.map((state) => (
          <button
            key={state}
            type="button"
            className={`status-chip ${state}${counts[state] ? '' : ' zero'}`}
            aria-pressed={filter.states.includes(state)}
            onClick={() => toggleState(state)}
          >
            {stateCount(state, counts[state])}
          </button>
        ))}
        {(['ok', 'off'] as const).map((state) => (
          <button
            key={state}
            type="button"
            className={`status-chip ${state}`}
            aria-pressed={filter.states.includes(state)}
            onClick={() => toggleState(state)}
          >
            {stateCount(state, counts[state])}
          </button>
        ))}
      </div>
    ) : (
      <div className="status-rollup" aria-label="Rollup">
        {PROBLEMS.map((state) => (
          <span key={state} className={`status-chip ${state} zero`}>
            {mode === 'empty'
              ? stateCount(state, 0)
              : stateCount(state, 0).replace(/^0/, '—')}
          </span>
        ))}
        <span className="status-chip ok zero">
          {mode === 'empty' ? '0' : '—'} healthy
        </span>
      </div>
    )

  const silent = silentMachines(all)
  const notices = (
    <>
      {mode === 'failed' && (
        <div className="status-notice bad" role="alert">
          <p>
            <b>Couldn’t load status.</b> The Aico server didn’t answer at{' '}
            {at(failedAt, now)}. Nothing here counts as healthy until it does.
          </p>
          <button
            type="button"
            className="lantern-btn small"
            disabled={refreshing}
            onClick={() => void refetch()}
          >
            <RefreshCw
              className="h-3.5 w-3.5"
              strokeWidth={1.7}
              aria-hidden="true"
            />
            {refreshing ? 'Trying…' : 'Try again'}
          </button>
        </div>
      )}
      {mode === 'live' &&
        silent.map((machine) => (
          <div
            key={machine.machine}
            className="status-notice wait"
            role="status"
          >
            <p>
              <b>{machine.machine} isn’t answering.</b> No word since{' '}
              {at(machine.since ? Date.parse(machine.since) : null, now)}, so
              its {plural(machine.rows, 'row')}{' '}
              {machine.rows === 1 ? 'shows' : 'show'} unknown. The rest are
              current.
            </p>
            {context.hosts.has(machine.machine) && (
              <button
                type="button"
                className="lantern-btn small primary"
                onClick={() => setSheet({ kind: 'hosts' })}
              >
                <Server
                  className="h-3.5 w-3.5"
                  strokeWidth={1.7}
                  aria-hidden="true"
                />
                Hosts
              </button>
            )}
          </div>
        ))}
      {stale && (
        <div className="status-notice wait" role="status">
          <p>
            <b>
              Showing status from {at(readAt, now)},{' '}
              {readAt
                ? `${Math.max(1, Math.round((now - readAt) / 60_000))} min ago`
                : ''}
              .
            </b>{' '}
            Couldn’t refresh: no connection to Aico. States may have changed
            since.
          </p>
          <button
            type="button"
            className="lantern-btn small"
            disabled={refreshing}
            onClick={() => void refetch()}
          >
            <RefreshCw
              className="h-3.5 w-3.5"
              strokeWidth={1.7}
              aria-hidden="true"
            />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      )}
    </>
  )

  const searchField = (autoFocus: boolean) => (
    <label className="lantern-field status-search">
      <Search className="h-4 w-4" strokeWidth={1.7} aria-hidden="true" />
      <input
        type="search"
        placeholder="Search rows"
        aria-label="Search rows"
        value={filter.search}
        // biome-ignore lint/a11y/noAutofocus: the phone's search opens to type in it
        autoFocus={autoFocus}
        onChange={(event) => patch({ search: event.target.value })}
      />
    </label>
  )

  const kindOptions = KINDS.map((kind) => [kind, kind] as const)
  const machineOptions = machines.map((machine) => [machine, machine] as const)
  const projectOptions = projectIds.map((id) => [id, id] as const)
  const sortSelect = (
    <select
      className="status-select"
      aria-label="Sort"
      value={filter.sort}
      onChange={(event) => patch({ sort: event.target.value as Sort })}
    >
      {SORTS.map(([value, text]) => (
        <option key={value} value={value}>
          {text}
        </option>
      ))}
    </select>
  )

  const rowsOf = (list: StatusRow[]) => (
    <div className="status-rows">
      {list.map((row) => (
        <StatusRowItem
          key={row.id}
          row={row}
          now={now}
          open={openId === row.id}
          running={running.has(row.id)}
          context={context}
          onToggle={toggle}
          onAction={act}
        />
      ))}
    </div>
  )

  const showHealthy =
    healthyOpen ||
    !!filter.search.trim() ||
    filter.states.includes('ok') ||
    filter.states.includes('off') ||
    (!problems.length && filter.states.length > 0)

  let body: React.ReactNode
  if (mode === 'loading')
    body = (
      <>
        <p className="status-muted">Loading status…</p>
        <div className="status-rows skeleton" aria-hidden="true">
          {[30, 45, 25].map((width) => (
            <div key={width} className="status-row">
              <div>
                <span className="bar pill" />
              </div>
              <div>
                <div className="bar" style={{ width: `${width}%` }} />
                <div className="bar dim" style={{ width: `${width + 20}%` }} />
              </div>
              <div className="when">—</div>
            </div>
          ))}
        </div>
      </>
    )
  else if (mode === 'failed')
    body = (
      <div className="status-rows">
        <div className="status-empty">
          <h3>No rows to show</h3>
          The list comes back when the server answers.
        </div>
      </div>
    )
  else if (mode === 'empty')
    body = (
      <div className="status-rows">
        <div className="status-empty">
          <h3>No rows yet</h3>
          Each check, job, backup and service adds its row the first time it
          reports.
          <br />
          Nothing has reported to this Aico so far.
        </div>
      </div>
    )
  else if (!shown.length)
    body = (
      <div className="status-rows">
        <div className="status-empty">
          <h3>Nothing matches</h3>
          {plural(
            all.filter((row) => !project || row.project === project).length,
            'row',
          )}{' '}
          hidden by these filters.{' '}
          <button
            type="button"
            className="lantern-btn ghost small"
            onClick={clear}
          >
            Clear filters
          </button>
        </div>
      </div>
    )
  else
    body = (
      <>
        {problems.length > 0 ? (
          <section className="status-group" aria-label="Problems">
            <div className="lantern-sec">
              Problems <span className="n">{problems.length}</span>
            </div>
            {rowsOf(problems)}
          </section>
        ) : (
          !filter.states.length &&
          !filter.search.trim() && (
            <div className="status-rows">
              <div className="status-empty compact">
                <h3>No problems</h3>
              </div>
            </div>
          )
        )}
        {healthy.length > 0 && (
          <section className="status-group" aria-label="Healthy">
            <button
              type="button"
              className="status-fold"
              aria-expanded={showHealthy}
              onClick={() => setHealthyOpen(!showHealthy)}
            >
              <span>
                <b>{healthy.length} healthy</b>{' '}
                <span className="status-muted">
                  ·{' '}
                  {[
                    healthyCounts.ok && `${healthyCounts.ok} OK`,
                    healthyCounts.off && `${healthyCounts.off} off`,
                  ]
                    .filter(Boolean)
                    .join(', ')}
                </span>
              </span>
              <ChevronDown
                className="h-4 w-4"
                strokeWidth={1.7}
                aria-hidden="true"
              />
            </button>
            {showHealthy && rowsOf(healthy)}
          </section>
        )}
      </>
    )

  const sheetRow = sheet && 'id' in sheet ? find(sheet.id) : undefined
  const closeSheet = () => setSheet(null)
  const overlays = (
    <>
      {sheet?.kind === 'row' && sheetRow && (
        <StatusSheet
          open
          onOpenChange={(open) => !open && closeSheet()}
          title={sheetRow.what}
          place={phone ? 'bottom' : 'center'}
          testId="status-row-sheet"
        >
          <div className="status-sheet-meta">
            <StateChip
              state={running.has(sheetRow.id) ? 'running' : sheetRow.shown}
            />
            <span>
              {sheetRow.kind} · {sheetRow.machine}
              {sheetRow.project ? ` · ${sheetRow.project}` : ''}
            </span>
          </div>
          <p className="status-sheet-lead">
            <Meaning row={sheetRow} names={sessions.names} />
          </p>
          <p className="status-sheet-note">
            {when(sheetRow, now).lead}
            {when(sheetRow, now).sub && (
              <>
                <br />
                {when(sheetRow, now).sub}
              </>
            )}
          </p>
          <div className="status-sheet-acts">
            <ActionButtons
              row={sheetRow}
              context={context}
              big
              running={running.has(sheetRow.id)}
              onAction={act}
            />
          </div>
        </StatusSheet>
      )}
      {sheet?.kind === 'log' && sheetRow && (
        <LogSheet
          row={sheetRow}
          place={phone ? 'bottom' : 'side'}
          onClose={closeSheet}
        />
      )}
      {sheet?.kind === 'look' && sheetRow && (
        <LookSheet
          row={sheetRow}
          project={lookProject(sheetRow, projects, HOME_PROJECT)}
          place={phone ? 'bottom' : 'center'}
          onClose={closeSheet}
          onStarted={(session) => {
            closeSheet()
            say({
              text: 'Session started: it’s in your session list.',
              href: session
                ? `/?session=${encodeURIComponent(session)}`
                : undefined,
            })
          }}
        />
      )}
      {sheet?.kind === 'filters' && (
        <StatusSheet
          open
          onOpenChange={(open) => !open && closeSheet()}
          title="Filters"
          place="bottom"
          testId="status-filters"
          foot={
            <>
              <button
                type="button"
                className="lantern-btn ghost"
                onClick={() => {
                  setFilter({ ...NO_FILTER, project, search: filter.search })
                  closeSheet()
                }}
              >
                Clear
              </button>
              <button
                type="button"
                className="lantern-btn primary"
                onClick={closeSheet}
              >
                Show rows
              </button>
            </>
          }
        >
          <div className="status-filter-fields">
            <label>
              <span>Kind</span>
              <Select
                name="kind"
                value={filter.kind}
                options={kindOptions}
                all="All kinds"
                onChange={(kind) => patch({ kind })}
              />
            </label>
            <label>
              <span>Machine</span>
              <Select
                name="machine"
                value={filter.machine}
                options={machineOptions}
                all="All machines"
                onChange={(machine) => patch({ machine })}
              />
            </label>
            {!project && (
              <label>
                <span>Project</span>
                <Select
                  name="project"
                  value={filter.project}
                  options={projectOptions}
                  all="All projects"
                  onChange={(value) => patch({ project: value })}
                />
              </label>
            )}
            <label>
              <span>Sort</span>
              {sortSelect}
            </label>
          </div>
        </StatusSheet>
      )}
      {sheet?.kind === 'hosts' && (
        <HostsSheet open onOpenChange={(open) => !open && closeSheet()} />
      )}
      {toast && (
        <div className="status-toast" role="status">
          {toast.text}
          {toast.href && (
            <Link href={toast.href} className="status-toast-link">
              Open
            </Link>
          )}
        </div>
      )}
    </>
  )

  // The phone with search open: the header gives way to the field and a count.
  if (phone && searching)
    return (
      <main className="status-page" ref={pageRef}>
        <div className="status-kb-head">
          {searchField(true)}
          <button
            type="button"
            className="lantern-btn ghost"
            onClick={() => {
              setSearching(false)
              patch({ search: '' })
            }}
          >
            Cancel
          </button>
        </div>
        <div className="status-kb-meta">
          {plural(shown.length, 'match', 'matches')} ·{' '}
          {problems.length ? plural(problems.length, 'problem') : 'no problems'}
        </div>
        <div className="status">{body}</div>
        {overlays}
      </main>
    )

  return (
    <main className="status-page" ref={pageRef}>
      <div className="status">
        <header className="status-head">
          {project ? (
            <Link
              href="/status"
              className="lantern-icon-btn"
              aria-label="Back to Status"
              title="Back to Status"
              onClick={showAll}
            >
              <ArrowLeft className="h-[18px] w-[18px]" strokeWidth={1.7} />
            </Link>
          ) : filter.project || filtered ? (
            <button
              type="button"
              className="lantern-icon-btn"
              aria-label={
                filter.project ? 'Back to Status' : 'Back to all rows'
              }
              title={filter.project ? 'Back to Status' : 'Back to all rows'}
              onClick={showAll}
            >
              <ArrowLeft className="h-[18px] w-[18px]" strokeWidth={1.7} />
            </button>
          ) : null}
          {filter.project ? (
            <>
              <span className="crumb">
                <Link href="/status" onClick={showAll}>
                  Status
                </Link>{' '}
                /
              </span>
              <h1>{filter.project}</h1>
            </>
          ) : (
            <h1>Status</h1>
          )}
          <span className="sub">{sub}</span>
          <span className="tools phone-only">
            <button
              type="button"
              className="lantern-icon-btn"
              aria-label="Search"
              onClick={() => setSearching(true)}
            >
              <Search className="h-[18px] w-[18px]" strokeWidth={1.7} />
            </button>
            <button
              type="button"
              className="lantern-icon-btn"
              aria-label="Filters and sort"
              onClick={() => setSheet({ kind: 'filters' })}
            >
              <ListFilter className="h-[18px] w-[18px]" strokeWidth={1.7} />
              {active > 0 && <span className="dot">{active}</span>}
            </button>
          </span>
        </header>
        {rollupChips}
        {notices}
        {mode === 'live' && (
          <div className="status-filters">
            {searchField(false)}
            <Select
              name="kind"
              value={filter.kind}
              options={kindOptions}
              all="All kinds"
              onChange={(kind) => patch({ kind })}
            />
            <Select
              name="machine"
              value={filter.machine}
              options={machineOptions}
              all="All machines"
              onChange={(machine) => patch({ machine })}
            />
            {project ? (
              <span className="status-fixed">
                Project: <b>{project}</b>
              </span>
            ) : (
              <Select
                name="project"
                value={filter.project}
                options={projectOptions}
                all="All projects"
                onChange={(value) => patch({ project: value })}
              />
            )}
            <label className="status-sort">Sort {sortSelect}</label>
            {filtered && (
              <button
                type="button"
                className="lantern-btn ghost small"
                onClick={clear}
              >
                Clear filters
              </button>
            )}
          </div>
        )}
        {body}
      </div>
      {overlays}
    </main>
  )
}
