'use client'

import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../api-fetch'
import { HostCallError } from './use-host-admin'

/** One Proxmox guest as Aico reads it (web-server/src/machines.ts). */
export interface MachineGuest {
  /** The machine name Status and Tether know it by. */
  machine: string
  vmid: number
  kind: 'vm' | 'ct'
  state: 'running' | 'stopped' | 'down' | 'starting' | 'unknown'
  since: string | null
  /** A power action Aico started that Proxmox has not finished. */
  busy: 'start' | 'shutdown' | 'restart' | null
  note?: string
  /** Proxmox's start-at-boot; null when it could not be read. */
  autostart: boolean | null
  /** Where the project registry says it is meant to be; null when no project declares it. */
  intent: 'always' | 'on-demand' | 'off' | null
  powerable: boolean
  cpus: number | null
  memoryMb: number | null
  projects: { id: string; name: string }[]
}

interface GuestsAnswer {
  items: MachineGuest[]
  asOf: string | null
  failure: string | null
}

const POLL_MS = 15_000
const POLL_BUSY_MS = 2_000

/** The Proxmox guests (`fast`: ask every 2 s, while a start is being followed); `guests` is null when they could not be read (and `failure` says why),
 * never an empty list standing in for unknown. */
export function useMachineGuests(fast = false) {
  const query = useQuery({
    queryKey: ['machine-guests'],
    queryFn: () =>
      apiFetch<GuestsAnswer>(
        '/api/machines/guests',
        undefined,
        'Couldn’t read the Proxmox guests',
      ),
    staleTime: 5_000,
    refetchInterval: (current) =>
      fast || current.state.data?.items.some((guest) => guest.busy)
        ? POLL_BUSY_MS
        : POLL_MS,
  })
  const answer = query.data
  const failure = query.isError
    ? 'The Aico server didn’t answer.'
    : (answer?.failure ?? null)
  return {
    guests: failure || !answer ? null : answer.items,
    failure,
    isLoading: query.isLoading,
    refetch: query.refetch,
  }
}

async function post(
  path: string,
  body: Record<string, unknown>,
  fallback: string,
): Promise<MachineGuest> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: (MachineGuest & { detail?: string }) | undefined
  try {
    parsed = text ? JSON.parse(text) : undefined
  } catch {
    parsed = undefined
  }
  if (!res.ok || !parsed)
    throw new HostCallError(parsed?.detail || fallback, res.status)
  return parsed
}

const machineUrl = (machine: string, rest: string) =>
  `/api/machines/${encodeURIComponent(machine)}/${rest}`

export const powerMachine = (
  machine: string,
  action: 'on' | 'off' | 'restart',
  force = false,
) =>
  post(
    machineUrl(machine, 'power'),
    force ? { action, force } : { action },
    `Couldn’t ${action === 'on' ? 'power on' : action === 'off' ? 'shut down' : 'restart'} ${machine}`,
  )

export const setAutostart = (machine: string, on: boolean) =>
  post(
    machineUrl(machine, 'autostart'),
    { on },
    `Couldn’t turn autostart ${on ? 'on' : 'off'} for ${machine}`,
  )
