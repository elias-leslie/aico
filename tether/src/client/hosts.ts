// The Hosts panel's calls (tether docs/api-v1.md "Remote hosts"): sign-in state
// per tool on a host, power on and off, trust after a machine change, and sign
// in or out. Shared by the desktop and the web server.

import type { TetherClient } from './client'
import type { SessionDescriptor } from './contracts'

/** One tool's sign-in state on a host. `unknown` is never "signed out". */
export type LoginState = 'signed_in' | 'needs_sign_in' | 'expired' | 'unknown'

export interface LoginCredential {
  name: string
  rotates: boolean
  state: LoginState
  /** `agent-hub` (served at launch) or `host:<path>` (a login on the host's disk). */
  source: string
  detail?: string
  expires_at?: string | null
}

export interface ToolLoginStatus {
  tool: string
  state: LoginState
  source: string
  credentials: LoginCredential[]
}

/** What Aico can do for a tool there: sign out by revoking the host's grant,
 * by a command on the host, or inside the tool in a session. */
export interface ToolLoginActions {
  signIn: boolean
  signOut: 'revoke' | 'command' | 'session' | null
}

/** `GET /v1/hosts/:name/logins`: the host's `agent-hub login status --json`. */
export interface HostLogins {
  host: string
  /** `reachable`, or why Agent Hub could not be reached from the host. */
  agent_hub: string
  tools: ToolLoginStatus[]
  checkedAt: number
  actions: Record<string, ToolLoginActions>
}

export interface HostPowerAnswer {
  host: string
  state: 'connected' | 'starting' | 'powering_off'
  sessions?: number
}

export interface HostSignInAnswer {
  host: string
  /** The session opened on the host for the tool's own login or logout. */
  session?: SessionDescriptor
  signedOut?: boolean
  /** Something the owner should know, e.g. the host's shims update later. */
  note?: string
}

/** The status read runs on the host over ssh (bounded there at 20 s). */
const LOGINS_TIMEOUT_MS = 30_000
const POWER_TIMEOUT_MS = 150_000

const hostPath = (name: string) => `/v1/hosts/${encodeURIComponent(name)}`

export async function hostLogins(tether: TetherClient, host: string): Promise<HostLogins> {
  return (
    await tether.request<HostLogins>('GET', `${hostPath(host)}/logins`, undefined, {
      timeoutMs: LOGINS_TIMEOUT_MS,
    })
  ).body
}

/** Power on (answers at once; progress shows on the host's `wake`) or off
 * (`409 host_busy` while sessions run there, unless `force`). */
export async function hostPower(
  tether: TetherClient,
  host: string,
  action: 'on' | 'off',
  force = false,
): Promise<HostPowerAnswer> {
  return (
    await tether.request<HostPowerAnswer>(
      'POST',
      `${hostPath(host)}/power`,
      { action, ...(force ? { force } : {}) },
      { timeoutMs: POWER_TIMEOUT_MS },
    )
  ).body
}

/** Accept the machine that now answers for `host` after it changed. */
export async function trustHost(tether: TetherClient, host: string): Promise<void> {
  await tether.request('POST', `${hostPath(host)}/trust`)
}

export async function hostSignIn(
  tether: TetherClient,
  host: string,
  tool: string,
  action: 'sign_in' | 'sign_out',
  options: { origin: string; size?: { cols: number; rows: number }; timeoutMs: number },
): Promise<HostSignInAnswer> {
  return (
    await tether.request<HostSignInAnswer>(
      'POST',
      `${hostPath(host)}/logins/${encodeURIComponent(tool)}`,
      { action, origin: options.origin, ...(options.size ? { size: options.size } : {}) },
      { timeoutMs: options.timeoutMs },
    )
  ).body
}
