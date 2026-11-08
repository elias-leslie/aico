'use client'

import { ChevronDown, ChevronRight, Plus } from 'lucide-react'
import Link from 'next/link'
import { useMemo } from 'react'
import { useLiveSessions } from '@/lib/frame/live'
import { requestNewSession } from '@/lib/frame/new-session-request'
import { agoAt, sessionHref, toolName } from '@/lib/history'
import { useClock } from '@/lib/hooks/use-clock'
import { useHistory } from '@/lib/hooks/use-history'
import { useProjectOverview } from '@/lib/hooks/use-projects'
import { useSessionAttention } from '@/lib/hooks/use-session-attention'
import { useSessionLabels } from '@/lib/hooks/use-session-labels'
import { plural } from '@/lib/status'
import type { PaneSlot, TerminalSlot } from '@/lib/utils/slot'
import { AgentIcon } from '../AgentIcon'
import { KeptCheckIns } from '../KeptCheckIns'
import styles from './ProjectsSection.module.css'
import { usePanelFold } from './panel-folds'
import {
  buildProjectTree,
  type ProjectGroup,
  type QuietProject,
  startOfDay,
} from './project-tree'
import { usePopoverClose } from './RailPopover'
import { type RowsContext, SessionRow } from './SessionRows'
import {
  foldSessionEntries,
  sortSessionEntries,
  type TeamEntry,
  type TeamRow,
  teamMembers,
} from './session-entries'

type Slot = TerminalSlot | PaneSlot

function Chevron({ open }: { open: boolean }) {
  const Icon = open ? ChevronDown : ChevronRight
  return (
    <Icon className={styles.chevron} strokeWidth={1.7} aria-hidden="true" />
  )
}

/** How many sessions in a team and under it are in this state. */
function countIn(
  teams: readonly TeamRow<TeamEntry>[],
  group: 'working' | 'needs-you',
): number {
  return teams
    .flatMap((team) => teamMembers(team))
    .filter((member) => member.entry.state?.group === group).length
}

/** "2 finished today" when every one ended today, else "2 finished". */
function finishedLabel(group: ProjectGroup, now: number): string {
  const day = startOfDay(now)
  const total = group.finished.length + group.ended.length
  const today =
    group.ended.length +
    group.finished.filter((row) => (row.item.entry.state?.at ?? 0) >= day)
      .length
  return `${total} finished${today === total ? ' today' : ''}`
}

/** A project's finished sessions folded into one line: the ones still listed open the session, the
 * ones that ended today open their transcript. */
function Finished({
  group,
  ctx,
  now,
}: {
  group: ProjectGroup
  ctx: RowsContext
  now: number
}) {
  const [open, setOpen] = usePanelFold(`finished:${group.id}`, false)
  const labelOf = useSessionLabels()
  const close = usePopoverClose()
  return (
    <>
      <button
        type="button"
        className={styles.fold}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Chevron open={open} />
        <span>{finishedLabel(group, now)}</span>
      </button>
      {open && (
        <div className={styles.rows}>
          {group.finished.map((row) => (
            <SessionRow key={row.item.id} row={row} ctx={ctx} />
          ))}
          {group.ended.map((session) => (
            <Link
              key={session.id}
              href={sessionHref(session.id)}
              className={`lantern-row ${styles.link}`}
              onClick={() => close?.()}
            >
              <AgentIcon slug={session.tool} size={16} />
              <span className="name">{labelOf(session)}</span>
              <span className="when">{agoAt(session.endedAt, now)}</span>
              <span className="meta">
                <span className="status-chip ok">Finished</span>
                <span className="truncate">{toolName(session.tool)}</span>
              </span>
            </Link>
          ))}
        </div>
      )}
    </>
  )
}

/** One project with a live session: its name and counts, its sessions under it. A project with a
 * single session and nothing else is that one row. */
function ProjectBlock({
  group,
  ctx,
  now,
}: {
  group: ProjectGroup
  ctx: RowsContext
  now: number
}) {
  const [open, setOpen] = usePanelFold(`project:${group.id}`, true)
  const only = group.teams[0]
  if (
    group.teams.length === 1 &&
    only &&
    only.children.length === 0 &&
    group.finished.length + group.ended.length === 0
  )
    return (
      <div className={styles.block} data-testid="project-block">
        <SessionRow row={only} ctx={ctx} prefix={group.name} />
      </div>
    )
  const working = countIn(group.teams, 'working')
  const waiting = countIn(group.teams, 'needs-you')
  return (
    <section
      className={styles.block}
      aria-label={group.name}
      data-testid="project-block"
    >
      <h3 className="m-0" style={{ font: 'inherit' }}>
        <button
          type="button"
          className={styles.head}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <Chevron open={open} />
          <span className={styles.name}>{group.name}</span>
          <span className={styles.counts}>
            {waiting > 0 && (
              <span className="status-chip warn">{waiting} waiting</span>
            )}
            {working > 0 && (
              <span className="status-chip running">{working} working</span>
            )}
          </span>
        </button>
      </h3>
      {open && (
        <div className={styles.rows}>
          {group.teams.map((team) => (
            <SessionRow key={team.item.id} row={team} ctx={ctx} />
          ))}
          {group.finished.length + group.ended.length > 0 && (
            <Finished group={group} ctx={ctx} now={now} />
          )}
        </div>
      )}
    </section>
  )
}

