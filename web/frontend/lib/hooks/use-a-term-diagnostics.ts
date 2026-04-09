'use client'

import { useCallback, useEffect, useRef } from 'react'
import { buildApiUrl } from '@/lib/api-config'

export interface DiagnosticCounters {
  snapshotReceived: number
  snapshotApplied: number
  snapshotSkippedIdentical: number
  snapshotSkippedPromptInput: number
  deltaApplied: number
  deltaSkippedStale: number
  deltaSkippedInFlight: number
  writesEnqueued: number
  writesFlushed: number
  fullResetApplied: number
}

export interface DiagnosticEntry {
  ts: number
  event: string
  details?: Record<string, unknown>
}

interface BackendSummary {
  session_id: string
  total_events: number
  capacity: number
  counters: Record<string, number>
}

export interface UseATermDiagnosticsReturn {
  enabled: boolean
  countersRef: React.RefObject<DiagnosticCounters>
  logRef: React.RefObject<DiagnosticEntry[]>
  incrementCounter: (counter: keyof DiagnosticCounters, delta?: number) => void
  record: (event: string, details?: Record<string, unknown>) => void
  getDiagnostics: () => {
    frontend: DiagnosticCounters
    log: DiagnosticEntry[]
    backend: BackendSummary | null
  }
}

const LOG_CAPACITY = 500

function isEnabled(): boolean {
  if (typeof window === 'undefined') return false
  if (new URLSearchParams(window.location.search).get('diagnostics') === '1')
    return true
  try {
    return localStorage.getItem('aTerm:diagnostics') === '1'
  } catch {
    return false
  }
}

export function useATermDiagnostics(
  sessionId: string | undefined,
): UseATermDiagnosticsReturn {
  const enabled = useRef(isEnabled())
  const countersRef = useRef<DiagnosticCounters>({
    snapshotReceived: 0,
    snapshotApplied: 0,
    snapshotSkippedIdentical: 0,
    snapshotSkippedPromptInput: 0,
    deltaApplied: 0,
    deltaSkippedStale: 0,
    deltaSkippedInFlight: 0,
    writesEnqueued: 0,
    writesFlushed: 0,
    fullResetApplied: 0,
  })
  const logRef = useRef<DiagnosticEntry[]>([])
  const backendSummaryRef = useRef<BackendSummary | null>(null)

  const record = useCallback(
    (event: string, details?: Record<string, unknown>) => {
      if (!enabled.current) return
      const log = logRef.current
      log.push({ ts: performance.now(), event, details })
      if (log.length > LOG_CAPACITY) {
        log.splice(0, log.length - LOG_CAPACITY)
      }
    },
    [],
  )

  const incrementCounter = useCallback(
    (counter: keyof DiagnosticCounters, delta = 1) => {
      if (!enabled.current) return
      countersRef.current[counter] += delta
    },
    [],
  )

  // Poll backend summary every 2s when enabled
  useEffect(() => {
    if (!enabled.current || !sessionId) return
    let cancelled = false

    const poll = async () => {
      try {
        const res = await fetch(
          buildApiUrl(`/api/diagnostics/sessions/${sessionId}/summary`),
        )
        if (res.ok && !cancelled) {
          backendSummaryRef.current = await res.json()
          // eslint-disable-next-line no-console
          console.table({
            ...countersRef.current,
            ...(backendSummaryRef.current?.counters ?? {}),
          })
        }
      } catch {
        // ignore
      }
    }

    const interval = setInterval(poll, 2000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [sessionId])

  const getDiagnostics = useCallback(
    () => ({
      frontend: { ...countersRef.current },
      log: [...logRef.current],
      backend: backendSummaryRef.current,
    }),
    [],
  )

  useEffect(() => {
    if (!enabled.current || !sessionId || typeof window === 'undefined') return
    const target = window as typeof window & {
      __aTermDiagnostics?: Record<string, ReturnType<typeof getDiagnostics>>
    }
    if (!target.__aTermDiagnostics) {
      target.__aTermDiagnostics = {}
    }
    target.__aTermDiagnostics[sessionId] = getDiagnostics()
    return () => {
      if (target.__aTermDiagnostics) {
        delete target.__aTermDiagnostics[sessionId]
      }
    }
  }, [getDiagnostics, sessionId])

  useEffect(() => {
    if (!enabled.current || !sessionId || typeof window === 'undefined') return
    const target = window as typeof window & {
      __aTermDiagnostics?: Record<string, ReturnType<typeof getDiagnostics>>
    }
    const interval = window.setInterval(() => {
      if (!target.__aTermDiagnostics) return
      target.__aTermDiagnostics[sessionId] = getDiagnostics()
    }, 250)
    return () => window.clearInterval(interval)
  }, [getDiagnostics, sessionId])

  return {
    enabled: enabled.current,
    countersRef,
    logRef,
    incrementCounter,
    record,
    getDiagnostics,
  }
}
