'use client'

import { ArrowLeft, RefreshCw } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import {
  ago,
  clock,
  count,
  plural,
  STANDING_CHIP,
  STANDING_TEXT,
  sessionHref,
  shortFolder,
  standing,
  TOOLS,
  tokenLine,
  toolName,
} from '@/lib/history'
import { useClock } from '@/lib/hooks/use-clock'
import { useHistory } from '@/lib/hooks/use-history'

/** The list of recent sessions, newest first, one link each to its transcript. */
export function HistoryList() {
  const [tool, setTool] = useState('')
  const {
    items,
    loading,
    failed,
    error,
    stale,
    readAt,
    failedAt,
    refetch,
    refreshing,
  } = useHistory(tool)
  const now = useClock(30_000)

  const sub = loading
    ? 'Loading…'
    : failed
      ? 'Not loaded'
      : stale
        ? `As of ${clock(readAt)} · couldn’t refresh`
        : items?.length
          ? `${plural(items.length, 'session')} · updated ${ago(readAt, now)}`
          : 'None yet'

  return (
    <>
      <header className="status-head">
        <Link
          href="/"
          className="lantern-icon-btn"
          aria-label="Back to sessions"
          title="Back to sessions"
        >
          <ArrowLeft className="h-[18px] w-[18px]" strokeWidth={1.7} />
        </Link>
        <h1>Recent sessions</h1>
        <span className="sub">{sub}</span>
      </header>
      <div className="status-filters">
        <select
          className={`status-select${tool ? ' set' : ''}`}
          aria-label="Tool"
          value={tool}
          onChange={(event) => setTool(event.target.value)}
        >
          <option value="">All tools</option>
          {TOOLS.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </div>

      {failed && (
        <div className="status-notice bad" role="alert">
          <p>
            <b>Couldn’t load recent sessions.</b>{' '}
            {error?.message || 'The Aico server didn’t answer'} at{' '}
            {clock(failedAt)}. The sessions are still on disk; this list comes
            back when the server answers.
          </p>
          <button
            type="button"
            className="lantern-btn small"
            disabled={refreshing}
            onClick={() => void refetch()}
          >
            <RefreshCw
              className="h-3.5 w-3.5"
              strokeWidth={1.7}
              aria-hidden="true"
            />
            {refreshing ? 'Trying…' : 'Try again'}
          </button>
        </div>
      )}
      {stale && (
        <div className="status-notice wait" role="status">
          <p>
            <b>Showing the list from {clock(readAt)}.</b> Couldn’t refresh it,
            so newer sessions may be missing.
          </p>
          <button
            type="button"
            className="lantern-btn small"
            disabled={refreshing}
            onClick={() => void refetch()}
          >
            <RefreshCw
              className="h-3.5 w-3.5"
              strokeWidth={1.7}
              aria-hidden="true"
            />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      )}

      {loading && (
        <>
          <p className="status-muted">Loading recent sessions…</p>
          <div className="status-rows skeleton" aria-hidden="true">
            {[30, 45, 25].map((width) => (
              <div key={width} className="status-row">
                <div>
                  <span className="bar pill" />
                </div>
                <div>
                  <div className="bar" style={{ width: `${width}%` }} />
                  <div
                    className="bar dim"
                    style={{ width: `${width + 20}%` }}
                  />
                </div>
                <div className="when">—</div>
              </div>
            ))}
          </div>
        </>
      )}
      {failed && (
        <div className="status-rows">
          <div className="status-empty">
            <h3>No sessions to show</h3>
            The list comes back when the server answers.
          </div>
        </div>
      )}
      {items && items.length === 0 && (
        <div className="status-rows">
          <div className="status-empty">
            <h3>
              {tool ? `No ${toolName(tool)} sessions yet` : 'No sessions yet'}
            </h3>
            Aico reads the sessions Claude Code, Codex and Pi keep on this host
            about every 15 seconds. None has turned up in the recent days it
            looks back over.
          </div>
        </div>
      )}
      {items && items.length > 0 && (
        <div className="status-rows" data-testid="history-rows">
          {items.map((session) => {
            const state = standing(session, now)
            return (
              <Link
                key={session.id}
                href={sessionHref(session.id)}
                className="status-row history-row"
              >
                <div className="chipcell">
                  <span className={`status-chip ${STANDING_CHIP[state]}`}>
                    {STANDING_TEXT[state]}
                  </span>
                </div>
                <div className="main-cell">
                  <div className="what">
                    {session.project ??
                      (shortFolder(session.cwd) || 'Unknown project')}
                  </div>
                  <div className="meaning">
                    {toolName(session.tool)} ·{' '}
                    {session.model ?? 'model not recorded'}
                    {session.cwd && (
                      <span className="mono">
                        {' '}
                        · {shortFolder(session.cwd)}
                      </span>
                    )}
                  </div>
                  <div className="meta-m">
                    {plural(session.toolCalls, 'tool call')} ·{' '}
                    {tokenLine(session.tokens)}
                  </div>
                </div>
                <div className="when">
                  <b>{ago(session.endedAt, now)}</b>
                  <span className="sec">
                    started {clock(session.startedAt)}
                  </span>
                </div>
                <div className="where">
                  <b>{plural(session.toolCalls, 'tool call')}</b>
                  <span className="sec">
                    {tokenLine(session.tokens)}
                    {session.filesWritten > 0 &&
                      ` · ${plural(session.filesWritten, 'file')} written`}
                  </span>
                </div>
              </Link>
            )
          })}
        </div>
      )}
      {items && items.length >= 100 && (
        <p className="status-muted history-cap">
          Showing the newest {count(items.length)}.
        </p>
      )}
    </>
  )
}
