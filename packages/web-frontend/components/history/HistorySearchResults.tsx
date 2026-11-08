'use client'

import { RefreshCw } from 'lucide-react'
import Link from 'next/link'
import { useEffect } from 'react'
import {
  agoAt,
  countOf,
  type HistorySearchHit,
  sessionHref,
  toolList,
  toolName,
} from '@/lib/history'
import { useClock } from '@/lib/hooks/use-clock'
import { useHistorySearch } from '@/lib/hooks/use-history'
import { useSessionLabels } from '@/lib/hooks/use-session-labels'
import { SkeletonRows } from '../status/SkeletonRows'
import { Marked } from './Marked'

function who(hit: HistorySearchHit): string {
  if (hit.kind === 'tool_call') return hit.tool ?? 'Tool call'
  return hit.role === 'user' ? 'You' : 'Assistant'
}

/** Past sessions whose messages contain the text: what was searched, then one block per session. */
export function HistorySearchResults({
  query,
  tool,
  showTests,
  onTests,
}: {
  query: string
  tool: string
  showTests: boolean
  /** How many test runs the results hold, for the page's Show/Hide button. */
  onTests: (count: number) => void
}) {
  const search = useHistorySearch(query, tool)
  const labelOf = useSessionLabels()
  const now = useClock(30_000)
  const page = search.data
  const items = page?.items ?? []
  const shown = showTests ? items : items.filter((item) => !item.session.test)
  const tests = items.filter((item) => item.session.test).length
  // biome-ignore lint/correctness/useExhaustiveDependencies: tell the page how many test runs there are when the answer changes
  useEffect(() => onTests(tests), [tests])
  const covers = page ? toolList(page.covers) : null
  // Out of read or time budget (not the limit): says how far back it got.
  const budget = page?.more === true && page.stop === 'budget'
  const reach =
    page && page.searched.since !== null
      ? ` back to ${agoAt(page.searched.since, now)}`
      : ''

  return (
    <section aria-label="Search results" data-testid="history-search-results">
      {search.isPending && (
        <>
          <p className="status-muted">Searching past sessions…</p>
          <SkeletonRows />
        </>
      )}
      {search.isError && (
        <div className="status-notice bad" role="alert">
          <p>
            <b>Couldn’t search the sessions.</b>{' '}
            {(search.error as Error | null)?.message ||
              'The Aico server didn’t answer'}
            . Your sessions are still on disk; try the search again.
          </p>
          <button
            type="button"
            className="lantern-btn small"
            disabled={search.isFetching}
            onClick={() => void search.refetch()}
          >
            <RefreshCw
              className="h-3.5 w-3.5"
              strokeWidth={1.7}
              aria-hidden="true"
            />
            {search.isFetching ? 'Trying…' : 'Try again'}
          </button>
        </div>
      )}
      {page && (
        <p className="status-muted history-scope">
          {countOf(shown.length, 'session')} with “{page.query}”{' · searched '}
          {covers}
          {' (Antigravity and Aico agent chats are not searchable yet)'}
          {page.more &&
            (budget
              ? ` · read the newest ${countOf(page.searched.sessions, 'session')}${reach}, then hit the search’s read limit; older ones not read`
              : ' · newest first; older ones not searched')}
        </p>
      )}
      {page && shown.length === 0 && (
        <div className="status-rows">
          <div className="status-empty">
            <h3>Nothing found for “{page.query}”</h3>
            {budget
              ? `None of the newest ${countOf(page.searched.sessions, 'session')}${reach} has these words in a message or a command it ran. Older ones were not read: the search hit its read limit.`
              : `None of the ${tool ? toolName(tool) : covers} sessions Aico kept has these words in a message or a command it ran.`}
            {!showTests &&
              tests > 0 &&
              ` ${countOf(tests, 'test run')} hidden.`}
          </div>
        </div>
      )}
      {shown.length > 0 && (
        <div className="history-hits" data-testid="history-hits">
          {shown.map(({ session, matches, hits }) => (
            <div key={session.id} className="history-hit">
              <Link
                href={sessionHref(session.id, hits[0]?.offset, query)}
                className="head"
              >
                <span className="what">{labelOf(session)}</span>
                <span className="when">{agoAt(session.endedAt, now)}</span>
              </Link>
              <div className="meaning">
                {session.project ?? 'Unknown project'} ·{' '}
                {toolName(session.tool)} ·{' '}
                {countOf(matches, 'match', 'matches')}
              </div>
              {hits.map((hit) => (
                <Link
                  key={hit.offset}
                  href={sessionHref(session.id, hit.offset, query)}
                  className="snippet"
                >
                  <span className="who">{who(hit)}</span>
                  <span className="text">
                    <Marked text={hit.snippet} query={query} />
                  </span>
                </Link>
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
