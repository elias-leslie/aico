// Who a full Aico may share files with: the other full-role machines in its own fleet records
// (fleet.json peers, the root-owned pins' roles). Workers never count. A peer that says it runs on
// this machine's computer is left out; the caller also compares kernels (containers) over the link.
import { join } from 'node:path'
import { linkPaths } from './link'
import type { FleetSettings } from './settings'
import type { Pin } from './trust'

export interface FullPeer {
  name: string
  /** The local proxy socket of the fleet exec channel to it. */
  exec: string
}

export interface FullPeers {
  /** This machine's own role, null when the pins do not list it. */
  role: Pin['role'] | null
  peers: FullPeer[]
  /** Full peers set aside because they run on this machine's own computer. */
  sameComputer: string[]
}

export function fullPeers(settings: FleetSettings, pins: readonly Pin[]): FullPeers {
  const role = pins.find((pin) => pin.name === settings.machine)?.role ?? null
  const peers: FullPeer[] = []
  const sameComputer: string[] = []
  for (const peer of settings.peers) {
    if (pins.find((pin) => pin.name === peer.name)?.role !== 'full') continue
    if (settings.hardware && peer.hardware === settings.hardware) {
      sameComputer.push(peer.name)
      continue
    }
    peers.push({ name: peer.name, exec: linkPaths(join(settings.peerRoot, peer.name)).control })
  }
  return { role, peers, sameComputer }
}
