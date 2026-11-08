'use client'

import { ArrowRight, ChevronRight, Eye, EyeOff, Home } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import type { FilePlace } from '@/lib/api/pane-files'
import type { SortBy } from './listing'

/** A folder path as breadcrumb parts: each with the folder it opens. */
function crumbsOf(path: string): { name: string; path: string }[] {
  const names = path.split('/').filter(Boolean)
  return names.map((name, index) => ({
    name,
    path: `/${names.slice(0, index + 1).join('/')}`,
  }))
}

/**
 * Where a folder is, from `/` down: every part opens that folder, so it goes
 * above a project's root as far as the top. The last part is where you are.
 */
export function Breadcrumb({
  path,
  onGo,
}: {
  path: string
  onGo: (path: string) => void
}) {
  const crumbs = crumbsOf(path)
  const strip = useRef<HTMLOListElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: the deepest part stays in view when the folder changes
  useEffect(() => {
    const node = strip.current
    if (node) node.scrollLeft = node.scrollWidth
  }, [path])
  return (
    <nav aria-label="Folder path" className="files-crumbs">
      <ol ref={strip}>
        <li>
          <button
            type="button"
            aria-label="Top folder, /"
            aria-current={crumbs.length === 0 ? 'location' : undefined}
            onClick={() => onGo('/')}
          >
            /
          </button>
        </li>
        {crumbs.map((crumb, index) => (
          <li key={crumb.path}>
            <ChevronRight
              aria-hidden="true"
              className="sep"
              strokeWidth={1.7}
            />
            <button
              type="button"
              aria-current={
                index === crumbs.length - 1 ? 'location' : undefined
              }
              onClick={() => onGo(crumb.path)}
            >
              {crumb.name}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  )
}

/**
 * Everywhere's controls: a box to jump to any absolute path (a file's folder
 * opens with the file chosen), and shortcuts to Home, scratch folders and what
 * agents shared.
 */
export function PlaceBar({
  path,
  places,
  placesFailed,
  sharedActive,
  onGo,
  onFolder,
  onShared,
}: {
  /** The folder shown now, or null when none is (Shared, a missing path). */
  path: string | null
  places: FilePlace[] | undefined
  placesFailed: boolean
  sharedActive: boolean
  /** A path the owner typed: a file or a folder, `~` allowed. */
  onGo: (path: string) => void
  /** A folder picked from a shortcut. */
  onFolder: (path: string) => void
  onShared: () => void
}) {
  const [typed, setTyped] = useState(path ?? '')
  // The box follows the folder you are in; typing replaces it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new folder resets what was typed
  useEffect(() => setTyped(path ?? ''), [path])
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const value = typed.trim()
    if (value) onGo(value)
  }
  return (
    <div className="files-bar">
      <form onSubmit={submit} className="files-go">
        <label className="lantern-field">
          <span className="sr-only">Go to a path</span>
          <input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder="Go to a path, like /tmp/out"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            style={{ fontFamily: 'var(--font-mono)' }}
          />
        </label>
        <button
          type="submit"
          className="lantern-btn primary"
          disabled={!typed.trim()}
        >
          Go
          <ArrowRight
            aria-hidden="true"
            className="h-3.5 w-3.5"
            strokeWidth={1.7}
          />
        </button>
      </form>
      <div className="files-chips" role="group" aria-label="Shortcuts">
        {places?.map((place) => (
          <button
            key={place.id}
            type="button"
            className="files-chip"
            aria-pressed={path === place.path}
            title={place.path}
            onClick={() => onFolder(place.path)}
          >
            {place.id === 'home' ? (
              <Home aria-hidden="true" strokeWidth={1.7} />
            ) : null}
            {place.label}
          </button>
        ))}
        <button
          type="button"
          className="files-chip"
          aria-pressed={sharedActive}
          onClick={onShared}
        >
          Shared
        </button>
        {placesFailed ? (
          <span className="files-chip-note">Shortcuts didn’t load</span>
        ) : null}
      </div>
    </div>
  )
}

/** How a folder of Everywhere is listed: the order, and whether dotfiles show. */
export function ListControls({
  sort,
  onSort,
  showHidden,
  onShowHidden,
  match,
  onMatch,
}: {
  sort: SortBy
  onSort: (sort: SortBy) => void
  showHidden: boolean
  onShowHidden: (show: boolean) => void
  match: string
  onMatch: (match: string) => void
}) {
  return (
    <div className="files-tools">
      <label className="lantern-field files-find">
        <span className="sr-only">Find in this folder</span>
        <input
          type="search"
          placeholder="Find in this folder"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={match}
          onChange={(event) => onMatch(event.target.value)}
        />
      </label>
      <fieldset aria-label="Sort by" className="lantern-seg compact">
        <button
          type="button"
          aria-pressed={sort === 'name'}
          onClick={() => onSort('name')}
        >
          Name
        </button>
        <button
          type="button"
          aria-pressed={sort === 'modified'}
          onClick={() => onSort('modified')}
        >
          Modified
        </button>
      </fieldset>
      <button
        type="button"
        className="lantern-btn small"
        aria-pressed={showHidden}
        onClick={() => onShowHidden(!showHidden)}
      >
        {showHidden ? (
          <Eye aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={1.7} />
        ) : (
          <EyeOff
            aria-hidden="true"
            className="h-3.5 w-3.5"
            strokeWidth={1.7}
          />
        )}
        Show hidden
      </button>
    </div>
  )
}
