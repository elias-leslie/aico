'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import { useFrame } from '../FrameContext'
import styles from './Glance.module.css'

/** A link to a full page that opens it in place (Full) when there is a frame to open it in. For the
 * one heavy thing a glance cannot hold inline (a restore flow, a transcript), never for what a glance can show. */
export function OpenLink({
  href,
  label,
  bare = false,
  children,
}: {
  href: string
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
        frame.open(href)
      }}
    >
      {children}
    </Link>
  )
}
