'use client'

import { clsx } from 'clsx'
import { type KeyboardEvent, useRef } from 'react'
import type { CoordinatorBadgeInfo } from '@/lib/utils/coordinator-badge'
import type { PaneSlot, TerminalSlot } from '@/lib/utils/slot'
import { AgentIcon } from '../AgentIcon'
import { CoordinatorBadge } from '../CoordinatorBadge'
import styles from './LaneList.module.css'
import { usePopoverClose } from './RailPopover'

/** What a lane's state chip says and how it looks (the status-chip kinds). */
export interface LaneChip {
  text: string
  kind: 'warn' | 'ok' | 'off'
}

/** One row of a coordinator's pop-out: the coordinator first, then its lanes. */
export interface LaneRow {
  id: string
  slot: TerminalSlot | PaneSlot
  title: string
  mode: string
  color: string
  /** The state chip of a lane; the coordinator wears its own badge instead. */
  chip: LaneChip | null
  badge: CoordinatorBadgeInfo | null
  age: string
  /** The last thing it said or did, one line. */
  line: string | null
  /** 0 for the coordinator, 1 for a lane, 2 for a lane's own helper. */
  depth: number
  current: boolean
  needs: boolean
}

export const LANE_HINT =
  'Up and Down move · Enter opens the session · Esc closes'

/** A coordinator's team as rows: Up and Down (and Home, End) move between
 * them, Enter opens the session, and the first row takes focus when the
 * pop-out opens. */
export function LaneList({
  heading,
  rows,
  onOpen,
}: {
  heading: string
  rows: LaneRow[]
  onOpen: (slot: TerminalSlot | PaneSlot) => void
}) {
  const list = useRef<HTMLUListElement>(null)
  const close = usePopoverClose()
  const lanes = rows.length - 1
  const move = (event: KeyboardEvent<HTMLUListElement>) => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key]
    const edge = { Home: 0, End: -1 }[event.key]
    if (!step && edge === undefined) return
    event.preventDefault()
    const buttons = Array.from(
      list.current?.querySelectorAll<HTMLElement>('button') ?? [],
    )
    const at = buttons.indexOf(document.activeElement as HTMLElement)
    const next = step
      ? Math.min(buttons.length - 1, Math.max(0, at + step))
      : edge === 0
        ? 0
        : buttons.length - 1
    buttons[next]?.focus()
  }
  return (
    <section className={styles.lanes} aria-label={heading}>
      <div className={`lantern-sec ${styles.head}`}>
        <h2>{heading}</h2>
        <span className="n">
          {lanes} {lanes === 1 ? 'lane' : 'lanes'}
        </span>
      </div>
      {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: arrow keys move between the rows' own buttons */}
      <ul ref={list} className={styles.list} onKeyDown={move}>
        {rows.map((row, index) => (
          <li key={row.id} data-depth={row.depth}>
            <button
              type="button"
              className={clsx('lantern-row', styles.row, row.needs && 'needs')}
              aria-current={row.current ? 'true' : undefined}
              data-autofocus={index === 0 ? '' : undefined}
              onClick={() => {
                onOpen(row.slot)
                close?.()
              }}
            >
              <AgentIcon slug={row.mode} size={16} color={row.color} />
              <span className="name" title={row.title}>
                {row.title}
              </span>
              <span className="when">{row.age}</span>
              <span className="meta">
                {row.depth === 0 ? (
                  <CoordinatorBadge badge={row.badge} />
                ) : (
                  row.chip && (
                    <span className={`status-chip ${row.chip.kind}`}>
                      {row.chip.text}
                    </span>
                  )
                )}
                {row.line && <span className="truncate">{row.line}</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
