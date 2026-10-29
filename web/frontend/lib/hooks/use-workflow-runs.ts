'use client'

import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import type { RunMember, RunsAnswer } from 'tether/teams'
import { apiFetch } from '../api-fetch'

/** How often the open page asks for the workflow runs while it is visible. */
export const RUNS_POLL_MS = 3_000

const NO_ITEMS: RunMember[] = []

/**
 * - `loading`: not asked yet, so nothing is known about runs.
 * - `ok`: Agent Hub was read.
 * - `stale`: the last read failed; the rows are the last good ones.
 * - `unavailable`: Agent Hub has not been read; there are no rows to trust.
 */
export type RunsState = 'loading' | 'ok' | 'stale' | 'unavailable'

export interface WorkflowRuns {
  items: RunMember[]
  state: RunsState
  /** Why the rows may be wrong, in plain words; null when `ok` or `loading`. */
  notice: string | null
  /** Runs (not steps) waiting on the owner. */
  needsYouCount: number
}

/** The words for a notice about the runs, or null when they are fine. */
export function runsNotice(
  state: RunsState,
  reason: string | null,
): string | null {
  if (state === 'stale')
    return `Workflow runs may be out of date${reason ? `: ${reason}` : ''}`
  if (state === 'unavailable')
    return `Workflow runs unavailable${reason ? `: ${reason}` : ''}`
  return null
}

export function useWorkflowRuns(): WorkflowRuns {
  const query = useQuery({
    queryKey: ['workflow-runs'],
    queryFn: ({ signal }) =>
      apiFetch<RunsAnswer>(
        '/api/runs',
        { signal, cache: 'no-store' },
        'Could not load workflow runs',
      ),
    refetchInterval: RUNS_POLL_MS,
    refetchIntervalInBackground: false,
    retry: false,
  })

  const answer = query.data
  return useMemo(() => {
    const items = answer?.items ?? NO_ITEMS
    let state: RunsState = 'loading'
    let reason: string | null = null
    if (answer) {
      state = answer.status
      reason = answer.error
      // This page could not ask the server just now: the rows are the last answer.
      if (query.isError && answer.status === 'ok') {
        state = 'stale'
        reason = 'Aico could not be reached'
      }
    } else if (query.isError) {
      state = 'unavailable'
      reason = query.error instanceof Error ? query.error.message : null
    }
    return {
      items,
      state,
      notice: runsNotice(state, reason),
      needsYouCount: items.filter(
        (member) => member.kind === 'run' && member.group === 'needs-you',
      ).length,
    }
  }, [answer, query.isError, query.error])
}
