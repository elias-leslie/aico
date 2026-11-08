'use client'

import { clsx } from 'clsx'
import {
  Activity,
  CalendarDays,
  Clock,
  Database,
  Folder,
  Gauge,
  Server,
  StickyNote,
} from 'lucide-react'
import Link from 'next/link'
import type { ComponentType } from 'react'
import { shownProject } from '@/lib/frame/shown-project'
import { useMediaQuery } from '@/lib/hooks/use-media-query'
import { useStatus } from '@/lib/hooks/use-status'
import { plural } from '@/lib/status'
import { openFilesWindow, openNotes, workbenchTip } from '@/lib/workbench'
import styles from './Frame.module.css'

const MACHINES_HREF = '/machines'

interface Place {
  label: string
  href: string
  icon: ComponentType<{ className?: string; strokeWidth?: number }>
  /** Which address opens it as current (path, plus a query that sets it apart). */
  match: (path: string, query: URLSearchParams) => boolean
}

const onlyPath = (path: string) => (at: string, query: URLSearchParams) =>
  at === path && !query.get('q') && !query.get('kind')

/** Where Full digs, in the mockup's order: the daily ones, then the rest. */
const PLACES: readonly (readonly Place[])[] = [
  [
    {
      label: 'Status',
      href: '/status',
      icon: Activity,
      match: onlyPath('/status'),
    },
    {
      label: 'Projects',
      href: '/projects',
      icon: Folder,
      match: (path) => path === '/projects',
    },
    {
      label: 'Today',
      href: '/today',
      icon: CalendarDays,
      match: (path) => path === '/today',
    },
    {
      label: 'Recent',
      href: '/history',
      icon: Clock,
      match: (path) => path === '/history',
    },
    {
      label: 'Quota',
      href: '/quota',
      icon: Gauge,
      // The old address (/status?q=usage) still opens it.
      match: (path, query) =>
        path === '/quota' || (path === '/status' && query.get('q') === 'usage'),
    },
  ],
  [
    {
      label: 'Backups',
      href: '/backups',
      icon: Database,
      match: (path) => path.startsWith('/backups'),
    },
    {
      label: 'Machines',
      href: MACHINES_HREF,
      icon: Server,
      match: (path, query) =>
        path === '/machines' ||
        (path === '/status' && query.get('kind') === 'machine'),
    },
  ],
]

/** Full's side list: every place to dig, the chosen one marked. Notes opens
 * in its own window. */
export function SideList({
  pathname,
  query,
}: {
  pathname: string
  query: URLSearchParams
}) {
  const { view } = useStatus()
  // Files opens in a window beside Aico; a phone has none, and Files is in its session bar.
  const sideWindows = useMediaQuery('(pointer: fine)')
  const problems = view?.summary.problems
  const glance: Record<string, string | undefined> = {
    Status:
      problems === undefined
        ? undefined
        : problems
          ? plural(problems, 'problem')
          : 'all healthy',
  }
  return (
    <nav
      className={styles.sideList}
      aria-label="Everything else"
      data-testid="frame-side-list"
    >
      {PLACES.map((group, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed groups
        <div key={index} className={styles.sideGroup}>
          {group.map((place) => {
            const Icon = place.icon
            const current = place.match(pathname, query)
            return (
              <Link
                key={place.label}
                href={place.href}
                className={clsx(styles.sideItem)}
                aria-current={current ? 'page' : undefined}
              >
                <Icon className="h-4 w-4" strokeWidth={1.7} />
                {place.label}
                {glance[place.label] && (
                  <span className={styles.sideGlance}>
                    {glance[place.label]}
                  </span>
                )}
              </Link>
            )
          })}
          {index === 1 && (
            <button
              type="button"
              className={styles.sideItem}
              onClick={() => openNotes()}
              title={workbenchTip()}
            >
              <StickyNote className="h-4 w-4" strokeWidth={1.7} />
              Notes
            </button>
          )}
          {index === 1 && sideWindows && (
            <button
              type="button"
              className={styles.sideItem}
              onClick={() => openFilesWindow({ project: shownProject() })}
              title={workbenchTip()}
            >
              <Folder className="h-4 w-4" strokeWidth={1.7} />
              Files
            </button>
          )}
        </div>
      ))}
    </nav>
  )
}
