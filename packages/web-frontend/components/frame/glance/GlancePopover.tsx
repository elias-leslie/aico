'use client'

import type { ReactNode } from 'react'
import styles from './Glance.module.css'
import type { GlanceHead } from './glance-types'
import { OpenLink, type OpenWhere } from './OpenLink'

/** A glance's heading, count and "Open" over its body: what a rail pop-out
 * holds, the same body the Panel's section shows. */
export function GlancePopover({
  title,
  head,
  href,
  where,
  children,
}: {
  title: string
  head: GlanceHead
  href: string
  where: OpenWhere
  children: ReactNode
}) {
  return (
    <section className={styles.popout} aria-label={title}>
      <div className={`lantern-sec ${styles.head}`}>
        <h2>{title}</h2>
        {head.count && <span className="n">{head.count}</span>}
        <span className={styles.headLink}>
          <OpenLink href={href} where={where} label={`Open ${title}`}>
            Open
          </OpenLink>
        </span>
      </div>
      <div className={styles.body}>{children}</div>
    </section>
  )
}
