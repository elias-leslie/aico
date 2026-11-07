'use client'

import { RefreshCw, Search } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useLiveSessions } from '@/lib/frame/live'
import {
  agoAt,
  clock,
  count,
  countOf,
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
import { useSessionLabels } from '@/lib/hooks/use-session-labels'
import { SkeletonRows } from '../status/SkeletonRows'
import styles from './HistoryList.module.css'
import { HistorySearchResults } from './HistorySearchResults'

/** The list of recent sessions, newest first, one link each to its transcript. */
export function HistoryList({
  failedOnly = false,
  search = '',
}: {
  failedOnly?: boolean
  search?: string
}) {
  const [tool, setTool] = useState('')
  const [onlyFailed, setOnlyFailed] = useState(failedOnly)
  useEffect(() => setOnlyFailed(failedOnly), [failedOnly])
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
  const live = useLiveSessions()
  const labelOf = useSessionLabels()
  // A session a running session owns takes that session's state.
  const liveOf = (id: string) =>
    [...live.bySession.values()].find((item) => item.conversation === id)
  const [showTests, setShowTests] = useState(false)
  // The search box: results replace the list once two characters are typed.
  const [text, setText] = useState(search)
  const [query, setQuery] = useState(search.trim())
  const [searchTests, setSearchTests] = useState(0)
  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), 300)
    return () => clearTimeout(timer)
  }, [text])
  const searching = query.length >= 2
  const tests = items?.filter((session) => session.test).length ?? 0
  const visible = showTests ? items : items?.filter((session) => !session.test)
  // Failed means the session's last turn ended in an error (a running session is never failed).
  const shown = onlyFailed
    ? visible?.filter(
        (session) => standing(session, now, liveOf(session.id)) === 'failed',
      )
    : visible

  const sub = searching
    ? 'Search'
    : loading
      ? 'Loading…'
      : failed
        ? 'Not loaded'
        : stale
          ? `As of ${clock(readAt)} · couldn’t refresh`
          : shown?.length
            ? `${countOf(shown.length, 'session')} · updated ${agoAt(readAt, now)}`
            : 'None yet'

  return (
    <>
      <header className="status-head">
        <h1>Recent sessions</h1>
        <span className="sub">{sub}</span>
      </header>
      <div className="history-search">
        <label className="lantern-field">
          <Search className="h-4 w-4" strokeWidth={1.7} aria-hidden="true" />
          <input
            type="search"
            aria-label="Search past sessions"
            placeholder="Search what was said or run"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        {text.trim().length === 1 && (
          <span className="status-muted">
            Type one more character to search.
          </span>
        )}
      </div>
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
        {onlyFailed && (
          <button
            type="button"
            className="lantern-btn ghost small"
            aria-pressed="true"
            onClick={() => setOnlyFailed(false)}
          >
            Failed only · Show all
          </button>
        )}
        {(searching ? searchTests : tests) > 0 && (
          <button
            type="button"
            className="lantern-btn ghost small"
            aria-pressed={showTests}
            onClick={() => setShowTests(!showTests)}
          >
            {showTests
              ? 'Hide test runs'
              : `${countOf(searching ? searchTests : tests, 'test run')} hidden · Show`}
          </button>
        )}
      </div>

      {searching && (
        <HistorySearchResults
          query={query}
          tool={tool}
          showTests={showTests}
          onTests={setSearchTests}
        />
      )}
      {!searching && failed && (
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
      {!searching && stale && (
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

      {!searching && loading && (
        <>
          <p className="status-muted">Loading recent sessions…</p>
          <SkeletonRows />
        </>
      )}
      {!searching && failed && (
        <div className="status-rows">
          <div className="status-empty">
            <h3>No sessions to show</h3>
            The list comes back when the server answers.
          </div>
        </div>
      )}
      {!searching && shown && shown.length === 0 && (
        <div className="status-rows">
          <div className="status-empty">
            <h3>
              {onlyFailed
                ? 'No failed sessions'
                : tool
                  ? `No ${toolName(tool)} sessions yet`
                  : 'No sessions yet'}
            </h3>
            {onlyFailed && 'None of the recent sessions ended in an error. '}
            {tests > 0 && `${countOf(tests, 'test run')} hidden. `}
            Aico reads the sessions Claude Code, Codex and Pi keep on this host
            about every 15 seconds. None has turned up in the recent days it
            looks back over.
          </div>
        </div>
      )}
      {!searching && shown && shown.length > 0 && (
        <div
          className={`status-rows ${styles.rows}`}
          data-testid="history-rows"
        >
          {shown.map((session) => {
            const state = standing(session, now, liveOf(session.id))
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
                  <div className="what">{labelOf(session)}</div>
                  <div className="meaning">
                    {session.project ??
                      (shortFolder(session.cwd) || 'Unknown project')}{' '}
                    · {toolName(session.tool)} ·{' '}
                    {session.model ?? 'model not recorded'}
                    {session.cwd && (
                      <span className="mono">
                        {' '}
                        · {shortFolder(session.cwd)}
                      </span>
                    )}
                  </div>
                  <div className="meta-m">
                    {countOf(session.toolCalls, 'tool call')} ·{' '}
                    {tokenLine(session.tokens)}
                  </div>
                </div>
                <div className="when">
                  <b>{agoAt(session.endedAt, now)}</b>
                  <span className="sec">
                    started {clock(session.startedAt)}
                  </span>
                </div>
                <div className="where">
                  <b>{countOf(session.toolCalls, 'tool call')}</b>
                  <span className="sec">
                    {tokenLine(session.tokens)}
                    {session.filesWritten > 0 &&
                      ` · ${countOf(session.filesWritten, 'file')} written`}
                  </span>
                </div>
              </Link>
            )
          })}
        </div>
      )}
      {!searching && items && items.length >= 100 && (
        <p className="status-muted history-cap">
          Showing the newest {count(items.length)}.
        </p>
      )}
    </>
  )
}
