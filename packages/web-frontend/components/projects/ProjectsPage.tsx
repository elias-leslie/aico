'use client'

import { useLayoutEffect, useRef, useState } from 'react'
import { useProjectOverview } from '@/lib/hooks/use-projects'
import { type ProblemKind, splitProjects } from '@/lib/projects'
import { ProjectDetail } from './ProjectDetail'
import { ProjectList } from './ProjectList'
import styles from './ProjectsPage.module.css'

/** Below this the list and the project take turns (the CSS container query uses the same 760). */
const NARROW_PX = 760

/** Whether the page's own box is narrow: a phone, or Wide, where the page gets what is left of the side. */
function useNarrow(ref: { current: HTMLElement | null }): boolean {
  const [narrow, setNarrow] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => {
      const width = el.getBoundingClientRect().width
      // 0 is not measured yet (or no layout), not narrow.
      setNarrow(width > 0 && width <= NARROW_PX)
    }
    read()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(read)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return narrow
}

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  })

/**
 * Projects: the list on the left and one project on the right; on a phone the list, then the
 * project with a way back. `selected` is the project in the address; `onSelect('')` goes back.
 */
export function ProjectsPage({
  selected,
  onSelect,
}: {
  selected: string
  onSelect: (id: string) => void
}) {
  const overview = useProjectOverview()
  const root = useRef<HTMLDivElement>(null)
  const phone = useNarrow(root)
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState<ProblemKind | 'agents' | null>(null)

  const projects = overview.data
  // A desktop always shows a project: the first one when none is picked.
  const first = projects ? splitProjects(projects, '').active[0]?.id : undefined
  const current = selected || (phone ? '' : (first ?? ''))

  return (
    <div
      ref={root}
      className={styles.page}
      data-screen={selected ? 'detail' : 'list'}
    >
      <ProjectList
        projects={projects}
        loading={overview.isPending}
        failed={overview.isError && !projects}
        staleAt={
          overview.isError && projects ? clock(overview.dataUpdatedAt) : null
        }
        currentId={current}
        onPick={(id, badge) => {
          setOpen(badge ?? null)
          onSelect(id)
        }}
        onRetry={() => void overview.refetch()}
        search={search}
        onSearch={setSearch}
      />
      <main className={styles.main}>
        {current && (
          <ProjectDetail
            key={current}
            id={current}
            openProblem={current === selected ? open : null}
            onBack={() => {
              setOpen(null)
              onSelect('')
            }}
          />
        )}
      </main>
    </div>
  )
}
