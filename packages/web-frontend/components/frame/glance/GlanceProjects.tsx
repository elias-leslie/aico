'use client'

import { ChevronDown, ChevronRight } from 'lucide-react'
import Link from 'next/link'
import { useId, useState } from 'react'
import { Beacon, RunMark } from '@/components/projects/Badges'
import { Places } from '@/components/projects/ProjectDetail'
import { clock } from '@/lib/history'
import { useClock } from '@/lib/hooks/use-clock'
import { useProjectDetail, useProjectOverview } from '@/lib/hooks/use-projects'
import {
  agentsText,
  PROBLEM_WORD,
  type ProjectSummary,
  problemText,
  problemTone,
  projectLine,
  shortAge,
  splitProjects,
} from '@/lib/projects'
import { usePopoverClose } from '../RailPopover'
import notes from './Glance.module.css'
import styles from './GlanceProjects.module.css'
import type { GlanceHead } from './glance-types'

/** Projects for the section's collapsed row: how many are active, or why that is not known. */
export function useProjectsGlance(): GlanceHead {
  const query = useProjectOverview()
  if (!query.data)
    return query.isPending
      ? { value: 'Checking…', tone: null }
      : { value: 'Couldn’t read', tone: 'failed' }
  return {
    value: `${splitProjects(query.data, '').active.length} active`,
    tone: null,
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

/** What opens under a project: its overview, what is happening now, its places with their power controls,
 * every problem row, and the agents working on it. The roadmap's later lanes and the git history stay on
 * the Projects page. */
function ProjectInside({ id }: { id: string }) {
  const query = useProjectDetail(id)
  const now = useClock(30_000)
  const closePopout = usePopoverClose()
  const project = query.data
  if (!project)
    return (
      <div className={styles.detail}>
        {query.isError ? (
          <p className={notes.note} role="alert">
            Couldn’t load this project.
            <button
              type="button"
              className={`lantern-btn small ${styles.retry}`}
              onClick={() => void query.refetch()}
            >
              Retry
            </button>
          </p>
        ) : (
          <p className={notes.note} role="status">
            Loading project…
          </p>
        )}
      </div>
    )
  const empty =
    !project.overview &&
    project.now.length === 0 &&
    project.places.length === 0 &&
    project.problems.length === 0 &&
    project.agents.length === 0
  return (
    <div
      className={styles.detail}
      data-stale={query.isError ? 'true' : undefined}
    >
      {query.isError && (
        <p className={notes.note} role="status">
          Couldn’t refresh · as of {clock(query.dataUpdatedAt)}
          <button
            type="button"
            className={`lantern-btn small ${styles.retry}`}
            onClick={() => void query.refetch()}
          >
            Retry
          </button>
        </p>
      )}
      {project.overview && (
        <p className={styles.overview}>{project.overview}</p>
      )}
      {project.now.length > 0 && (
        <section aria-label="Now">
          <h3 className={styles.sub}>Now</h3>
          <ul className={styles.rows}>
            {project.now.map((item) => (
              <li key={item.text}>
                {item.text}
                {item.blocked && (
                  <span className={styles.hint}>
                    Blocked
                    {typeof item.blocked === 'string'
                      ? `: ${item.blocked}`
                      : ''}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <Places project={project} now={now} />
      {project.problems.map((problem) => (
        <section
          key={problem.kind}
          aria-label={problemText(problem.kind, problem.count, problem.worst)}
        >
          <h3 className={styles.sub}>
            {problemText(problem.kind, problem.count, problem.worst)}
          </h3>
          <ul className={styles.rows}>
            {problem.rows.map((row) => (
              <li key={row.name}>
                {row.name}
                {row.detail && (
                  <span className={styles.hint}>{row.detail}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {project.agents.length > 0 && (
        <section aria-label="Working agents">
          <h3 className={styles.sub}>{agentsText(project.agents.length)}</h3>
          <ul className={styles.rows}>
            {project.agents.map((agent) => (
              <li key={agent.sessionId}>
                <Link
                  className={styles.agent}
                  href={`/?session=${encodeURIComponent(agent.sessionId)}`}
                  title={agent.blocked ? 'Waiting on you' : undefined}
                  onClick={() => closePopout?.()}
                >
                  {agent.blocked && <Beacon />}
                  {agent.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {empty && (
        <p className={notes.note}>Nothing more to show for this project.</p>
      )}
    </div>
  )
}

function ProjectRow({
  project,
  now,
  open,
  onToggle,
}: {
  project: ProjectSummary
  now: number
  open: boolean
  onToggle: () => void
}) {
  const inside = useId()
  const Chevron = open ? ChevronDown : ChevronRight
  const line =
    projectLine(project) ||
    (project.lastActivity
      ? shortAge(project.lastActivity, now) === 'now'
        ? 'Active just now'
        : `Active ${shortAge(project.lastActivity, now)} ago`
      : '')
  return (
    <li className={styles.item}>
      <button
        type="button"
        className={styles.head}
        aria-expanded={open}
        aria-controls={inside}
        onClick={onToggle}
      >
        <span className={styles.mark}>
          {project.waiting ? <Beacon /> : <RunMark state={project.runState} />}
        </span>
        <span className={styles.text}>
          <span className={styles.name}>{project.name}</span>
          {line && (
            <span className={styles.line} title={line}>
              {line}
            </span>
          )}
          <Chips project={project} />
        </span>
        <Chevron
          className={`h-3.5 w-3.5 ${styles.chevron}`}
          strokeWidth={1.7}
          aria-hidden="true"
        />
      </button>
      <div id={inside}>{open && <ProjectInside id={project.id} />}</div>
    </li>
  )
}

/** Find a project, then every active project as a row that opens in place; archived ones fold under a count. */
export function GlanceProjects() {
  const query = useProjectOverview()
  const now = useClock(30_000)
  const [search, setSearch] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [archivedOpen, setArchivedOpen] = useState(false)
  const searching = search.trim() !== ''
  const split = query.data ? splitProjects(query.data, search) : null
  if (!split || !query.data)
    return (
      <div>
        <p className={notes.note} role={query.isPending ? 'status' : 'alert'}>
          {query.isPending ? 'Loading projects…' : 'Projects couldn’t be read.'}
          {query.isError && (
            <button
              type="button"
              className={`lantern-btn small ${styles.retry}`}
              onClick={() => void query.refetch()}
            >
              Retry
            </button>
          )}
        </p>
      </div>
    )
  const { active, archived } = split
  const showArchived = archivedOpen || (searching && archived.length > 0)
  const row = (project: ProjectSummary) => (
    <ProjectRow
      key={project.id}
      project={project}
      now={now}
      open={openId === project.id}
      onToggle={() =>
        setOpenId((current) => (current === project.id ? null : project.id))
      }
    />
  )
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
      {query.isError && (
        <p className={notes.note} role="status">
          Couldn’t refresh · as of {clock(query.dataUpdatedAt)}
          <button
            type="button"
            className={`lantern-btn small ${styles.retry}`}
            onClick={() => void query.refetch()}
          >
            Retry
          </button>
        </p>
      )}
      {query.data.length === 0 ? (
        <p className={notes.note}>No projects yet.</p>
      ) : active.length + archived.length === 0 ? (
        <p className={notes.note}>No project matches.</p>
      ) : (
        <ul className={styles.list}>{active.map(row)}</ul>
      )}
      {archived.length > 0 && (
        <>
          <button
            type="button"
            className={styles.group}
            aria-expanded={showArchived}
            onClick={() => setArchivedOpen((value) => !value)}
          >
            <span>Archived</span>
            <span>{archived.length}</span>
          </button>
          {showArchived && <ul className={styles.list}>{archived.map(row)}</ul>}
        </>
      )}
    </div>
  )
}
