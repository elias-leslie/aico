'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { type Design, fetchDesigns } from '../api/designs'
import { loadState } from './load-state'

const DESIGNS_KEY = ['designs'] as const
/** An agent re-adding a design shows within this long (and at once on coming back to the window). */
const POLL_MS = 4_000

/** Every project's designs, polled so a design an agent adds again refreshes where it is open. */
export function useDesigns() {
  const client = useQueryClient()
  const query = useQuery({
    queryKey: DESIGNS_KEY,
    queryFn: ({ signal }) => fetchDesigns(signal),
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
    staleTime: 0,
  })
  /** Put a changed design (a saved note, a choice) into the list without waiting for the poll. */
  const replace = useCallback(
    (design: Design) =>
      client.setQueryData<{ items: Design[]; unreadable: number }>(
        DESIGNS_KEY,
        (previous) =>
          previous && {
            ...previous,
            items: previous.items.map((item) => {
              if (item.id === design.id) return design
              return design.state === 'selected' &&
                item.askId === design.askId &&
                item.project === design.project
                ? { ...item, state: 'passed' as const }
                : item
            }),
          },
      ),
    [client],
  )
  return {
    designs: query.data?.items ?? [],
    unreadable: query.data?.unreadable ?? 0,
    loaded: query.data !== undefined,
    ...loadState(query, query.data !== undefined),
    replace,
  }
}
