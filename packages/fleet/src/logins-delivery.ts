import { join } from 'node:path'
import { LoginError, type LoginSnapshot, LoginStore } from './logins'
import { requestLoginWire } from './logins-wire'
import type { FleetSettings } from './settings'
import { readPins } from './trust'

export async function pushLoginGrants(settings: FleetSettings, machine: string, env = process.env) {
  const pins = readPins(settings.allowlist)
  const recipient = pins.find((pin) => pin.name === machine)
  if (
    pins.find((pin) => pin.name === settings.machine)?.role !== 'full' ||
    !recipient ||
    !settings.peers.some((peer) => peer.name === machine)
  )
    throw new LoginError('Login delivery needs a full peer sender and approved machine')
  const store = new LoginStore(env)
  const snapshot = store.snapshot(machine, recipient.role === 'full')
  const answer = JSON.parse(
    await requestLoginWire(
      join(settings.peerRoot, machine, 'logins.sock'),
      JSON.stringify({ operation: 'sync', snapshot: { ...snapshot, source: settings.machine } }),
    ),
  ) as { ok: boolean }
  if (!answer.ok) throw new LoginError('Machine did not accept the login snapshot')
  return snapshot.entries.map(({ entry }) => entry.name)
}
export function receiveLoginGrants(input: string, env = process.env) {
  let snapshot: LoginSnapshot
  try {
    snapshot = JSON.parse(input)
  } catch {
    throw new LoginError('Invalid login delivery')
  }
  const store = new LoginStore(env)
  store.mergeSnapshot(snapshot)
  return snapshot.entries.map(({ entry }) => entry.name)
}
