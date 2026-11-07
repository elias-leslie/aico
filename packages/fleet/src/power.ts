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

/**
 * Proxmox's `onboot` per guest id, from the guest config files (only the live section: the
 * snapshot sections after the first `[` are skipped). A guest with no `onboot` line is not here:
 * Proxmox's default is off.
 */
export function parseOnboot(output: string): Map<number, boolean> {
  const boot = new Map<number, boolean>()
  for (const line of output.split('\n')) {
    const match = /^(?:.*\/)?(\d+)\.conf: onboot:\s*(\d)\s*$/.exec(line)
    if (match) boot.set(Number(match[1]), match[2] === '1')
  }
  return boot
}

const CONFIG_GLOB = '/etc/pve/nodes/*/qemu-server/*.conf /etc/pve/nodes/*/lxc/*.conf'
// One pass over every guest config; ends each file's reading at its first `[snapshot]` section.
const READ_ONBOOT = `awk 'FNR==1{skip=0} /^\\[/{skip=1} !skip && /^onboot:/{print FILENAME": "$0}' ${CONFIG_GLOB}`

/** Every guest's start-at-boot setting that is written; a guest not in the map has none, so off. */
export async function readOnboot(ssh: string, timeout: number): Promise<Map<number, boolean>> {
  const { stdout } = await exec('ssh', ['-o', 'BatchMode=yes', ssh, READ_ONBOOT], { timeout })
  return parseOnboot(stdout)
}

/** Every guest and its power state, read through the Proxmox SSH alias (fleet.json `proxmoxSsh`).
 * Each carries its `onboot`; when the configs cannot be read that stays unknown, never off. */
export async function listGuests(ssh: string, timeout: number): Promise<Guest[]> {
  const [guests, boot] = await Promise.all([
    listGuestPower(ssh, timeout),
    readOnboot(ssh, timeout).catch(() => null),
  ])
  if (!boot) return guests
  return guests.map((guest) => ({ ...guest, onboot: boot.get(guest.vmid) ?? false }))
}

async function listGuestPower(ssh: string, timeout: number): Promise<Guest[]> {
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

/** The pvesh arguments that set a guest's start-at-boot. */
export function guestOnbootArgs(guest: Pick<Guest, 'vmid' | 'type' | 'node'>, on: boolean) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(guest.node)) throw new Error('Bad Proxmox node name')
  if (guest.type !== 'qemu' && guest.type !== 'lxc') throw new Error('Bad Proxmox guest type')
  return [
    'pvesh',
    'set',
    `/nodes/${guest.node}/${guest.type}/${guest.vmid}/config`,
    '--onboot',
    on ? '1' : '0',
  ]
}

export async function setGuestOnboot(
  ssh: string,
  guest: Pick<Guest, 'vmid' | 'type' | 'node'>,
  on: boolean,
  timeout: number,
): Promise<void> {
  await exec('ssh', ['-o', 'BatchMode=yes', ssh, ...guestOnbootArgs(guest, on)], { timeout })
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
