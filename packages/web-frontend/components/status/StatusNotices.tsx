'use client'

import { RefreshCw, Server } from 'lucide-react'
import { at, plural, type StatusRow, silentMachines } from '@/lib/status'

type Mode = 'loading' | 'failed' | 'empty' | 'live'

/** What the page can't show: the server not answering, a machine gone quiet, or rows read a while ago. */
export function StatusNotices({
  mode,
  rows,
  hostNames,
  stale,
  readAt,
  failedAt,
  now,
  refreshing,
  onRefetch,
  onHosts,
}: {
  mode: Mode
  rows: StatusRow[]
  /** The machines the Hosts sheet can open. */
  hostNames: ReadonlySet<string>
  stale: boolean
  readAt: number | null
  failedAt: number | null
  now: number
  refreshing: boolean
  onRefetch: () => void
  onHosts: () => void
}) {
  const silent = silentMachines(rows)
  return (
    <>
      {mode === 'failed' && (
        <div className="status-notice bad" role="alert">
          <p>
            <b>Couldn’t load status.</b> The Aico server didn’t answer at{' '}
            {at(failedAt, now)}. Nothing here counts as healthy until it does.
          </p>
          <button
            type="button"
            className="lantern-btn small"
            disabled={refreshing}
            onClick={onRefetch}
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
      {mode === 'live' &&
        silent.map((machine) => (
          <div
            key={machine.machine}
            className="status-notice wait"
            role="status"
          >
            <p>
              <b>{machine.machine} isn’t answering.</b> No word since{' '}
              {at(machine.since ? Date.parse(machine.since) : null, now)}, so
              its {plural(machine.rows, 'row')}{' '}
              {machine.rows === 1 ? 'shows' : 'show'} unknown. The rest are
              current.
            </p>
            {hostNames.has(machine.machine) && (
              <button
                type="button"
                className="lantern-btn small primary"
                onClick={onHosts}
              >
                <Server
                  className="h-3.5 w-3.5"
                  strokeWidth={1.7}
                  aria-hidden="true"
                />
                Hosts
              </button>
            )}
          </div>
        ))}
      {stale && (
        <div className="status-notice wait" role="status">
          <p>
            <b>
              Showing status from {at(readAt, now)},{' '}
              {readAt
                ? `${Math.max(1, Math.round((now - readAt) / 60_000))} min ago`
                : ''}
              .
            </b>{' '}
            Couldn’t refresh: no connection to Aico. States may have changed
            since.
          </p>
          <button
            type="button"
            className="lantern-btn small"
            disabled={refreshing}
            onClick={onRefetch}
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
    </>
  )
}
