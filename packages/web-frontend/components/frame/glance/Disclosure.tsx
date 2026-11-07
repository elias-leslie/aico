'use client'

import { ChevronDown, ChevronRight } from 'lucide-react'
import { type ReactNode, useId } from 'react'
import styles from './Glance.module.css'
import type { GlanceHead } from './glance-types'

/** The value beside a label: a chip when it is a state, quiet text when it is a number or a name. */
export function GlanceValue({ head }: { head: GlanceHead }) {
  if (!head.value) return null
  return head.tone ? (
    <span className={`status-chip ${head.tone} ${styles.chip}`}>
      {head.value}
    </span>
  ) : (
    <span className={styles.value}>{head.value}</span>
  )
}

/** A Panel row that folds: chevron, label and its one value on one line. Open, the body holds everything
 * the glance has and scrolls inside the panel. */
export function Disclosure({
  title,
  head,
  open,
  onToggle,
  children,
}: {
  title: string
  head: GlanceHead
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  const body = useId()
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <section className={styles.disclosure} aria-label={title}>
      <h2 className={styles.rowHead}>
        <button
          type="button"
          className={styles.row}
          aria-expanded={open}
          aria-controls={open ? body : undefined}
          onClick={onToggle}
        >
          <Chevron
            className={styles.chevron}
            strokeWidth={1.7}
            aria-hidden="true"
          />
          <span className={styles.label}>{title}</span>
          <GlanceValue head={head} />
        </button>
      </h2>
      {open && (
        <div id={body} className={`${styles.body} ${styles.scrolls}`}>
          {children}
        </div>
      )}
    </section>
  )
}
