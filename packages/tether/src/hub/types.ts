// Shapes the hub files share. Leaves, so peer.ts and wake.ts name them without
// importing each other.

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

/** How one tool signs in and out on a host. `signIn` and a `session` sign-out are shell
 * lines typed into a new session there; `command` runs over ssh. The tool adapters'
 * `ToolLogin` (lifecycle/tui/adapters/contract.ts) is this shape. */
export interface ToolLogin {
  signIn: string | null
  signOut:
    | { kind: 'revoke' }
    | { kind: 'command'; line: string }
    | { kind: 'session'; line: string }
    | null
  /** A served tool: sign-in grants it to the host first (push needs the grant). */
  grant?: boolean
  /** The tool's command and its own login file (home-relative), for a host
   * without a sign-in service: Aico checks the file is there instead. */
  local?: { bin: string; authFile: string }
  /** The sign-in screen prints a URL to open in a browser: its host. */
  signInLink?: { host: string }
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
  tools: HubTools
}
