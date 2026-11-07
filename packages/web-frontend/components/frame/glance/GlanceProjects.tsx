'use client'

import { useState } from 'react'
import { useProjectOverview } from '@/lib/hooks/use-projects'
import {
  agentsText,
  PROBLEM_WORD,
  type ProjectSummary,
  problemText,
  problemTone,
  projectLine,
  splitProjects,
} from '@/lib/projects'
import styles from './Glance.module.css'
import type { GlanceHead } from './glance-types'

/** How many projects with something to say the glance lists, and how many quiet names it spells out. */
const BUSY_SHOWN = 5
const QUIET_SHOWN = 5

/** Projects for the Panel's heading: how many are active, or why that is not known. */
export function useProjectsGlance(): GlanceHead {
  const query = useProjectOverview()
  if (!query.data)
    return {
      count: null,
      line: query.isPending
        ? 'Loading projects…'
        : 'Projects couldn’t be read.',
    }
  return {
    count: `${splitProjects(query.data, '').active.length} active`,
    line: null,
  }
}

function Chips({ project }: { project: ProjectSummary }) {
  if (project.problems.length === 0 && project.agents === 0) return null
  return (
    <span className={styles.chips}>
      {project.problems.map((problem) => (
        <span
          key={problem.kind}
          className={`status-chip ${problemTone(problem.kind, problem.worst) === 'fail' ? 'failed' : 'warn'}`}
          title={problemText(problem.kind, problem.count, problem.worst)}
        >
          {problem.count} {PROBLEM_WORD[problem.kind]}
        </span>
      ))}
      {project.agents > 0 && (
        <span
          className="status-chip running"
          title={agentsText(project.agents)}
        >
          {project.agents} working
        </span>
      )}
    </span>
  )
}

/** Find a project, then each project with something to say: its key line and chips; the quiet ones share one line. */
export function GlanceProjects() {
  const query = useProjectOverview()
  const [search, setSearch] = useState('')
  const searching = search.trim() !== ''
  const projects = query.data ? splitProjects(query.data, search).active : null
  if (!projects)
    return (
      <p className={styles.note} role={query.isPending ? 'status' : 'alert'}>
        {query.isPending ? 'Loading projects…' : 'Projects couldn’t be read.'}
      </p>
    )
  // A search lists every match with its line; at rest, projects with nothing to say share one line.
  const busy = projects.filter((project) => searching || projectLine(project))
  const quiet = searching
    ? []
    : projects.filter((project) => !projectLine(project))
  const shown = busy.slice(0, searching ? busy.length : BUSY_SHOWN)
  const more =
    busy.length - shown.length + Math.max(0, quiet.length - QUIET_SHOWN)
  const tail = [
    quiet.length > 0
      ? `Quiet: ${quiet
          .slice(0, QUIET_SHOWN)
          .map((project) => project.name)
          .join(', ')}`
      : null,
    more > 0 ? `${more} more` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div data-stale={query.isError ? 'true' : undefined}>
      <label className={`lantern-field ${styles.find}`}>
        <input
          type="search"
          placeholder="Find a project"
          aria-label="Find a project"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      {projects.length === 0 ? (
        <p className={styles.note}>
          {searching ? 'No project matches.' : 'No active projects.'}
        </p>
      ) : (
        <ul className={styles.projects}>
          {shown.map((project) => {
            const line = projectLine(project)
            return (
              <li key={project.id}>
                <span className={styles.title}>{project.name}</span>
                {line && (
                  <span className={styles.detail} title={line}>
                    {line}
                  </span>
                )}
                <Chips project={project} />
              </li>
            )
          })}
          {tail && <li className={styles.quietLine}>{tail}</li>}
        </ul>
      )}
    </div>
  )
}
