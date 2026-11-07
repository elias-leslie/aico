'use client'

import { ArrowLeft, ListFilter, Search } from 'lucide-react'
import Link from 'next/link'
import { at, plural } from '@/lib/status'
import { SearchField } from './StatusFilterControls'

type Mode = 'loading' | 'failed' | 'empty' | 'live'

/** The line beside the title: what is loaded, how fresh, or why it is not. */
export function statusSub({
  mode,
  stale,
  readAt,
  now,
  narrowed,
  shownCount,
  inProject,
  machines,
}: {
  mode: Mode
  stale: boolean
  readAt: number | null
  now: number
  /** A state, kind, machine or search is narrowing the rows. */
  narrowed: boolean
  shownCount: number
  /** The rows of the project in view. */
  inProject: number
  machines: number
}): string {
  if (mode === 'loading') return 'Loading…'
  if (mode === 'failed') return 'Not loaded'
  if (mode === 'empty') return 'No rows yet'
  if (stale) return `As of ${at(readAt, now)} · couldn’t refresh`
  if (narrowed)
    return `${shownCount} of ${plural(inProject, 'row')} · updated ${at(readAt, now)}`
  return `${plural(inProject, 'row')} from ${plural(machines, 'machine')} · updated ${at(readAt, now)}`
}

/** The page title with its way back, the project crumb, and the phone's Search and Filters buttons. */
export function StatusHeader({
  project,
  pickedProject,
  filtered,
  active,
  sub,
  onShowAll,
  onSearch,
  onFilters,
}: {
  /** The project the page is fixed to. */
  project: string
  /** The project filter in force (the page's, or one picked). */
  pickedProject: string
  filtered: boolean
  /** How many filters are set, for the phone's dot. */
  active: number
  sub: string
  onShowAll: () => void
  onSearch: () => void
  onFilters: () => void
}) {
  const back = pickedProject ? 'Back to Status' : 'Back to all rows'
  return (
    <header className="status-head">
      {project ? (
        <Link
          href="/status"
          className="lantern-icon-btn"
          aria-label="Back to Status"
          title="Back to Status"
          onClick={onShowAll}
        >
          <ArrowLeft className="h-[18px] w-[18px]" strokeWidth={1.7} />
        </Link>
      ) : pickedProject || filtered ? (
        <button
          type="button"
          className="lantern-icon-btn"
          aria-label={back}
          title={back}
          onClick={onShowAll}
        >
          <ArrowLeft className="h-[18px] w-[18px]" strokeWidth={1.7} />
        </button>
      ) : null}
      {pickedProject ? (
        <>
          <span className="crumb">
            <Link href="/status" onClick={onShowAll}>
              Status
            </Link>{' '}
            /
          </span>
          <h1>{pickedProject}</h1>
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
          onClick={onSearch}
        >
          <Search className="h-[18px] w-[18px]" strokeWidth={1.7} />
        </button>
        <button
          type="button"
          className="lantern-icon-btn"
          aria-label="Filters and sort"
          onClick={onFilters}
        >
          <ListFilter className="h-[18px] w-[18px]" strokeWidth={1.7} />
          {active > 0 && <span className="dot">{active}</span>}
        </button>
      </span>
    </header>
  )
}

/** The phone with search open: the header gives way to the field and a count. */
export function SearchHead({
  search,
  matches,
  problems,
  onChange,
  onCancel,
}: {
  search: string
  matches: number
  problems: number
  onChange: (search: string) => void
  onCancel: () => void
}) {
  return (
    <>
      <div className="status-kb-head">
        <SearchField value={search} autoFocus onChange={onChange} />
        <button type="button" className="lantern-btn ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <div className="status-kb-meta">
        {plural(matches, 'match', 'matches')} ·{' '}
        {problems ? plural(problems, 'problem') : 'no problems'}
      </div>
    </>
  )
}