function Quiet({ projects, now }: { projects: QuietProject[]; now: number }) {
  const [open, setOpen] = usePanelFold('quiet-projects', false)
  const close = usePopoverClose()
  if (projects.length === 0) return null
  return (
    <div className={styles.quiet}>
      <button
        type="button"
        className={styles.fold}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Chevron open={open} />
        <span>{plural(projects.length, 'quiet project')}</span>
      </button>
      {open && (
        <ul className="m-0 list-none p-0" aria-label="Quiet projects">
          {projects.map((project) => (
            <li key={project.id} className={styles.quietRow}>
              <span className={styles.quietText}>
                <span className={styles.name} title={project.name}>
                  {project.name}
                </span>
                <span className={styles.quietLine}>
                  {[
                    project.endedToday > 0
                      ? `${project.endedToday} finished today`
                      : null,
                    project.at
                      ? `active ${agoAt(project.at, now).replace(' ago', '')}`
                      : 'no activity yet',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              <button
                type="button"
                className="lantern-btn small"
                aria-label={`New session in ${project.name}`}
                onClick={() => {
                  requestNewSession(project.id)
                  close?.()
                }}
              >
                <Plus
                  className="h-4 w-4"
                  strokeWidth={1.7}
                  aria-hidden="true"
                />
                New session here
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** What the section has counted: projects with a session running, for the rail and the heading. */
export function useProjectTree(slots: Slot[]) {
  const attention = useSessionAttention()
  const overview = useProjectOverview()
  const history = useHistory('')
  const live = useLiveSessions()
  const now = useClock(30_000)
  const teams = useMemo(
    () => foldSessionEntries(sortSessionEntries(slots, attention)),
    [slots, attention],
  )
  const tree = useMemo(
    () =>
      buildProjectTree({
        teams,
        projects: overview.data ?? null,
        history: history.items,
        owned: live.conversations,
        now,
      }),
    [teams, overview.data, history.items, live.conversations, now],
  )
  return { tree, overview, history, now }
}

/** The side's Projects: projects with a running session each hold their sessions, working first and
 * most recently active first; the rest close the list as one line. */
export function ProjectsSection({
  slots,
  currentId,
  onSelect,
  bare = false,
}: {
  slots: Slot[]
  currentId?: string
  onSelect: (slot: Slot) => void
  /** Without its heading: a pop-out names it already. */
  bare?: boolean
}) {
  const { tree, overview, history, now } = useProjectTree(slots)
  const ctx: RowsContext = {
    currentId,
    onSelect,
    severalHosts: slots.some((slot) => slot.host),
  }
  return (
    <section
      className={styles.section}
      aria-label="Projects"
      data-testid="projects-section"
    >
      {!bare && (
        <h2 className={`lantern-sec ${styles.heading}`}>
          Projects
          {tree.groups.length > 0 && (
            <span className="n">{tree.groups.length}</span>
          )}
        </h2>
      )}
      {tree.groups.length === 0 && (
        <p className={styles.empty}>
          {slots.length === 0
            ? 'No sessions running. New session starts one.'
            : 'No sessions to show.'}
        </p>
      )}
      <nav aria-label="Sessions" data-testid="session-list">
        {tree.groups.map((group) => (
          <ProjectBlock key={group.id} group={group} ctx={ctx} now={now} />
        ))}
      </nav>
      {overview.isError && !overview.data && (
        <p className={styles.note} role="alert">
          Projects couldn’t be read, so quiet ones aren’t listed.
          <button
            type="button"
            className={`lantern-btn small ${styles.retry}`}
            onClick={() => void overview.refetch()}
          >
            Retry
          </button>
        </p>
      )}
      {overview.isPending && (
        <p className={styles.note} role="status">
          Checking projects…
        </p>
      )}
      {overview.data && overview.isError && (
        <p className={styles.note} role="status">
          Couldn’t refresh projects. Showing the last list.
          <button
            type="button"
            className={`lantern-btn small ${styles.retry}`}
            onClick={() => void overview.refetch()}
          >
            Retry
          </button>
        </p>
      )}
      {history.failed && (
        <p className={styles.note} role="status">
          Finished sessions couldn’t be read.
        </p>
      )}
      {tree.quiet && <Quiet projects={tree.quiet} now={now} />}
      <KeptCheckIns />
    </section>
  )
}
