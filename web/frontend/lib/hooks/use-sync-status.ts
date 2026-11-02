'use client'

import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../api-fetch'

/** How one other Aico (a hosts.json host with a sync socket) is keeping up. */
export interface PeerSync {
  /** The hosts.json name, the same as the host's card. */
  name: string
  state: 'ok' | 'down' | 'paused' | 'error' | 'waiting'
  /** When a pass last finished cleanly (ms since the epoch). */
  lastSyncAt: number | null
  /** The other computer's clock minus this one's, in ms. */
  skewMs: number | null
  /** Why sync is paused or failing. */
  reason: string | null
}

/** A clock gap past this is worth a warning. */
export const SKEW_WARN_MS = 5_000

/** Read-only sync state per peer. A failed read just hides the line. */
export function useSyncStatus(enabled = true) {
  const query = useQuery({
    queryKey: ['sync-status'],
    queryFn: () =>
      apiFetch<{ items: PeerSync[] }>(
        '/api/sync/status',
        undefined,
        'Couldn’t load sync status',
      ),
    enabled,
    staleTime: 10_000,
    refetchInterval: enabled ? 15_000 : false,
    retry: false,
  })
  return query.data?.items ?? []
}

/** The line under a host's name: `Notes synced 2m ago`, `Notes sync paused: …`. */
export function syncLine(
  peer: PeerSync,
  now: number,
  age: (ms: number) => string,
): { text: string; warn: boolean } {
  const skew =
    peer.skewMs !== null && Math.abs(peer.skewMs) > SKEW_WARN_MS
      ? ` · clock ${Math.round(Math.abs(peer.skewMs) / 1000)} s ${peer.skewMs > 0 ? 'ahead' : 'behind'}`
      : ''
  const warn = skew !== ''
  const last =
    peer.lastSyncAt === null
      ? 'not synced yet'
      : `synced ${age(now - peer.lastSyncAt)} ago`
  switch (peer.state) {
    case 'ok':
      return { text: `Notes ${last}${skew}`, warn }
    case 'paused':
      return {
        text: `Notes sync paused${peer.reason ? `: ${peer.reason}` : ''}${skew}`,
        warn: true,
      }
    case 'error':
      return {
        text: `Notes sync had a problem${peer.reason ? `: ${peer.reason}` : ''}`,
        warn: true,
      }
    case 'down':
      return { text: `Notes sync waiting for the link (${last})`, warn }
    case 'waiting':
      return { text: 'Notes sync not started yet', warn: false }
  }
}
