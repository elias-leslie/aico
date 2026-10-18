'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../api-fetch'

/** Tether's agent-pane memory policy (Tether owns it; A-Term edits it). */
export type KillOrder = 'largest' | 'background-first'

export interface MemoryPolicy {
  paneMemoryMaxGib: number
  paneSwapMaxGib: number
  killEnabled: boolean
  killAfterSeconds: number
  killGapSeconds: number
  killMinGib: number
  killOrder: KillOrder
}

export interface MemoryPolicyState {
  policy: MemoryPolicy
  guard?: { running: boolean; lastKillAt: number | null }
}

const KEY = ['memory-policy']

export function useMemoryPolicy() {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: KEY,
    queryFn: () =>
      apiFetch<MemoryPolicyState>(
        '/api/a-term/memory-policy',
        undefined,
        'Could not load memory settings',
      ),
    staleTime: 60000,
    retry: false,
  })
  const mutation = useMutation({
    mutationFn: (patch: Partial<MemoryPolicy>) =>
      apiFetch<MemoryPolicyState>(
        '/api/a-term/memory-policy',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        },
        'Could not save memory settings',
      ),
    onSuccess: (data) => queryClient.setQueryData(KEY, data),
  })
  return {
    state: query.data ?? null,
    isLoading: query.isLoading,
    loadError: query.error instanceof Error ? query.error.message : null,
    save: mutation.mutateAsync,
    saving: mutation.isPending,
  }
}
