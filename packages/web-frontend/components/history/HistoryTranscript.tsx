'use client'

import { ArrowLeft, RefreshCw } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { PlainMarkdown } from '@/components/PlainMarkdown'
import { TranscriptFold } from '@/components/TranscriptFold'
import { ApiError } from '@/lib/api-fetch'
import { openFiles } from '@/lib/files-opener'
import { useLiveSessions } from '@/lib/frame/live'
import {
  clock,
  countOf,
  type HistoryEvent,
  STANDING_CHIP,
  STANDING_TEXT,
  standing,
  tokenLine,
  toolName,
} from '@/lib/history'
import {
  eventsBefore,
  useHistoryEvents,
  useHistorySession,
} from '@/lib/hooks/use-history'

/** A file the agent linked: opens in the session view's Files, when one is on screen. */
const openPath = (path: string) => openFiles({ kind: 'path', path })

const ROLE: Record<HistoryEvent['role'], string> = {
  user: 'You',
  assistant: 'Assistant',
  tool: 'Tool',
  system: 'Aico',
}

function refusal(error: unknown, what: string): string {
  if (error instanceof ApiError && error.status === 404)
    return 'This session is no longer in the list. It may be older than Aico keeps.'
  if (error instanceof ApiError && error.status === 410)
    return 'The tool removed this transcript, so its messages can’t be read. The totals above are still kept.'
  return `${what}: ${(error as Error)?.message || 'the Aico server didn’t answer'}.`
}

function EventItem({ event }: { event: HistoryEvent }) {
  const when = event.at === null ? '' : clock(event.at)
  const head = (
    <>
      <span className="who">
        {event.kind === 'tool_call'
          ? (event.tool ?? 'Tool call')
          : ROLE[event.role]}
      </span>
      {event.kind === 'thinking' && <span className="kind">thinking</span>}
      {event.kind === 'tool_result' && <span className="kind">result</span>}
      {when && <span className="at">{when}</span>}
    </>
  )
  // Results and thinking are long and rarely the point: folded until opened.
  if (event.kind === 'tool_result' || event.kind === 'thinking')
    return (
      <TranscriptFold
        className={event.role}
        summary={
          <>
            {head}
            <span className="peek">
              {event.text.slice(0, 90).replace(/\s+/g, ' ')}
            </span>
          </>
        }
      >
        {event.text}
      </TranscriptFold>
    )
  return (
    <div className={`history-event ${event.role} ${event.kind}`}>
      <div className="head">{head}</div>
      {event.kind === 'tool_call' ? (
        <code>{event.text}</code>
      ) : event.role === 'assistant' ? (
        // What the agent said is markdown: shown formatted, as in the final reply.
        <PlainMarkdown
          text={event.text}
          className="lantern-ask-body"
          onOpenPath={openPath}
        />
      ) : (
        <pre>{event.text}</pre>
      )}
    </div>
  )
}

