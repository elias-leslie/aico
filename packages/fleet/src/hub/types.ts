// Shapes the hub files share. Leaves, so peer.ts and wake.ts name them without
// importing each other.

import type { ToolLogin } from '@aico/shared/tool-login'
import type { HostEntry } from '../hosts'

export type WakeStep = 'powering_on' | 'connecting' | 'checking_services'

/** What a create is waiting for on a host, shown while it waits and after it failed. */
export interface WakeProgress {
  state: 'starting' | 'failed'
  reason: 'host_starting'
  step: WakeStep
  since: number
  error: string | null
}

/** What a Tether release is, whatever its API version: the hash of its installed files and,
 * when a signed update sits beside them, when it was issued (the deploy order). */
export interface ReleaseIdentity {
  hash: string
  issuedAt: number | null
}

/** What the hub learns about the tools Tether runs, passed in so the hub names none of them. */
export interface HubTools {
  /** The tools' own logins; a `host-logins.json` next to hosts.json overrides them per tool. */
  logins: Record<string, ToolLogin>
  /** The title prefix of a sign-in session opened for a tool. */
  signInTitle: string
  /** The first Tether API that runs this tool through a session entry; undefined: not a tool
   * with entries (or not a tool at all). */
  entryApiVersion(tool: unknown): number | undefined
  /** The tools that run through a session entry, with that first API, in display order. */
  entryTools(): { id: string; entryApiVersion: number }[]
}

/** What the hub, the host admin and the release update take from Tether instead of importing it. */
export interface HubPorts {
  /** This Tether's API version. */
  apiVersion: number
  /** Whether a name is a valid Tether instance name. */
  isInstanceName(value: string): boolean
  /** The file name of an instance's database in its state directory (the update rolls it back). */
  dbFile: string
  tools: HubTools
}

/** A remote host as the hub knows it. */
export interface PeerView {
  entry: HostEntry
  live: boolean
  state: string
  socket: string
  control: string
}
