'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useClock } from '@/lib/hooks/use-clock'
import { useHosts } from '@/lib/hooks/use-hosts'
import { useMediaQuery } from '@/lib/hooks/use-media-query'
import { useProjectSettings } from '@/lib/hooks/use-project-settings'
import { useStatus } from '@/lib/hooks/use-status'
import { useStatusSessions } from '@/lib/hooks/use-status-sessions'
import { machineCount } from '@/lib/machines'
import {
  type ActionContext,
  isCounted,
  matches,
  NO_FILTER,
  rollup,
  type Shown,
  type StatusFilter,
  sortRows,
} from '@/lib/status'
import { StatusBody } from './StatusBody'
import { FilterBar, filterOptions, RollupChips } from './StatusFilterControls'
import { SearchHead, StatusHeader, statusSub } from './StatusHeader'
import { StatusNotices } from './StatusNotices'
import { StatusOverlays } from './StatusOverlays'
import { type Sheet, useStatusActions } from './use-status-actions'

/** The page width at which rows fold as on a phone (the frame's narrow-column rule in globals.css). */
const NARROW_PX = 760

type Mode = 'loading' | 'failed' | 'empty' | 'live'

/** Whether the page element is narrow, as in Wide's second column; re-watched when the element changes. */
function useNarrowColumn(watched: unknown) {
  const pageRef = useRef<HTMLElement>(null)
  const [narrowColumn, setNarrowColumn] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: the page element changes when the phone's search opens
  useEffect(() => {
    const page = pageRef.current
    if (!page || typeof ResizeObserver === 'undefined') return
    const watch = new ResizeObserver(([entry]) =>
      setNarrowColumn(entry.contentRect.width <= NARROW_PX),
    )
    watch.observe(page)
    return () => watch.disconnect()
  }, [watched])
  return { pageRef, narrowColumn }
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
  const [offOpen, setOffOpen] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [sheet, setSheet] = useState<Sheet>(null)
  const [searching, setSearching] = useState(false)
  const { starting, toast, say, act } = useStatusActions(sessions, setSheet)
  // A row folds as on a phone when the page is narrow: in Wide's second column too, where a row opens
  // its detail sheet for the text and the actions.
  const { pageRef, narrowColumn } = useNarrowColumn(searching)
  const narrow = phone || narrowColumn

  useEffect(() => setFilter((current) => ({ ...current, project })), [project])

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
  const problemCount = shown.filter(isCounted).length

  const patch = (next: Partial<StatusFilter>) =>
    setFilter((current) => ({ ...current, ...next }))
  const clear = () => setFilter({ ...NO_FILTER, project, sort: filter.sort })
  const showAll = () => setFilter({ ...NO_FILTER, sort: filter.sort })
  const toggleState = (state: Shown) =>
    patch({
      states: filter.states.includes(state)
        ? filter.states.filter((item) => item !== state)
        : [...filter.states, state],
    })
  const toggle = (row: { id: string }) => {
    if (narrow) return setSheet({ kind: 'row', id: row.id })
    setOpenId((current) => (current === row.id ? null : row.id))
  }

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
  const options = filterOptions(all, projects, filter.project)

  const body = (
    <StatusBody
      mode={mode}
      all={all}
      shown={shown}
      filter={filter}
      project={project}
      now={now}
      openId={openId}
      running={running}
      context={context}
      healthyOpen={healthyOpen}
      offOpen={offOpen}
      onHealthyOpen={setHealthyOpen}
      onOffOpen={setOffOpen}
      onToggle={toggle}
      onAction={act}
      onClear={clear}
    />
  )
  const closeSheet = () => setSheet(null)
  const overlays = (
    <StatusOverlays
      sheet={sheet}
      sheetRow={
        sheet && 'id' in sheet
          ? all.find((row) => row.id === sheet.id)
          : undefined
      }
      phone={phone}
      now={now}
      running={running}
      context={context}
      sessions={sessions}
      projects={projects}
      filter={filter}
      project={project}
      filterOptions={options}
      toast={toast}
      onAction={act}
      onFilterChange={patch}
      onFilterClear={() =>
        setFilter({ ...NO_FILTER, project, search: filter.search })
      }
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
  )

  // The phone with search open: the header gives way to the field and a count.
  if (phone && searching)
    return (
      <main className="status-page" ref={pageRef}>
        <SearchHead
          search={filter.search}
          matches={shown.length}
          problems={problemCount}
          onChange={(next) => patch({ search: next })}
          onCancel={() => {
            setSearching(false)
            patch({ search: '' })
          }}
        />
        <div className="status">{body}</div>
        {overlays}
      </main>
    )

  return (
    <main className="status-page" ref={pageRef}>
      <div className="status">
        <StatusHeader
          project={project}
          pickedProject={filter.project}
          filtered={filtered}
          active={active}
          sub={statusSub({
            mode,
            stale,
            readAt,
            now,
            narrowed,
            shownCount: shown.length,
            inProject: inProject.length,
            machines: machineCount(inProject),
          })}
          onShowAll={showAll}
          onSearch={() => setSearching(true)}
          onFilters={() => setSheet({ kind: 'filters' })}
        />
        <RollupChips
          mode={mode}
          counts={rollup(scope)}
          states={filter.states}
          onToggle={toggleState}
        />
        <StatusNotices
          mode={mode}
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
        {mode === 'live' && (
          <FilterBar
            filter={filter}
            project={project}
            options={options}
            filtered={filtered}
            onChange={patch}
            onClear={clear}
          />
        )}
        {body}
      </div>
      {overlays}
    </main>
  )
}
