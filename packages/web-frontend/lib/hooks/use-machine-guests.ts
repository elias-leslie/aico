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
  /** A clean shutdown or restart that Proxmox ran and failed, in Proxmox's words; null otherwise. */
  failed: { action: 'shutdown' | 'restart'; reason: string; at: string } | null
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
  action: 'on' | 'off' | 'restart' | 'stop',
  force = false,
) =>
  post(
    machineUrl(machine, 'power'),
    force ? { action, force } : { action },
    `Couldn’t ${action === 'on' ? 'power on' : action === 'off' ? 'shut down' : action === 'stop' ? 'force off' : 'restart'} ${machine}`,
  )

export const setAutostart = (machine: string, on: boolean) =>
  post(
    machineUrl(machine, 'autostart'),
    { on },
    `Couldn’t turn autostart ${on ? 'on' : 'off'} for ${machine}`,
  )

/** Starts the workstation's clean shutdown; a refusal that comes at once is thrown with its reason. */
export async function shutDownMachine(machine: string): Promise<void> {
  const res = await fetch(machineUrl(machine, 'shut-down'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  if (res.ok) return
  const parsed = (await res.json().catch(() => null)) as {
    detail?: string
  } | null
  throw new HostCallError(
    parsed?.detail || `Couldn’t shut down ${machine}.`,
    res.status,
  )
}

/** One of Aico's services on a machine. */
export interface MachineService {
  unit: string
  label: string
  state: string
  reloadsPage: boolean
}

interface MachineServices {
  machine: string
  /** Null when that machine didn't answer. */
  units: MachineService[] | null
  error?: string
}

/** Each full Aico's services; null until read or when this server can't say. */
export function useMachineServices() {
  const query = useQuery({
    queryKey: ['machine-services'],
    queryFn: () =>
      apiFetch<{ machines: MachineServices[] }>(
        '/api/machines/services',
        undefined,
        'Couldn’t read the services',
      ),
    staleTime: 5_000,
    refetchInterval: POLL_MS,
  })
  return { machines: query.data?.machines ?? null, refetch: query.refetch }
}

/** A line someone said in a session, as the copy holds it. */
export interface CopySaid {
  at: number | null
  text: string
}

/** One session that was running on another machine when this Aico last heard from it. */
export interface CopySession {
  id: string
  tool: string
  title: string
  project: string | null
  state: string
  detail: string | null
  doing: string | null
  waitingOn: string | null
  needsYou: boolean
  lastActivity: number | null
  lastOwner: CopySaid | null
  lastAgent: CopySaid | null
  git: { branch: string; head: string; dirty: number } | null
  /** When it left its machine's list; null while it was still there. */
  endedAt?: number | null
  copy: { bytes: number; files: number; cut: boolean } | null
}

export interface HeldMachine {
  machine: string
  at: number
  sessions: CopySession[]
}

/** What this Aico holds of the other machines' sessions; null until read or when it can't say. */
export function useSessionCopies() {
  const query = useQuery({
    queryKey: ['session-copies'],
    queryFn: () =>
      apiFetch<{ machines: HeldMachine[] }>(
        '/api/machines/session-copies',
        undefined,
        'Couldn’t read the session copies',
      ),
    staleTime: 15_000,
    refetchInterval: 60_000,
  })
  return { machines: query.data?.machines ?? null, failed: query.isError }
}

export async function restartService(
  machine: string,
  unit: string,
): Promise<void> {
  const res = await fetch(machineUrl(machine, 'restart-service'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unit }),
  })
  if (res.ok) return
  const parsed = (await res.json().catch(() => null)) as {
    detail?: string
  } | null
  throw new HostCallError(parsed?.detail || 'It didn’t restart.', res.status)
}

/** Shuts down the machines for leaving (`aico away --all` on the Workstation). Resolves once it has started; a refusal is thrown in the server's words. */
export async function awayAll(): Promise<void> {
  const res = await fetch('/api/machines/away', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  if (res.ok) return
  const parsed = (await res.json().catch(() => null)) as {
    detail?: string
  } | null
  throw new HostCallError(
    parsed?.detail || 'Couldn’t start the shutdown.',
    res.status,
  )
}

/** Whether shutting everything down is set up; `reason` says why not. Null while unread. */
export function useAwayStatus() {
  const query = useQuery({
    queryKey: ['machines-away'],
    queryFn: () =>
      apiFetch<{ enabled: boolean; reason?: string }>(
        '/api/machines/away',
        undefined,
        'Couldn’t check whether shutting down is set up',
      ),
    staleTime: 60_000,
  })
  return query.isError
    ? {
        enabled: false,
        reason: 'Couldn’t check whether shutting down is set up.',
      }
    : (query.data ?? null)
}
