'use client'

import { StickyNote } from 'lucide-react'
import Link from 'next/link'

const TITLE = 'Notes: lists, groceries and photos'

/** The way into Notes, mounted beside the Capture button. */
export function NotesLauncher({
  variant = 'icon',
}: {
  variant?: 'icon' | 'row'
}) {
  return variant === 'icon' ? (
    <Link
      href="/notes"
      className="lantern-icon-btn compact"
      aria-label={TITLE}
      title={TITLE}
      data-testid="notes-link"
    >
      <StickyNote className="h-[18px] w-[18px]" strokeWidth={1.7} />
    </Link>
  ) : (
    <Link
      href="/notes"
      className="lantern-btn ghost small"
      aria-label={TITLE}
      title={TITLE}
      data-testid="notes-link"
    >
      <StickyNote className="h-4 w-4" strokeWidth={1.7} aria-hidden="true" />
      Notes
    </Link>
  )
}
