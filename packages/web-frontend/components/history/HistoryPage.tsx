'use client'

import { HistoryList } from './HistoryList'
import { HistoryTranscript } from './HistoryTranscript'

/** Recent sessions, or one session's transcript when `session` names it. */
export function HistoryPage({
  session = '',
  at = null,
  search = '',
  failedOnly = false,
}: {
  session?: string
  /** A search hit's byte offset: the transcript opens on that message. */
  at?: number | null
  /** Text to search for when the list opens. */
  search?: string
  failedOnly?: boolean
}) {
  return (
    <main className="status-page history-page">
      <div className="status">
        {session ? (
          <HistoryTranscript id={session} at={at} />
        ) : (
          <HistoryList failedOnly={failedOnly} search={search} />
        )}
      </div>
    </main>
  )
}
