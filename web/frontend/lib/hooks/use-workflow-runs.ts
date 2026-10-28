'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import type { RunDecision, RunMember, RunsAnswer } from 'tether/client'
import { apiFetch } from '../api-fetch'

/** How often the open page asks for the workflow runs while it is visible. */
export const RUNS_POLL_MS = 3_000

const NO_ITEMS: RunMember[] = []

/** What the owner asks of a run or one of its steps. */
export type RunAct =
  | { type: 'resume'; member: RunMember; action: RunDecision }
  | { type: 'cancel'; member: RunMember }
  | { type: 'dismiss'; member: RunMember }

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
  /** Throws the refusal's words when the answer did not go through. */
  act(action: RunAct): Promise<void>
}

const post = (path: string, body?: unknown) =>
  apiFetch<{ ok: true }>(
    path,
    {
      method: 'POST',
      headers:
        body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    'Could not change the run',
  )

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
  const queryClient = useQueryClient()
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

  const mutation = useMutation({
    mutationFn: (action: RunAct) => {
      const { runId, stepKey } = action.member
      const run = `/api/runs/${encodeURIComponent(runId)}`
      if (action.type === 'resume')
        return post(`${run}/resume`, { action: action.action, stepKey })
      if (action.type === 'cancel') return post(`${run}/cancel`, { stepKey })
      return post(`${run}/dismiss`)
    },
    // Whatever the answer, read the runs again so the list shows the truth.
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ['workflow-runs'] }),
  })
  const { mutateAsync } = mutation
  const act = useCallback(
    (action: RunAct) => mutateAsync(action).then(() => {}),
    [mutateAsync],
  )

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
      act,
    }
  }, [answer, query.isError, query.error, act])
}
