'use client'

import { useState } from 'react'
import {
  blockedReason,
  emptyRoadmapText,
  LANES,
  type ProjectDetail,
  type RoadmapItem,
} from '@/lib/projects'
import { PlanSheet } from './PlanSheet'
import styles from './ProjectsPage.module.css'

/** Items with a key of their text, counted when two lines read the same. */
function keyed(items: RoadmapItem[]): [string, RoadmapItem][] {
  const seen = new Map<string, number>()
  return items.map((item) => {
    const n = (seen.get(item.text) ?? 0) + 1
    seen.set(item.text, n)
    return [`${item.text}#${n}`, item]
  })
}

function RoadmapLine({
  item,
  lane,
  onPlan,
}: {
  item: RoadmapItem
  lane: 'now' | 'next' | 'later'
  onPlan: (path: string) => void
}) {
  const blocked = !!item.blocked
  return (
    <li
      className={`${styles[lane]} ${blocked ? styles.blocked : ''} ${item.raw ? styles.raw : ''}`}
      title={blocked ? blockedReason(item) : undefined}
    >
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.tx}>
        {item.text}
        {blocked && (
          <span className={styles.blockedNote}>{blockedReason(item)}</span>
        )}
      </span>
      <span className={styles.meta}>
        {item.session && (
          <a href={`/?session=${encodeURIComponent(item.session)}`}>session</a>
        )}
        {item.plan && (
          <button
            type="button"
            title={`Read the plan: ${item.plan}`}
            aria-label={`Read the plan for “${item.text}”`}
            onClick={() => onPlan(item.plan as string)}
          >
            plan
          </button>
        )}
      </span>
    </li>
  )
}

/** Now, Next and Later as headed groups, in words; a project without a roadmap says what would fill it. */
export function Roadmap({ project }: { project: ProjectDetail }) {
  const [plan, setPlan] = useState<string | null>(null)
  const other = (project.roadmap?.other ?? []).filter(
    (line) => line.trim() && !/^##\s/.test(line),
  )
  const empty =
    project.now.length + project.next.length + project.later.length === 0 &&
    other.length === 0
  const found = project.roadmap ? project.roadmap.found : false

  return (
    <section className={styles.roadmap} aria-label="Roadmap">
      {empty && <p className={styles.empty}>{emptyRoadmapText(found)}</p>}
      {LANES.map(({ key, label, hint }) => {
        const items = project[key]
        if (items.length === 0) return null
        return (
          <div key={key} className={styles.lane}>
            <h2 className={styles.laneHead}>
              {label}
              <span className={styles.laneHint}>{hint}</span>
            </h2>
            <ul className={styles.tl} aria-label={label}>
              {keyed(items).map(([id, item]) => (
                <RoadmapLine
                  key={`${key}-${id}`}
                  item={item}
                  lane={key}
                  onPlan={setPlan}
                />
              ))}
            </ul>
          </div>
        )
      })}
      {other.length > 0 && (
        <div className={styles.lane}>
          <h2 className={styles.laneHead}>
            Other lines
            <span className={styles.laneHint}>
              not under Now, Next or Later
            </span>
          </h2>
          <ul className={styles.tl} aria-label="Other lines">
            {other.map((line, index) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: static lines, never reordered
                key={index}
                className={`${styles.later} ${styles.raw}`}
              >
                <span className={styles.dot} aria-hidden="true" />
                <span className={styles.tx}>{line.trim()}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {plan && (
        <PlanSheet
          projectId={project.id}
          path={plan}
          onClose={() => setPlan(null)}
        />
      )}
    </section>
  )
}
