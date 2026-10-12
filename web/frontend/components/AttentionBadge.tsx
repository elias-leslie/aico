'use client'

import type { Attention, AttentionGroup } from '@/lib/attention'

/** Tones per attention group; needs-you is the only alarm color. */
const TONE: Record<AttentionGroup, string> = {
  'needs-you': 'var(--term-danger)',
  finished: 'var(--term-accent)',
  working: 'var(--term-warning)',
  idle: 'var(--term-text-muted)',
}

/** A session's state and age as a small pill: `waiting 3m`, `done 1m`. */
export function AttentionBadge({ attention }: { attention: Attention | null }) {
  if (!attention?.detail) return null
  const tone = TONE[attention.group]
  return (
    <span
      data-testid="attention-badge"
      data-group={attention.group}
      className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] leading-4 whitespace-nowrap"
      style={{
        color: tone,
        backgroundColor: `color-mix(in srgb, ${tone} 14%, transparent)`,
        border: `1px solid color-mix(in srgb, ${tone} 30%, transparent)`,
        fontFamily: 'var(--font-ui)',
      }}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: tone }}
      />
      {attention.detail}
    </span>
  )
}

/** The count of sessions that need the owner, for a header or switcher. */
export function NeedsYouCount({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <span
      data-testid="needs-you-count"
      aria-label={`${count} session${count === 1 ? '' : 's'} need${count === 1 ? 's' : ''} you`}
      title={`${count} session${count === 1 ? '' : 's'} waiting for you`}
      className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none"
      style={{
        backgroundColor: 'var(--term-danger)',
        color: 'var(--term-bg-deep)',
      }}
    >
      {count}
    </span>
  )
}
