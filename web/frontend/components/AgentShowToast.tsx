'use client'

import { X } from 'lucide-react'
import { useState } from 'react'
import { buildApiUrl } from '@/lib/api-config'
import { type AgentShow, useAgentShows } from '@/lib/hooks/use-agent-shows'

const ACTION_CLASSES =
  'rounded px-2 py-1 text-sm hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2'

export function AgentShowToast({
  show,
  onDismiss,
}: {
  show: AgentShow
  onDismiss: () => void
}) {
  const [copyState, setCopyState] = useState<'Copy' | 'Copied' | 'Copy failed'>(
    'Copy',
  )

  async function copyUrl() {
    if (show.kind !== 'url') return
    try {
      await navigator.clipboard.writeText(show.url)
      setCopyState('Copied')
    } catch {
      setCopyState('Copy failed')
    }
  }

  return (
    <div
      role="status"
      className="fixed top-20 left-1/2 -translate-x-1/2 z-50 max-h-[calc(100dvh-6rem)] w-[calc(100vw-2rem)] max-w-md overflow-y-auto rounded-md px-4 py-2 shadow-lg"
      style={{
        backgroundColor: 'var(--term-bg-elevated)',
        border: '1px solid var(--term-border)',
        color: 'var(--term-text-primary)',
      }}
    >
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 break-words text-sm">
          Agent shared: {show.title || show.name}
        </span>
        <button
          type="button"
          onClick={onDismiss}
          className={`${ACTION_CLASSES} shrink-0`}
          style={{ color: 'var(--term-text-muted)' }}
          aria-label="Dismiss shared item"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {show.kind === 'url' && show.title && (
        <p className="mt-1 select-text break-all text-sm" dir="auto">
          {show.url}
        </p>
      )}
      <div className="mt-1" style={{ color: 'var(--term-accent)' }}>
        {show.kind === 'file' ? (
          <a
            className={ACTION_CLASSES}
            href={buildApiUrl(`/api/a-term/shows/${show.id}/file`)}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open
          </a>
        ) : (
          <button type="button" className={ACTION_CLASSES} onClick={copyUrl}>
            {copyState}
          </button>
        )}
      </div>
    </div>
  )
}

export function AgentShows() {
  const { show, dismiss } = useAgentShows()
  return show ? (
    <AgentShowToast key={show.id} show={show} onDismiss={dismiss} />
  ) : null
}
