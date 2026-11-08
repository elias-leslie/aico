'use client'

import type { Approval } from '@/lib/hooks/use-asks'
import { Meta } from './ask-shared'

export function ApprovalCard({ tap }: { tap: Approval }) {
  const minutes = Math.max(1, Math.round(tap.expiresInS / 60))
  return (
    <li className="lantern-ask" data-blocking="true">
      <Meta>
        <span className="lantern-chip" data-tone="wait">
          Grant request
        </span>
        <span
          className="min-w-0 truncate"
          style={{ color: 'var(--mist)' }}
          title="Approving takes a tap of your security key, on its own page"
        >
          security key · expires in{' '}
          {minutes >= 60
            ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
            : `${minutes}m`}
        </span>
      </Meta>
      <p className="mb-2 font-semibold" style={{ overflowWrap: 'anywhere' }}>
        {tap.title}
      </p>
      <div className="lantern-ask-actions" style={{ marginTop: 0 }}>
        <a
          href={tap.url}
          target="_blank"
          rel="noreferrer noopener"
          className="lantern-btn primary small"
        >
          Review and approve
        </a>
        <a href="/grants" className="lantern-btn small">
          All grants
        </a>
      </div>
    </li>
  )
}
