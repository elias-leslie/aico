// Proxmox is the authority on a disconnected guest's power state. A missing or
// failed reading must never turn a broken link into a healthy one.
import { readFileSync } from 'node:fs'
import type { StatusRow } from '@aico/status'
import { guestConfig, PveError, type PveRequest, setOnboot } from './proxmox'
import { type FleetSettings, fleetFile } from './settings'

export function parseGuestPower(value: unknown): Map<string, string> {
  if (!Array.isArray(value)) throw new Error('Proxmox guest list must be an array')
  const power = new Map<string, string>()
  const names = new Set<string>()
  for (const row of value) {
    if (
      !row ||
      typeof row !== 'object' ||
      !['qemu', 'lxc'].includes(row.type) ||
      typeof row.name !== 'string'
    )
      continue
    if (names.has(row.name)) {
      power.delete(row.name)
      continue
    }
    names.add(row.name)
    if (row.status === 'running' || row.status === 'stopped') power.set(row.name, row.status)
  }
  return power
}
/** Power of every named guest, from the Proxmox API. A failed reading throws. */
export async function guestPower(call: PveRequest): Promise<Map<string, string>> {
  return parseGuestPower(await call('GET', '/cluster/resources?type=vm'))
}
export function peerStatusRow(
  settings: Pick<FleetSettings, 'machine' | 'deadMs'>,
  peer: { name: string; connected: boolean; lastSeen: number | null },
  role: string | undefined,
  power: string | undefined,
  startedAt: number,
  /** When this peer was first read as running after being off: its link has had only since then. */
  runningSince = 0,
): StatusRow {
  const off = Boolean(role) && !peer.connected && power === 'stopped'
  return {
    id: `fleet/${settings.machine}/${peer.name}`,
    what: `Link to ${peer.name}`,
    kind: 'machine',
    machine: peer.name,
    state: peer.connected ? 'ok' : off ? 'off' : 'warn',
    meaning: !role
      ? 'Not on the allowlist. Connection refused.'
      : peer.connected
        ? `Approved ${role}. Connected to ${peer.name}.`
        : off
          ? `${peer.name} is off. Its link will connect when it starts.`
          : peer.lastSeen
            ? `Disconnected from ${peer.name}. Reconnecting.`
            : `Waiting for ${peer.name} to connect.`,
    ...(peer.lastSeen ? { last_run: new Date(peer.lastSeen).toISOString() } : {}),
    // Machine rows require a reporting deadline; Status exempts off rows from late.
    next_run: new Date(
      Math.max(peer.lastSeen ?? startedAt, runningSince) + settings.deadMs,
    ).toISOString(),
    actions: [{ kind: 'detail', ref: 'tether hosts' }],
  }
}

/** One Proxmox guest as the cluster lists it. */
export interface Guest {
  vmid: number
  type: 'qemu' | 'lxc'
  node: string
  name: string
  status: string
  /** Seconds since it started; 0 when stopped. */
  uptime: number
  /** Memory it is given, in bytes; 0 when Proxmox did not say. */
  maxmem: number
  /** CPUs it is given; 0 when Proxmox did not say. */
  maxcpu: number
  /** A template, not a machine. */
  template: boolean
  /** Proxmox's start-at-boot setting (`onboot`); undefined when it could not be read. */
  onboot?: boolean
}

export function parseGuests(value: unknown): Guest[] {
  if (!Array.isArray(value)) throw new Error('Proxmox guest list must be an array')
  const guests: Guest[] = []
  for (const row of value) {
    if (
      !row ||
      typeof row !== 'object' ||
      !['qemu', 'lxc'].includes(row.type) ||
      !Number.isInteger(row.vmid) ||
      typeof row.node !== 'string'
    )
      continue
    guests.push({
      vmid: row.vmid,
      type: row.type,
      node: row.node,
      name: typeof row.name === 'string' ? row.name : '',
      status: typeof row.status === 'string' ? row.status : 'unknown',
      uptime: Number(row.uptime) || 0,
      maxmem: Number(row.maxmem) || 0,
      maxcpu: Number(row.maxcpu) || 0,
      template: row.template === 1,
    })
  }
  return guests
}

/** `onboot` from one guest's config: absent means Proxmox's default, off. */
export function onbootOf(config: Record<string, unknown>): boolean {
  return Number(config.onboot) === 1
}

/** Every guest and its power state from the Proxmox API. Each carries its `onboot`; a guest whose
 * config cannot be read stays unknown (undefined), never off. */
export async function listGuests(call: PveRequest): Promise<Guest[]> {
  const guests = parseGuests(await call('GET', '/cluster/resources?type=vm'))
  return await Promise.all(
    guests.map(async (guest) => {
      try {
        return { ...guest, onboot: onbootOf(await guestConfig(call, guest)) }
      } catch {
        return guest
      }
    }),
  )
}

/**
 * The power actions the Projects page may ask for: start, a clean shutdown and a clean reboot.
 * There is no hard stop here on purpose.
 */
export const GUEST_ACTIONS = ['start', 'shutdown', 'reboot'] as const
export type GuestAction = (typeof GUEST_ACTIONS)[number]

/** Queue one power action; Proxmox runs the task and callers watch the guest's state. A refusal
 * (permission, bad state) throws, so a failed request is never reported as done. */
export async function guestAction(
  call: PveRequest,
  guest: Pick<Guest, 'vmid' | 'type' | 'node'>,
  action: GuestAction,
): Promise<void> {
  if (!(GUEST_ACTIONS as readonly string[]).includes(action))
    throw new Error(`No guest action ${action}`)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(guest.node)) throw new PveError('Bad Proxmox node name')
  if (guest.type !== 'qemu' && guest.type !== 'lxc') throw new PveError('Bad Proxmox guest type')
  await call('POST', `/nodes/${guest.node}/${guest.type}/${guest.vmid}/status/${action}`)
}

export async function setGuestOnboot(
  call: PveRequest,
  guest: Pick<Guest, 'vmid' | 'type' | 'node'>,
  on: boolean,
): Promise<void> {
  await setOnboot(call, guest, on)
}

/** Whether this machine controls Proxmox (`"proxmox": true` in fleet.json): it holds a scoped
 * Proxmox login. */
export function proxmoxFrom(env: NodeJS.ProcessEnv, read = readFileSync): boolean {
  try {
    const value = JSON.parse(String(read(fleetFile(env), 'utf8'))) as { proxmox?: unknown }
    return value.proxmox === true
  } catch {
    return false
  }
}
