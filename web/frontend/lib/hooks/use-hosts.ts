'use client'

import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../api-fetch'
import type { ProjectSetting } from './use-project-settings'

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

/** The projects on a remote `host`, for a session started there; idle for
 * this computer. Fails while the host can't be reached. */
export function useHostProjects(host: string | undefined) {
  const query = useQuery({
    queryKey: ['host-projects', host],
    queryFn: () =>
      apiFetch<ProjectSetting[]>(
        `/api/projects?host=${encodeURIComponent(host ?? '')}`,
        undefined,
        `Couldn’t load projects on ${host}`,
      ),
    enabled: host !== undefined,
    staleTime: 30_000,
    retry: false,
  })
  return {
    projects: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  }
}
