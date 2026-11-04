'use client'

import { HistoryList } from './HistoryList'
import { HistoryTranscript } from './HistoryTranscript'

/** Recent sessions, or one session's transcript when `session` names it. */
export function HistoryPage({ session = '' }: { session?: string }) {
  return (
    <main className="status-page history-page">
      <div className="status">
        {session ? <HistoryTranscript id={session} /> : <HistoryList />}
      </div>
    </main>
  )
}
