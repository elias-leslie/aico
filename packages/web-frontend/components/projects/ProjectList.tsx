'use client'

import { useState } from 'react'
import { useServerReach } from '@/lib/frame/server-reach'
import { useClock } from '@/lib/hooks/use-clock'
import {
  type ProblemKind,
  type ProjectSummary,
  shortAge,
  splitProjects,
} from '@/lib/projects'
import { AgentsBadge, Beacon, ProblemBadge, RunMark } from './Badges'
import styles from './ProjectsPage.module.css'

export type Pick = (id: string, open?: ProblemKind | 'agents') => void

function Row({
  project,
  current,
  now,
  onPick,
}: {
  project: ProjectSummary
  current: boolean
  now: number
  onPick: Pick
}) {
  const top = project.waiting
    ? `Waiting on you: ${project.waiting.title}`
    : (project.top ?? '')
  return (
    <div className={styles.row} data-current={current}>
      <button
        type="button"
        className={styles.pick}
        aria-current={current ? 'true' : undefined}
        onClick={() => onPick(project.id)}
      >
        {project.waiting ? <Beacon /> : <RunMark state={project.runState} />}
        <span className={styles.name} title={project.name}>
          {project.name}
        </span>
        <span className={styles.top} title={top}>
          {top}
        </span>
      </button>
      {(project.problems.length > 0 || project.agents > 0) && (
        <span className={styles.badges}>
          {project.problems.map((problem) => (
            <ProblemBadge
              key={problem.kind}
              kind={problem.kind}
              count={problem.count}
              worst={problem.worst}
              onClick={() => onPick(project.id, problem.kind)}
            />
          ))}
          {project.agents > 0 && (
            <AgentsBadge
              count={project.agents}
              onClick={() => onPick(project.id, 'agents')}
            />
          )}
        </span>
      )}
      <span className={styles.age}>{shortAge(project.lastActivity, now)}</span>
    </div>
  )
}

function Skeleton() {
  return (
    <div role="status" aria-label="Loading projects">
      {[0, 1, 2, 3, 4].map((n) => (
        <div key={n} className={styles.skelRow}>
          <div className={styles.skel} style={{ width: `${40 + n * 8}%` }} />
          <div className={styles.skel} style={{ width: '75%' }} />
        </div>
      ))}
    </div>
  )
}

export function ProjectList({
  projects,
  loading,
  failed,
  staleAt,
  currentId,
  onPick,
  onRetry,
  search,
  onSearch,
}: {
  projects: ProjectSummary[] | undefined
  loading: boolean
  /** No list at all. */
  failed: boolean
  /** The shown list is older than the last try (the refresh failed): when it was read. */
  staleAt: string | null
  currentId: string
  onPick: Pick
  onRetry: () => void
  search: string
  onSearch: (value: string) => void
}) {
  const now = useClock(30_000)
  // When the whole server is down the offline strip's Retry is the only one.
  const down = useServerReach().down
  const [archivedOpen, setArchivedOpen] = useState(false)
  const { active, archived } = splitProjects(projects ?? [], search)
  const searching = search.trim() !== ''
  const showArchived = archivedOpen || (searching && archived.length > 0)

  return (
    <aside className={styles.side}>
      <div className={styles.searchRow}>
        <input
          className={styles.search}
          type="search"
          placeholder="Find a project"
          aria-label="Find a project"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
        />
      </div>
      {staleAt && (
        <div className={`${styles.note} ${styles.stale}`}>
          Couldn’t refresh · as of {staleAt}
          {!down && (
            <button
              type="button"
              className="lantern-btn small"
              onClick={onRetry}
            >
              Retry
            </button>
          )}
        </div>
      )}
      <div className={styles.list}>
        {loading && <Skeleton />}
        {failed && (
          <div className={styles.note} role="alert">
            Couldn’t load projects
            {!down && (
              <button
                type="button"
                className="lantern-btn small"
                onClick={onRetry}
              >
                Retry
              </button>
            )}
          </div>
        )}
        {projects && projects.length === 0 && (
          <div className={styles.note}>No projects yet</div>
        )}
        {projects &&
          projects.length > 0 &&
          active.length + archived.length === 0 && (
            <div className={styles.note}>No project matches</div>
          )}
        {active.map((project) => (
          <Row
            key={project.id}
            project={project}
            current={project.id === currentId}
            now={now}
            onPick={onPick}
          />
        ))}
        {archived.length > 0 && (
          <>
            <button
              type="button"
              className={styles.group}
              aria-expanded={showArchived}
              onClick={() => setArchivedOpen((open) => !open)}
            >
              <span>Archived</span>
              <span>{archived.length}</span>
            </button>
            {showArchived &&
              archived.map((project) => (
                <Row
                  key={project.id}
                  project={project}
                  current={project.id === currentId}
                  now={now}
                  onPick={onPick}
                />
              ))}
          </>
        )}
      </div>
    </aside>
  )
}
