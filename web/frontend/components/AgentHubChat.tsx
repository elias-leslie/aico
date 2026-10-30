'use client'

import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import {
  type ChatSource,
  createHttpTransport,
  fetchChatInfo,
} from '@/lib/chat/http-transport'
import { ChatRoot } from '../../../shared/chat/chat-view'

/** The words under a chat that did not open: what the server said, or that it was not reached. */
function openFailure(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'The chat could not be opened.'
}

/**
 * An Agent Hub session's chat, drawn the way the desktop app draws it. A
 * session shows its history, the running turn, and a message box; a workflow
 * step (`run` and `step`) shows its latest attempt read-only. The view asks
 * this app's server, which asks Tether; no token reaches the page.
 */
export function AgentHubChat({
  source,
  running,
}: {
  source: ChatSource
  /** A step view: the step is still running (see `ChatRoot`). */
  running?: boolean
}) {
  // A caller builds `source` each render; the view follows what it names.
  const key = JSON.stringify(source)
  const named = useMemo<ChatSource>(() => JSON.parse(key), [key])
  const opened = useQuery({
    queryKey: ['chat-info', key],
    queryFn: () => fetchChatInfo(named),
    retry: false,
    // A view is opened once and stays on what it opened; the cache keeps nothing after.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    refetchOnWindowFocus: false,
  })
  const info = opened.data
  const transport = useMemo(
    () =>
      info
        ? createHttpTransport(
            // A retry makes a new attempt; the view stays on the one it opened with.
            'run' in named ? { ...named, attempt: info.sessionId } : named,
          )
        : null,
    [info, named],
  )

  if (opened.isPending) {
    return (
      <div
        role="status"
        data-testid="chat-opening"
        className="flex h-full items-center justify-center px-6 text-center"
        style={{ color: 'var(--mist)', font: '400 14px/1.5 var(--font-ui)' }}
      >
        Opening the chat…
      </div>
    )
  }
  if (opened.isError || !info || !transport) {
    return (
      <div
        role="alert"
        data-testid="chat-open-failed"
        className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center"
        style={{ color: 'var(--mist)', font: '400 14px/1.5 var(--font-ui)' }}
      >
        <p style={{ color: 'var(--bone)' }}>{openFailure(opened.error)}</p>
        <button
          type="button"
          className="lantern-btn"
          onClick={() => void opened.refetch()}
        >
          Try again
        </button>
      </div>
    )
  }
  return (
    <div
      className="aico-chat h-full"
      data-testid="agent-hub-chat"
      data-readonly={info.readOnly ? 'true' : undefined}
    >
      <ChatRoot
        key={info.sessionId}
        info={info}
        transport={transport}
        recovery="Reload the page to open it again."
        running={running}
      />
    </div>
  )
}
