'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import { useFrame } from '../FrameContext'
import styles from './Glance.module.css'

/** Where a page opens: Wide beside the session for the daily ones, Full for the long ones. */
export type OpenWhere = 'wide' | 'full'

/** A link to a full page that opens it in place when there is a frame to open it in. */
export function OpenLink({
  href,
  where = 'wide',
  label,
  bare = false,
  children,
}: {
  href: string
  where?: OpenWhere
  /** What a screen reader says when the visible text is short ("Open"). */
  label?: string
  /** Quiet text that reads as a row's name, not as an amber link. */
  bare?: boolean
  children: ReactNode
}) {
  const frame = useFrame()
  return (
    <Link
      href={href}
      className={bare ? styles.rowLink : styles.link}
      aria-label={label}
      onClick={(event) => {
        if (!frame) return
        event.preventDefault()
        frame.open(href, where)
      }}
    >
      {children}
    </Link>
  )
}
