import type { ReactNode } from 'react'
/** The transcript renderer's folded line: output, thinking and diffs share it. */
export function TranscriptFold({
  summary,
  children,
  className = '',
}: {
  summary: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <details className={`history-event ${className}`}>
      <summary>{summary}</summary>
      <pre>{children}</pre>
    </details>
  )
}
