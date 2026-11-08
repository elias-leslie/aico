'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useClock } from '@/lib/hooks/use-clock'
import { useProjectDetail } from '@/lib/hooks/use-projects'
import {
  agentsText,
  type ProjectDetail as Detail,
  type Place,
  type ProblemKind,
  placeLine,
  placeName,
  powerActions,
  powerButtonText,
  problemText,
  runStateText,
  unknownReason,
} from '@/lib/projects'
import { AgentsBadge, Beacon, ProblemBadge } from './Badges'
import { BackIcon, PowerIcon } from './icons'
import { Popover } from './Popover'
import { PowerSheet } from './PowerSheet'
import styles from './ProjectsPage.module.css'
import { Timeline } from './Timeline'

function PlaceRow({
  place,
  onOpen,
  now,
}: {
  place: Place
  onOpen: () => void
  now: number
}) {
  const name = placeName(place)
  const state = runStateText[place.state]
  const actions = powerActions(place)
  const note = place.busy
    ? ` · ${placeLine(place, now)}`
    : !place.power
      ? ' · can’t be changed from here'
      : place.state === 'unknown'
        ? ` · ${unknownReason(place)}`
        : ''
  return (
    <div className={styles.place}>
      {actions ? (
        <button
          type="button"
          className={styles.powerBtn}
          aria-label={powerButtonText(place).full}
          title={powerButtonText(place).full}
          onClick={onOpen}
        >
          <span
            className={styles.power}
            data-state={place.busy ? 'starting' : place.state}
            aria-hidden="true"
          >
            <PowerIcon />
          </span>
          <span className={styles.powerWord}>
            {powerButtonText(place).short}
          </span>
        </button>
      ) : (
        <span
          className={styles.power}
          data-state={place.busy ? 'starting' : place.state}
          data-indicator="true"
          role="img"
          aria-label={`${name}: ${state.toLowerCase()}${note}`}
          title={`${state}${note}`}
        >
          <PowerIcon />
        </span>
      )}
      <span className={styles.where} title={place.label}>
        {name}
      </span>
      <span className={styles.sub}>{placeLine(place, now)}</span>
    </div>
  )
}

/** A project's places with their power controls and the confirm sheet a power button opens; the page and
 * the side's Projects section both use it, so they cannot drift apart. */
function Places({ project, now }: { project: Detail; now: number }) {
  const [index, setIndex] = useState<number | null>(null)
  const place = index === null ? undefined : project.places[index]
  const actions = place && powerActions(place)
  return (
    <>
      {project.places.length > 0 && (
        <div className={styles.places}>
          {project.places.map((item, i) => (
            <PlaceRow
              // biome-ignore lint/suspicious/noArrayIndexKey: a place is its position in the registry list; the power route addresses it by index
              key={i}
              place={item}
              now={now}
              onOpen={() => setIndex(i)}
            />
          ))}
        </div>
      )}
      {index !== null && place && actions && (
        <PowerSheet
          projectId={project.id}
          index={index}
          place={place}
          actions={actions}
          agents={project.agents.length}
          now={now}
          onClose={() => setIndex(null)}
        />
      )}
    </>
  )
}

/** Rows a popover lists before "+ N more". */
const MAX_ROWS = 5

type Open = { type: 'problem'; kind: ProblemKind } | { type: 'agents' } | null

export function ProjectDetail({
  id,
  openProblem,
  onBack,
}: {
  id: string
  /** A badge tapped in the list opens its rows here once they arrive. */
  openProblem?: ProblemKind | 'agents' | null
  onBack: () => void
}) {
  const query = useProjectDetail(id)
  const now = useClock(30_000)
  const [open, setOpen] = useState<Open>(null)
  const [seenFor, setSeenFor] = useState<string>('')
  const wanted = `${id}:${openProblem ?? ''}`
  if (seenFor !== wanted && query.data) {
    setSeenFor(wanted)
    if (openProblem === 'agents') setOpen({ type: 'agents' })
    else if (openProblem) setOpen({ type: 'problem', kind: openProblem })
    else setOpen(null)
  }
  const close = () => setOpen(null)
  const project: Detail | undefined = query.data

  return (
    <div className={styles.detail}>
      <button type="button" className={styles.back} onClick={onBack}>
        <BackIcon />
        Projects
      </button>
      {!project && query.isPending && <DetailSkeleton />}
      {!project && query.isError && (
        <div className={styles.problem} role="alert">
          Couldn’t load this project
          <button
            type="button"
            className="lantern-btn small"
            onClick={() => void query.refetch()}
          >
            Retry
          </button>
        </div>
      )}
      {project && (
        <>
          <h1>{project.name}</h1>
          {project.overview && (
            <p className={styles.overview}>{project.overview}</p>
          )}
          <Places project={project} now={now} />
          {(project.problems.length > 0 || project.agents.length > 0) && (
            <div className={styles.probs}>
              {project.problems.map((problem) => (
                <ProblemBadge
                  key={problem.kind}
                  kind={problem.kind}
                  count={problem.count}
                  worst={problem.worst}
                  expanded={
                    open?.type === 'problem' && open.kind === problem.kind
                  }
                  onClick={() =>
                    setOpen({ type: 'problem', kind: problem.kind })
                  }
                />
              ))}
              {project.agents.length > 0 && (
                <AgentsBadge
                  count={project.agents.length}
                  expanded={open?.type === 'agents'}
                  onClick={() => setOpen({ type: 'agents' })}
                />
              )}
              {open?.type === 'problem' &&
                (() => {
                  const problem = project.problems.find(
                    (p) => p.kind === open.kind,
                  )
                  if (!problem) return null
                  const rows = problem.rows.slice(0, MAX_ROWS)
                  const more =
                    Math.max(problem.count, problem.rows.length) - rows.length
                  return (
                    <Popover
                      label={problemText(
                        problem.kind,
                        problem.count,
                        problem.worst,
                      )}
                      onClose={close}
                    >
                      <ul>
                        {rows.map((row) => (
                          <li key={row.name}>
                            {row.name}
                            {row.detail && (
                              <div className={styles.hint}>{row.detail}</div>
                            )}
                          </li>
                        ))}
                        {more > 0 && (
                          <li className={styles.hint}>+ {more} more</li>
                        )}
                      </ul>
                      <div className={styles.acts}>
                        <Link
                          href={`/status?project=${encodeURIComponent(project.id)}`}
                          className="lantern-btn"
                        >
                          Open in Status
                        </Link>
                      </div>
                    </Popover>
                  )
                })()}
              {open?.type === 'agents' && (
                <Popover
                  label={agentsText(project.agents.length)}
                  onClose={close}
                >
                  <ul>
                    {project.agents.map((agent) => (
                      <li key={agent.sessionId}>
                        <Link
                          href={`/?session=${encodeURIComponent(agent.sessionId)}`}
                          title={agent.blocked ? 'Waiting on you' : undefined}
                        >
                          {agent.blocked && <Beacon />}
                          {agent.title}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Popover>
              )}
            </div>
          )}
          <Timeline project={project} now={now} />
        </>
      )}
    </div>
  )
}

function DetailSkeleton() {
  return (
    <div role="status" aria-label="Loading project">
      {[40, 85, 70, 60].map((width) => (
        <div
          key={width}
          className={styles.skel}
          style={{ width: `${width}%`, margin: '10px 0' }}
        />
      ))}
    </div>
  )
}