/** One session: its totals, then what was said and done, newest at the bottom. */
export function HistoryTranscript({ id }: { id: string }) {
  const detail = useHistorySession(id)
  const newest = useHistoryEvents(id)
  const [older, setOlder] = useState<HistoryEvent[]>([])
  const [cursor, setCursor] = useState<number | null | undefined>(undefined)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [olderError, setOlderError] = useState<string | null>(null)
  // Older pages belong to the newest page they were fetched against.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the session or a fresh newest page arrives
  useEffect(() => {
    setOlder([])
    setCursor(undefined)
    setOlderError(null)
  }, [id, newest.dataUpdatedAt])

  const session = detail.data
  const now = Date.now()
  const olderCursor =
    cursor === undefined ? (newest.data?.older ?? null) : cursor

  const showOlder = async () => {
    if (olderCursor === null) return
    setLoadingOlder(true)
    setOlderError(null)
    try {
      const page = await eventsBefore(id, olderCursor)
      setOlder((current) => [...page.items, ...current])
      setCursor(page.older)
    } catch (error) {
      setOlderError(refusal(error, 'Couldn’t load older messages'))
    } finally {
      setLoadingOlder(false)
    }
  }

  const events = [...older, ...(newest.data?.items ?? [])]
  const live = useLiveSessions()
  const liveHere = [...live.bySession.values()].find(
    (item) => item.conversation === id,
  )
  const state = session ? standing(session, now, liveHere) : null
  // The session's last word: the newest thing the assistant said as text.
  const finalReply = [...(newest.data?.items ?? [])]
    .reverse()
    .find((event) => event.role === 'assistant' && event.kind === 'text')

  return (
    <>
      <header className="status-head">
        <Link
          href="/history"
          className="lantern-icon-btn"
          aria-label="Back to recent sessions"
          title="Back to recent sessions"
        >
          <ArrowLeft className="h-[18px] w-[18px]" strokeWidth={1.7} />
        </Link>
        <span className="crumb">
          <Link href="/history">Recent sessions</Link> /
        </span>
        <h1>{session ? (session.project ?? 'Session') : 'Session'}</h1>
        {session && state && (
          <span className={`status-chip ${STANDING_CHIP[state]}`}>
            {STANDING_TEXT[state]}
          </span>
        )}
        <button
          type="button"
          className="lantern-btn ghost small"
          disabled={newest.isFetching}
          onClick={() => {
            void detail.refetch()
            void newest.refetch()
          }}
        >
          <RefreshCw
            className="h-3.5 w-3.5"
            strokeWidth={1.7}
            aria-hidden="true"
          />
          {newest.isFetching ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      {detail.isPending && (
        <p className="status-muted">Loading this session…</p>
      )}
      {detail.isError && (
        <div className="status-notice bad" role="alert">
          <p>
            <b>Couldn’t load this session.</b>{' '}
            {refusal(detail.error, 'The Aico server didn’t answer')}
          </p>
          <button
            type="button"
            className="lantern-btn small"
            onClick={() => void detail.refetch()}
          >
            Try again
          </button>
        </div>
      )}
      {session && (
        <dl className="history-facts" data-testid="history-facts">
          <div>
            <dt>Tool</dt>
            <dd>
              {toolName(session.tool)} · {session.model ?? 'model not recorded'}
            </dd>
          </div>
          <div>
            <dt>Folder</dt>
            <dd className="mono">{session.cwd ?? 'not recorded'}</dd>
          </div>
          <div>
            <dt>Time</dt>
            <dd>
              {clock(session.startedAt)} to {clock(session.endedAt)}
            </dd>
          </div>
          <div>
            <dt>Tokens</dt>
            <dd>{tokenLine(session.tokens)}</dd>
          </div>
          <div>
            <dt>Work</dt>
            <dd>
              {countOf(session.toolCalls, 'tool call')} ·{' '}
              {countOf(session.files.length, 'file')} written
              {session.subagents.count > 0 &&
                ` · ${countOf(session.subagents.count, 'subagent')} (${countOf(session.subagents.toolCalls, 'tool call')}, ${tokenLine(session.subagents.tokens)})`}
            </dd>
          </div>
          {session.files.length > 0 && (
            <div>
              <dt>Files</dt>
              <dd>
                <details>
                  <summary>
                    Show {countOf(session.files.length, 'file')}
                  </summary>
                  <ul className="mono">
                    {session.files.map((file) => (
                      <li key={file.path}>
                        {file.path}
                        {file.writes > 1 && ` (${file.writes} writes)`}
                      </li>
                    ))}
                  </ul>
                </details>
              </dd>
            </div>
          )}
        </dl>
      )}

      {finalReply && (
        <section
          aria-label={liveHere ? 'Latest reply' : 'Final reply'}
          className="history-final"
          data-testid="history-final"
        >
          <h2 className="lantern-sec">
            {liveHere ? 'Latest reply' : 'Final reply'}
            {finalReply.at !== null && (
              <span className="n">{clock(finalReply.at)}</span>
            )}
          </h2>
          <PlainMarkdown
            text={finalReply.text}
            className="lantern-ask-body"
            onOpenPath={openPath}
          />
        </section>
      )}

      <section aria-label="Transcript" className="history-events">
        {newest.isPending && (
          <p className="status-muted">Loading the transcript…</p>
        )}
        {newest.isError && (
          <div className="status-notice bad" role="alert">
            <p>
              <b>Couldn’t load the transcript.</b>{' '}
              {refusal(newest.error, 'The Aico server didn’t answer')}
            </p>
            {!(
              newest.error instanceof ApiError &&
              newest.error.status >= 400 &&
              newest.error.status < 500
            ) && (
              <button
                type="button"
                className="lantern-btn small"
                onClick={() => void newest.refetch()}
              >
                Try again
              </button>
            )}
          </div>
        )}
        {newest.data && events.length === 0 && (
          <div className="status-rows">
            <div className="status-empty">
              <h3>No messages yet</h3>
              This session has no messages Aico can show.
            </div>
          </div>
        )}
        {olderCursor !== null && newest.data && (
          <div className="history-older">
            <button
              type="button"
              className="lantern-btn small"
              disabled={loadingOlder}
              onClick={() => void showOlder()}
            >
              {loadingOlder ? 'Loading…' : 'Show older messages'}
            </button>
            {olderError && (
              <p className="status-muted" role="alert">
                {olderError}
              </p>
            )}
          </div>
        )}
        {events.map((event) => (
          <EventItem
            key={event.offset + event.kind + event.text.length}
            event={event}
          />
        ))}
      </section>
    </>
  )
}
