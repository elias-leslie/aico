// Proxmox is the authority on a disconnected guest's power state. A missing or
// failed reading must never turn a broken link into a healthy one.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { StatusRow } from '@aico/status'
import type { FleetSettings } from './settings'

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
