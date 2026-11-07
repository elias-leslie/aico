'use client'

import { Search } from 'lucide-react'
import { machineLabel } from '@/lib/machine-name'
import {
  KINDS,
  PROBLEMS,
  type Shown,
  SORTS,
  type Sort,
  type StatusFilter,
  stateCount,
} from '@/lib/status'
import { StatusSheet } from './StatusSheets'

type Option = readonly [string, string]
type Mode = 'loading' | 'failed' | 'empty' | 'live'

export interface FilterOptions {
  kinds: readonly Option[]
  machines: readonly Option[]
  projects: readonly Option[]
}

/** The values the filter menus offer, from the rows read and the projects Aico knows by name. */
export function filterOptions(
  rows: readonly { machine: string; project?: string | null }[],
  projects: readonly { id: string; name: string }[],
  picked: string,
): FilterOptions {
  const machines = [...new Set(rows.map((row) => row.machine))].sort()
  const projectIds = [
    ...new Set(rows.map((row) => row.project).filter(Boolean) as string[]),
  ].sort()
  // Only projects Aico knows by name: retired and test ones still have rows but are not filters.
  // The one picked stays listed; with the project list unread, every id is offered.
  const known = new Map(projects.map((item) => [item.id, item.name]))
  return {
    kinds: KINDS.map((kind) => [kind, kind] as const),
    machines: machines.map(
      (machine) => [machine, machineLabel(machine)] as const,
    ),
    projects: projectIds
      .filter((id) => known.has(id) || known.size === 0 || id === picked)
      .map((id) => [id, known.get(id) ?? id] as const),
  }
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
  options: readonly Option[]
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

function SortSelect({
  value,
  onChange,
}: {
  value: Sort
  onChange: (sort: Sort) => void
}) {
  return (
    <select
      className="status-select"
      aria-label="Sort"
      value={value}
      onChange={(event) => onChange(event.target.value as Sort)}
    >
      {SORTS.map(([option, text]) => (
        <option key={option} value={option}>
          {text}
        </option>
      ))}
    </select>
  )
}

export function SearchField({
  value,
  autoFocus,
  onChange,
}: {
  value: string
  autoFocus: boolean
  onChange: (search: string) => void
}) {
  return (
    <label className="lantern-field status-search">
      <Search className="h-4 w-4" strokeWidth={1.7} aria-hidden="true" />
      <input
        type="search"
        placeholder="Search rows"
        aria-label="Search rows"
        value={value}
        // biome-ignore lint/a11y/noAutofocus: the phone's search opens to type in it
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  )
}

/** The state counts: buttons that filter once rows are read, plain dashes before that. */
export function RollupChips({
  mode,
  counts,
  states,
  onToggle,
}: {
  mode: Mode
  counts: Record<Shown, number>
  states: Shown[]
  onToggle: (state: Shown) => void
}) {
  if (mode !== 'live')
    return (
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
  return (
    <div className="status-rollup" role="group" aria-label="Filter by state">
      {PROBLEMS.map((state) => (
        <button
          key={state}
          type="button"
          className={`status-chip ${state}${counts[state] ? '' : ' zero'}`}
          aria-pressed={states.includes(state)}
          onClick={() => onToggle(state)}
        >
          {stateCount(state, counts[state])}
        </button>
      ))}
      {(['ok', 'off'] as const).map((state) => (
        <button
          key={state}
          type="button"
          className={`status-chip ${state}`}
          aria-pressed={states.includes(state)}
          onClick={() => onToggle(state)}
        >
          {stateCount(state, counts[state])}
        </button>
      ))}
    </div>
  )
}

/** The wide page's filter row: search, the three menus (or the project the page is fixed to), sort. */
export function FilterBar({
  filter,
  project,
  options,
  filtered,
  onChange,
  onClear,
}: {
  filter: StatusFilter
  project: string
  options: FilterOptions
  filtered: boolean
  onChange: (next: Partial<StatusFilter>) => void
  onClear: () => void
}) {
  return (
    <div className="status-filters">
      <SearchField
        value={filter.search}
        autoFocus={false}
        onChange={(search) => onChange({ search })}
      />
      <Select
        name="kind"
        value={filter.kind}
        options={options.kinds}
        all="All kinds"
        onChange={(kind) => onChange({ kind })}
      />
      <Select
        name="machine"
        value={filter.machine}
        options={options.machines}
        all="All machines"
        onChange={(machine) => onChange({ machine })}
      />
      {project ? (
        <span className="status-fixed">
          Project: <b>{project}</b>
        </span>
      ) : (
        <Select
          name="project"
          value={filter.project}
          options={options.projects}
          all="All projects"
          onChange={(value) => onChange({ project: value })}
        />
      )}
      <label className="status-sort">
        Sort{' '}
        <SortSelect
          value={filter.sort}
          onChange={(sort) => onChange({ sort })}
        />
      </label>
      {filtered && (
        <button
          type="button"
          className="lantern-btn ghost small"
          onClick={onClear}
        >
          Clear filters
        </button>
      )}
    </div>
  )
}

/** The phone's Filters sheet: the same menus, with Clear and Show rows. */
export function FiltersSheet({
  filter,
  project,
  options,
  onChange,
  onClear,
  onClose,
}: {
  filter: StatusFilter
  project: string
  options: FilterOptions
  onChange: (next: Partial<StatusFilter>) => void
  onClear: () => void
  onClose: () => void
}) {
  return (
    <StatusSheet
      open
      onOpenChange={(open) => !open && onClose()}
      title="Filters"
      place="bottom"
      testId="status-filters"
      foot={
        <>
          <button
            type="button"
            className="lantern-btn ghost"
            onClick={() => {
              onClear()
              onClose()
            }}
          >
            Clear
          </button>
          <button
            type="button"
            className="lantern-btn primary"
            onClick={onClose}
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
            options={options.kinds}
            all="All kinds"
            onChange={(kind) => onChange({ kind })}
          />
        </label>
        <label>
          <span>Machine</span>
          <Select
            name="machine"
            value={filter.machine}
            options={options.machines}
            all="All machines"
            onChange={(machine) => onChange({ machine })}
          />
        </label>
        {!project && (
          <label>
            <span>Project</span>
            <Select
              name="project"
              value={filter.project}
              options={options.projects}
              all="All projects"
              onChange={(value) => onChange({ project: value })}
            />
          </label>
        )}
        <label>
          <span>Sort</span>
          <SortSelect
            value={filter.sort}
            onChange={(sort) => onChange({ sort })}
          />
        </label>
      </div>
    </StatusSheet>
  )
}
