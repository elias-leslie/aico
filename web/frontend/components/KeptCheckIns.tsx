'use client'

import { useCheckInActions, useKeptCheckIns } from '@/lib/hooks/use-check-ins'

/** Check-ins kept past their session's End. Each starts a new session when
 * due; Cancel drops it. Nothing shows while there are none. */
export function KeptCheckIns() {
  const { data } = useKeptCheckIns()
  const { cancel } = useCheckInActions()
  if (!data?.length) return null
  return (
    <section data-testid="kept-check-ins" aria-label="Kept check-ins">
      <h3 className="lantern-sec mx-2.5 mt-3.5 mb-1.5">
        Kept check-ins
        <span className="n">{data.length}</span>
      </h3>
      <ul>
        {data.map((checkIn) => (
          <li
            key={checkIn.id}
            className="flex items-center gap-2 px-2.5 py-1.5"
          >
            <div className="min-w-0 flex-1">
              <div
                className="truncate"
                style={{ font: '450 14px/1.3 var(--font-display)' }}
              >
                {checkIn.session}
              </div>
              <div className="text-xs" style={{ color: 'var(--mist)' }}>
                {checkIn.failed
                  ? `${checkIn.time} · last restart failed`
                  : checkIn.time}
              </div>
            </div>
            <button
              type="button"
              className="lantern-btn ghost"
              style={{ height: 32, padding: '0 10px' }}
              disabled={cancel.isPending}
              aria-label={`Cancel kept check-in for ${checkIn.session} at ${checkIn.time}`}
              onClick={() => cancel.mutate(checkIn.id)}
            >
              Cancel
            </button>
          </li>
        ))}
      </ul>
      {cancel.error && (
        <p role="alert" className="px-2.5 py-1 text-xs">
          {cancel.error.message}
        </p>
      )}
    </section>
  )
}
