import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { ApiError, apiFetch } from '@/lib/api-fetch'
import { STATUS_QUERY_KEY } from '@/lib/hooks/use-status'
import { RECOVERY_QUERY_KEY } from '@/lib/hooks/use-status-sessions'
import type { ButtonKind, SessionInfo, StatusRow } from '@/lib/status'

const TOAST_MS = 2_600

export type Sheet =
  | { kind: 'row'; id: string }
  | { kind: 'log'; id: string }
  | { kind: 'look'; id: string }
  | { kind: 'filters' }
  | { kind: 'hosts' }
  | null

export interface Toast {
  text: string
  href?: string
}

/** The row buttons' work: run a row now, resume a session, open one or a sheet; and the toast that says how it went. */
export function useStatusActions(
  sessions: SessionInfo,
  setSheet: (sheet: Sheet) => void,
) {
  const router = useRouter()
  const queryClient = useQueryClient()
  // Runs this page started and is waiting on; the server's list covers the rest.
  const [starting, setStarting] = useState<ReadonlySet<string>>(new Set())
  const [toast, setToast] = useState<Toast | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  )
  useEffect(() => () => clearTimeout(toastTimer.current), [])

  const say = (next: Toast) => {
    clearTimeout(toastTimer.current)
    setToast(next)
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS)
  }
  const run = async (row: StatusRow) => {
    setStarting((current) => new Set(current).add(row.id))
    try {
      const ran = await apiFetch<{ state: string; lines: string[] }>(
        '/api/status/run',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: row.id }),
        },
        'Couldn’t run it',
      )
      if (ran.state === 'failed')
        say({
          text: `“${row.what}” didn’t run: ${ran.lines.at(-1) ?? 'it ended with an error.'}`,
        })
      else
        say({ text: `Started “${row.what}”. The row updates when it reports.` })
    } catch (error) {
      say({
        text:
          error instanceof ApiError && error.status === 409
            ? `“${row.what}” is still running. The row updates when it reports.`
            : `“${row.what}” didn’t run: ${(error as Error).message}`,
      })
    } finally {
      // Read the rows again first: the server's running list takes over without a flicker.
      await queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY })
      setStarting((current) => {
        const next = new Set(current)
        next.delete(row.id)
        return next
      })
    }
  }
  const resume = async (id: string) => {
    const name = sessions.names?.get(id) ?? 'The session'
    try {
      const answer = await apiFetch<{
        results: { ok: boolean; reason: string | null }[]
      }>(
        '/api/recovery/resume',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        },
        'Couldn’t resume it',
      )
      const failed = answer.results.find((result) => !result.ok)
      say({
        text: failed
          ? `“${name}” didn’t resume: ${failed.reason ?? 'Tether refused it.'}`
          : `Resuming “${name}”. It’s back in your session list in a moment.`,
        href: failed ? undefined : `/?session=${encodeURIComponent(id)}`,
      })
    } catch (error) {
      say({ text: `“${name}” didn’t resume: ${(error as Error).message}` })
    } finally {
      await queryClient.invalidateQueries({ queryKey: RECOVERY_QUERY_KEY })
      await queryClient.invalidateQueries({ queryKey: ['terminal-sessions'] })
    }
  }
  const act = (kind: ButtonKind, row: StatusRow, ref: string) => {
    if (kind === 'run') return void run(row)
    if (kind === 'hosts') return setSheet({ kind: 'hosts' })
    if (kind === 'resume') return void resume(ref)
    if (kind === 'open')
      return router.push(`/?session=${encodeURIComponent(ref)}`)
    if (kind === 'log' || kind === 'look') return setSheet({ kind, id: row.id })
  }
  return { starting, toast, say, act }
}
