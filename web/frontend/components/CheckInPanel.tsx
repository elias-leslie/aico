'use client'

import { ChevronLeft } from 'lucide-react'
import { useState } from 'react'
import { useCheckInActions, useCheckInMenu } from '@/lib/hooks/use-check-ins'

const ICON = 'h-[18px] w-[18px]'

/** `2026-10-26T17:30`, the value a datetime-local input takes, for a time. */
function localInputValue(at: number): string {
  const date = new Date(at - new Date(at).getTimezoneOffset() * 60_000)
  return date.toISOString().slice(0, 16)
}

/**
 * "Check in later" in the session menu: quick times, a time of your own, and
 * each pending check-in with Cancel. Tether does the waking.
 */
export function CheckInPanel({
  sessionId,
  isMobile = false,
  onBack,
  onDone,
}: {
  sessionId: string
  isMobile?: boolean
  onBack: () => void
  /** A check-in was set: close the menu. */
  onDone: () => void
}) {
  const menu = useCheckInMenu(sessionId)
  const { set, cancel } = useCheckInActions(sessionId)
  const [custom, setCustom] = useState('')
  const rowHeight = isMobile ? 44 : 38
  const error = (set.error ?? cancel.error) as Error | null
  const busy = set.isPending || cancel.isPending

  const setAt = (dueAt: number) => set.mutate(dueAt, { onSuccess: onDone })
  const customAt = custom ? new Date(custom).getTime() : Number.NaN

  return (
    <div role="group" aria-label="Check in later">
      <button
        type="button"
        className="lantern-menu-item"
        style={{ minHeight: rowHeight }}
        onClick={onBack}
        aria-label="Back to the session menu"
      >
        <ChevronLeft className={ICON} strokeWidth={1.7} aria-hidden="true" />
        <span style={{ fontWeight: 600 }}>Check in later</span>
      </button>
      <hr
        className="mx-1.5 my-1 border-0 border-t"
        style={{ borderColor: 'rgb(var(--glass-rgb) / 0.06)' }}
      />

      {menu.isPending && (
        <p className="px-2.5 py-2 text-[13px]" style={{ color: 'var(--mist)' }}>
          Loading times…
        </p>
      )}
      {menu.isError && (
        <p
          role="alert"
          className="px-2.5 py-2 text-[13px]"
          style={{ color: 'var(--bone)' }}
        >
          {menu.error.message}
        </p>
      )}

      {menu.data?.status === 'unsupported' && (
        <p className="px-2.5 py-2 text-[13px]" style={{ color: 'var(--mist)' }}>
          Only Claude Code and Codex sessions take check-ins.
        </p>
      )}

      {menu.data?.status === 'ready' && (
        <>
          {menu.data.choices.map((choice) => (
            <button
              key={choice.label}
              type="button"
              role="menuitem"
              className="lantern-menu-item"
              style={{ minHeight: rowHeight }}
              disabled={busy}
              onClick={() => setAt(choice.dueAt)}
            >
              <span>{choice.label}</span>
              <span
                className="ml-auto text-xs"
                style={{ color: 'var(--mist)' }}
              >
                {choice.time}
              </span>
            </button>
          ))}
          <div className="px-1.5 pt-1.5 pb-1">
            <label
              htmlFor={`check-in-time-${sessionId}`}
              className="mb-1 block pl-1 text-xs"
              style={{ color: 'var(--mist)' }}
            >
              Pick a time
            </label>
            <div className="flex items-center gap-2">
              <input
                id={`check-in-time-${sessionId}`}
                type="datetime-local"
                value={custom}
                min={localInputValue(Date.now())}
                onChange={(event) => setCustom(event.target.value)}
                className="lantern-field min-w-0 flex-1 text-[13px]"
                style={{
                  height: 38,
                  color: 'var(--bone)',
                  colorScheme: 'dark',
                }}
              />
              <button
                type="button"
                className="lantern-btn primary"
                style={{ height: 38 }}
                disabled={busy || Number.isNaN(customAt)}
                onClick={() => setAt(customAt)}
              >
                Set
              </button>
            </div>
          </div>
        </>
      )}

      {!!menu.data?.pending.length && (
        <>
          <hr
            className="mx-1.5 my-1 border-0 border-t"
            style={{ borderColor: 'rgb(var(--glass-rgb) / 0.06)' }}
          />
          <ul aria-label="Pending check-ins">
            {menu.data.pending.map((wake) => (
              <li
                key={wake.id}
                className="flex items-center gap-2 px-2.5"
                style={{ minHeight: rowHeight }}
              >
                <span className="text-[13px]">Check-in {wake.time}</span>
                <button
                  type="button"
                  className="lantern-btn ghost ml-auto"
                  style={{ height: 32, padding: '0 10px' }}
                  disabled={busy}
                  aria-label={`Cancel check-in at ${wake.time}`}
                  onClick={() => cancel.mutate(wake.id)}
                >
                  Cancel
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {error && (
        <p
          role="alert"
          className="px-2.5 py-2 text-[13px]"
          style={{ color: 'var(--bone)' }}
        >
          {error.message}
        </p>
      )}
    </div>
  )
}
