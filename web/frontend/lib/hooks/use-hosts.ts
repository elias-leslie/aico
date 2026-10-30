'use client'

import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../api-fetch'

/** A Tether peer a session can run on, and whether it can be reached now. */
export interface HostChoice {
  name: string
  state:
    | 'connected'
    | 'connecting'
    | 'offline'
    | 'powered_off'
    | 'identity_changed'
}

export const HOST_STATE_LABELS: Record<HostChoice['state'], string> = {
  connected: '',
  connecting: 'connecting',
  offline: 'offline',
  powered_off: 'powered off',
  identity_changed: 'changed',
}

/** The hosts Tether links to; empty when it links to none. */
export function useHosts(enabled = true) {
  const query = useQuery({
    queryKey: ['hosts'],
    queryFn: () =>
      apiFetch<{ items: HostChoice[] }>(
        '/api/hosts',
        undefined,
        'Couldn’t load hosts',
      ),
    enabled,
    staleTime: 10_000,
  })
  return {
    hosts: query.data?.items ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
  }
}
