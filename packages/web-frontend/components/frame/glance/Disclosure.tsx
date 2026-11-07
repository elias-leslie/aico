'use client'

import { ChevronDown, ChevronRight } from 'lucide-react'
import { type ReactNode, useId } from 'react'
import styles from './Glance.module.css'
import type { GlanceHead } from './glance-types'
import { OpenLink, type OpenWhere } from './OpenLink'

/** A Panel section that folds: a heading with a chevron and a count, "Open" for the full page, and a
 * one-line summary under the heading while folded. Content only below it, so a popover can carry the same body. */
export function Disclosure({
  title,
  head,
  href,
  where,
  open,
  onToggle,
  children,
}: {
  title: string
  head: GlanceHead
  href: string
  where: OpenWhere
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  const body = useId()
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <section className={styles.disclosure} aria-label={title}>
      <div className={`lantern-sec ${styles.head}`}>
        <h2>
          <button
            type="button"
            className={styles.toggle}
            aria-expanded={open}
            aria-controls={body}
            onClick={onToggle}
          >
            <Chevron
              className="h-3.5 w-3.5"
              strokeWidth={1.7}
              aria-hidden="true"
            />
            {title}
          </button>
        </h2>
        {head.count && <span className="n">{head.count}</span>}
        <span className={styles.headLink}>
          <OpenLink href={href} where={where} label={`Open ${title}`}>
            Open
          </OpenLink>
        </span>
      </div>
      <div id={body} className={styles.body}>
        {open
          ? children
          : head.line && <p className={styles.foldLine}>{head.line}</p>}
      </div>
    </section>
  )
}
