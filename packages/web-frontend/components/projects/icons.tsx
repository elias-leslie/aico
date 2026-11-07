import type { ReactNode } from 'react'
import type { ProblemKind } from '@/lib/projects'

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  )
}

/** One glyph per problem kind: a failed job, a warning, a quiet check, a failed publish, a failed backup. */
export function ProblemIcon({ kind }: { kind: ProblemKind }) {
  switch (kind) {
    case 'fail':
      return (
        <Glyph>
          <circle cx="8" cy="8" r="6" />
          <path d="M8 4.5V8l2.3 1.5" />
          <path d="M12 12l2.5 2.5" />
        </Glyph>
      )
    case 'warn':
      return (
        <Glyph>
          <path d="M8 2.5l6 10.5H2z" />
          <path d="M8 6.5v3M8 11.3v.2" />
        </Glyph>
      )
    case 'quiet':
      return (
        <Glyph>
          <path d="M2 9h2.5l1.5-4 2 7 1.5-3H11" />
          <path d="M12.5 7.5l2 2M14.5 7.5l-2 2" />
        </Glyph>
      )
    case 'publish':
      return (
        <Glyph>
          <path d="M8 10V3M5 6l3-3 3 3M3 13h10" />
          <path d="M11.5 9.5l3 3M14.5 9.5l-3 3" />
        </Glyph>
      )
    case 'backup':
      return (
        <Glyph>
          <rect x="2" y="3" width="12" height="3.5" rx="1" />
          <path d="M3 6.5V13h10V6.5" />
          <path d="M6.3 8.6l3.4 3M9.7 8.6l-3.4 3" />
        </Glyph>
      )
  }
}

export function PersonIcon() {
  return (
    <Glyph>
      <circle cx="8" cy="5.5" r="2.5" />
      <path d="M3.5 14c.6-2.6 2.4-4 4.5-4s3.9 1.4 4.5 4" />
    </Glyph>
  )
}

export function PowerIcon() {
  return (
    <Glyph>
      <path d="M8 2v5.5" />
      <path d="M4.4 4.2a5.2 5.2 0 1 0 7.2 0" />
    </Glyph>
  )
}

export function BackIcon() {
  return (
    <Glyph>
      <path d="M10 3L5 8l5 5" />
    </Glyph>
  )
}
