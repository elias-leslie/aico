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
  /** When the host entered this state (ms since the epoch). */
  since?: number | null
  /** Sessions running there. */
  sessions?: number
  /** Why the link is down, when Tether knows. */
  error?: string | null
  /** A start in progress, or why the last one failed. */
  wake?: HostWake | null
}

export interface HostWake {
  state: 'starting' | 'failed'
  step?: 'powering_on' | 'connecting' | 'checking_services' | null
  since?: number | null
  error?: string | null
}

/** How often the list refreshes while a host is starting. */
export const HOSTS_STARTING_POLL_MS = 2_000

export const isStarting = (host: HostChoice) => host.wake?.state === 'starting'

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
    refetchInterval: (current) =>
      current.state.data?.items.some(isStarting)
        ? HOSTS_STARTING_POLL_MS
        : false,
  })
  return {
    hosts: query.data?.items ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
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
