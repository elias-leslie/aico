'use client'

import { Copy, FolderOpen, X } from 'lucide-react'
import { useState } from 'react'
import { rawFileUrl } from '@/lib/api/pane-files'
import { openFiles } from '@/lib/files-opener'
import { type AgentShow, useAgentShows } from '@/lib/hooks/use-agent-shows'

/** A path's last part; a shared folder's path ends in `/`. */
export function baseName(path: string): string {
  return (
    path
      .replace(/(?<=.)\/$/, '')
      .split('/')
      .pop() || path
  )
}

/** What a share holds, in a few words: its first file's name, and how many more. */
export function shareSummary(show: AgentShow): string {
  if (show.kind === 'url') return show.url
  const [first, ...rest] = show.paths
  return rest.length
    ? `${baseName(first)} and ${rest.length} more`
    : baseName(first)
}

export function AgentShowToast({
  show,
  onDismiss,
  sessionName,
}: {
  show: AgentShow
  onDismiss: () => void
  /** The sharing session's name, when it is one of the listed sessions */
  sessionName?: string | null
}) {
  const [copyState, setCopyState] = useState<
    'Copy link' | 'Copied' | 'Couldn’t copy'
  >('Copy link')

  async function copyUrl() {
    if (show.kind !== 'url') return
    try {
      await navigator.clipboard.writeText(show.url)
      setCopyState('Copied')
    } catch {
      setCopyState('Couldn’t copy')
    }
  }

  function open() {
    if (show.kind !== 'files') return
    if (!openFiles({ kind: 'shared', showId: show.id })) {
      // No session open to show Files in: open the first file by itself.
      const first = show.paths[0]
      const folder = first.slice(0, first.lastIndexOf('/')) || '/'
      window.open(rawFileUrl(folder, baseName(first)), '_blank', 'noopener')
    }
    onDismiss()
  }

  const target = shareSummary(show)

  return (
    <section
      role="status"
      className="lantern-sheet lantern-enter fixed top-14 left-1/2 z-50 max-h-[calc(100dvh-5rem)] w-[calc(100vw-20px)] max-w-md -translate-x-1/2 overflow-y-auto rounded-xl px-3.5 pt-3 pb-2.5"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="m-0 text-xs" style={{ color: 'var(--mist)' }}>
            {sessionName ? `Shared by ${sessionName}` : 'Shared by an agent'}
          </p>
          <p
            className="m-0 mt-[3px] break-words"
            style={{ font: '450 17px/1.25 var(--font-display)' }}
            dir="auto"
          >
            {show.title || target}
          </p>
          {show.title && (
            <p
              className="m-0 mt-1 select-text break-all text-[11.5px]"
              style={{ fontFamily: 'var(--font-mono)', color: 'var(--mist)' }}
              dir="auto"
            >
              {target}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="lantern-icon-btn compact -mt-1 -mr-1"
          aria-label="Dismiss shared item"
        >
          <X className="h-[18px] w-[18px]" strokeWidth={1.7} />
        </button>
      </div>
      <div className="mt-3 flex">
        {show.kind === 'files' ? (
          <button
            type="button"
            className="lantern-btn primary flex-1"
            onClick={open}
          >
            <FolderOpen className="h-4 w-4" strokeWidth={1.7} />
            Open
          </button>
        ) : (
          <button
            type="button"
            className="lantern-btn primary flex-1"
            onClick={copyUrl}
          >
            <Copy className="h-4 w-4" strokeWidth={1.7} />
            {copyState}
          </button>
        )}
      </div>
    </section>
  )
}

export function AgentShows({
  sessionName,
}: {
  /** Names the session a share came from (Tether's 8-character id). */
  sessionName?: (session: string) => string | null
}) {
  const { show, dismiss } = useAgentShows()
  return show ? (
    <AgentShowToast
      key={show.id}
      show={show}
      onDismiss={dismiss}
      sessionName={show.session ? sessionName?.(show.session) : null}
    />
  ) : null
}
