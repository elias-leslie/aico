'use client'

import type { ReactNode } from 'react'
import { GlanceValue } from './Disclosure'
import styles from './Glance.module.css'
import type { GlanceHead } from './glance-types'

/** A glance's heading and value over its body: what a rail pop-out holds, the same body the Panel's row
 * opens to. The pop-out fits the window and scrolls. */
export function GlancePopover({
  title,
  head,
  children,
}: {
  title: string
  head: GlanceHead
  children: ReactNode
}) {
  return (
    <section className={styles.popout} aria-label={title}>
      <h2 className={styles.popHead}>
        <span className={styles.label}>{title}</span>
        <GlanceValue head={head} />
      </h2>
      <div className={styles.body}>{children}</div>
    </section>
  )
}
