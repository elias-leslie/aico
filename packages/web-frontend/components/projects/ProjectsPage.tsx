'use client'

import { useState } from 'react'
import { useMediaQuery } from '@/lib/hooks/use-media-query'
import { useProjectOverview } from '@/lib/hooks/use-projects'
import { type ProblemKind, splitProjects } from '@/lib/projects'
import { ProjectDetail } from './ProjectDetail'
import { ProjectList } from './ProjectList'
import styles from './ProjectsPage.module.css'

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
  const phone = useMediaQuery('(max-width: 760px)')
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState<ProblemKind | 'agents' | null>(null)

  const projects = overview.data
  // A desktop always shows a project: the first one when none is picked.
  const first = projects ? splitProjects(projects, '').active[0]?.id : undefined
  const current = selected || (phone ? '' : (first ?? ''))

  return (
    <div className={styles.page} data-screen={selected ? 'detail' : 'list'}>
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
