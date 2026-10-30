// How a viewer attaches to a Tether session without trusting what Tether returns.
//
// Tether's attach answer is data, not a command: only the tmux socket path and
// the target are taken from it, and only when the socket is one of this user's
// own Tether instances. The `tmux` argv and the client's environment are
// built here. A session on another host attaches over that host's link
// (remote.ts); its socket must be a Tether socket there.

import { homedir } from 'node:os'
import { type AttachAnswer, TetherUnavailable } from '../client/index'
import { remoteAttachArgv, remoteHostOf, trustedRemoteSocket } from './remote'

export const TMUX_BIN = '/usr/bin/tmux'

// This user's own Tether instance state (`$XDG_STATE_HOME/tether/<instance>`).
const OWN_SOCKET_TAIL = '/tether/[a-z0-9_-]+/tmux/[0-9a-f]{32}/server\\.sock$'
const TARGET = /^[$%@]?[A-Za-z0-9_.:][A-Za-z0-9_.:-]{0,63}$/
/** The only variables the client sees (Tether sets exactly these today). */
const ENV_KEYS = ['TERM', 'COLORTERM', 'CLICOLOR'] as const
const ENV_VALUE = /^[A-Za-z0-9._-]{1,32}$/

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** True when `path` is a tmux server socket of one of this user's Tether instances. */
export function trustedSocket(path: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  if (typeof path !== 'string') return false
  const state = env.XDG_STATE_HOME || `${env.HOME || homedir()}/.local/state`
  return new RegExp(`^${escapeRegExp(state)}${OWN_SOCKET_TAIL}`).test(path)
}

/** `tmux -S <socket> attach-session -t <target>` and the client environment,
 * built from Tether's answer: only the socket and target are taken from it.
 * With `host` (a session on another host) the argv runs tmux there over ssh. */
export function attachFromTether(
  answer: { argv: string[]; env: Record<string, string>; host?: unknown; ssh?: unknown },
  env: NodeJS.ProcessEnv = process.env,
): { argv: string[]; env: Record<string, string>; host: string | null } {
  const { argv } = answer
  const remote = remoteHostOf(answer, env)
  if (
    argv.length !== 6 ||
    argv[1] !== '-S' ||
    !(remote ? trustedRemoteSocket(argv[2], remote) : trustedSocket(argv[2], env)) ||
    (argv[3] !== 'attach-session' && argv[3] !== 'attach') ||
    argv[4] !== '-t' ||
    !TARGET.test(argv[5])
  )
    throw new Error('unexpected attach target')
  // LANG is ours: tmux marks a client UTF-8 from it; without it non-ASCII
  // text shows as underscores.
  const clientEnv: Record<string, string> = { TERM: 'xterm-256color', LANG: 'C.UTF-8' }
  for (const key of ENV_KEYS) {
    const value = answer.env[key]
    if (typeof value === 'string' && ENV_VALUE.test(value)) clientEnv[key] = value
  }
  if (remote)
    return {
      argv: remoteAttachArgv(remote, TMUX_BIN, argv[2], argv[5]),
      env: clientEnv,
      host: remote.host,
    }
  return {
    argv: [TMUX_BIN, '-S', argv[2], 'attach-session', '-t', argv[5]],
    env: clientEnv,
    host: null,
  }
}

export interface AttachTarget {
  generation: string
  /** The tmux client argv built here: `/usr/bin/tmux -S <socket> attach-session -t $3`,
   * or that behind `/usr/bin/ssh … <alias> --` for a session on another host. */
  argv: string[]
  /** The host the session runs on; null on this computer. */
  host: string | null
  /** The client's whole environment (allowlisted keys), not overrides. */
  env: Record<string, string>
}

/** Validate an attach answer before it is ever executed. Only the socket and
 * target are taken from it: the argv and environment are the viewer's own.
 * `host` is where the viewer's catalog says the session runs (undefined: not
 * known); an answer for another host is refused. */
export function ownAttachTarget(
  answer: AttachAnswer,
  env: NodeJS.ProcessEnv = process.env,
  host?: string | null,
): AttachTarget {
  try {
    const own = attachFromTether(answer, env)
    if (host !== undefined && own.host !== host) throw new Error('attach answer for another host')
    return { generation: answer.generation, argv: own.argv, env: own.env, host: own.host }
  } catch {
    throw new TetherUnavailable('Tether returned an invalid attach target')
  }
}

/** The environment for the tmux client: exactly the target's. The viewer's
 * own environment never reaches it, and neither does any key outside the allowlist. */
export function attachEnvironment(target: Pick<AttachTarget, 'env'>): Record<string, string> {
  return { ...target.env }
}
