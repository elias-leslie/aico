// Proxmox is the authority on a disconnected guest's power state. A missing or
// failed reading must never turn a broken link into a healthy one.
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import type { StatusRow } from '@aico/status'
import { type FleetSettings, fleetFile } from './settings'

const exec = promisify(execFile)
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
export async function guestPower(ssh: string, timeout: number): Promise<Map<string, string>> {
  const { stdout } = await exec(
    'ssh',
    [
      '-o',
      'BatchMode=yes',
      ssh,
      'pvesh',
      'get',
      '/cluster/resources',
      '--type',
      'vm',
      '--output-format',
      'json',
    ],
    { timeout },
  )
  return parseGuestPower(JSON.parse(stdout))
}
export function peerStatusRow(
  settings: Pick<FleetSettings, 'machine' | 'deadMs'>,
  peer: { name: string; connected: boolean; lastSeen: number | null },
  role: string | undefined,
  power: string | undefined,
  startedAt: number,
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
    next_run: new Date((peer.lastSeen ?? startedAt) + settings.deadMs).toISOString(),
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
    })
  }
  return guests
}

/** Every guest and its power state, read through the Proxmox SSH alias (fleet.json `proxmoxSsh`). */
export async function listGuests(ssh: string, timeout: number): Promise<Guest[]> {
  const { stdout } = await exec(
    'ssh',
    [
      '-o',
      'BatchMode=yes',
      ssh,
      'pvesh',
      'get',
      '/cluster/resources',
      '--type',
      'vm',
      '--output-format',
      'json',
    ],
    { timeout },
  )
  return parseGuests(JSON.parse(stdout))
}

/**
 * The power actions the Projects page may ask for: start, a clean shutdown and a clean reboot.
 * There is no hard stop here on purpose.
 */
export const GUEST_ACTIONS = ['start', 'shutdown', 'reboot'] as const
export type GuestAction = (typeof GUEST_ACTIONS)[number]

/** The pvesh arguments for one guest action (the task is queued; callers watch the guest's state). */
export function guestActionArgs(guest: Pick<Guest, 'vmid' | 'type' | 'node'>, action: GuestAction) {
  if (!(GUEST_ACTIONS as readonly string[]).includes(action))
    throw new Error(`No guest action ${action}`)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(guest.node)) throw new Error('Bad Proxmox node name')
  return ['pvesh', 'create', `/nodes/${guest.node}/${guest.type}/${guest.vmid}/status/${action}`]
}

export async function guestAction(
  ssh: string,
  guest: Pick<Guest, 'vmid' | 'type' | 'node'>,
  action: GuestAction,
  timeout: number,
): Promise<void> {
  await exec('ssh', ['-o', 'BatchMode=yes', ssh, ...guestActionArgs(guest, action)], { timeout })
}

/** The Proxmox SSH alias in the fleet settings file, or null when there is none. */
export function proxmoxSshFrom(env: NodeJS.ProcessEnv, read = readFileSync): string | null {
  try {
    const value = JSON.parse(String(read(fleetFile(env), 'utf8'))) as { proxmoxSsh?: unknown }
    const alias = value.proxmoxSsh
    return typeof alias === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(alias) ? alias : null
  } catch {
    return null
  }
}
