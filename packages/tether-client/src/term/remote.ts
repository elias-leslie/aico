import { homedir } from 'node:os'
import { join } from 'node:path'
// A remote tmux process carries literal argv and terminal bytes over the
// authenticated fleet connection. No remote shell expands session targets.

export const FLEET_BIN =
  process.env.TETHER_BIN || join(process.env.HOME || homedir(), '.local/lib/tether/bin/tether')

const HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/
// A Tether instance's tmux socket under the host user's state dir; the
// host's $HOME is not known here, so any ordinary home qualifies.
const REMOTE_STATE = '(?:/home/[a-z_][a-z0-9_-]{0,31}|/root)/\\.local/state'
const SOCKET_TAIL = '/tether/[a-z0-9_-]+/tmux/[0-9a-f]{32}/server\\.sock$'

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** One argument for a POSIX shell, single-quoted. */
export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

export interface RemoteHost {
  host: string
  alias: string
  control: string
  stateDir: string | null
}

/** The `host` and `ssh` of an attach answer, or null for a local session;
 * throws when they are present but not trustworthy. */
export function remoteHostOf(
  answer: { host?: unknown; fleet?: unknown },
  env: NodeJS.ProcessEnv = process.env,
): RemoteHost | null {
  if (answer.host === undefined || answer.host === null) return null
  const fleet = answer.fleet as
    | { alias?: unknown; control?: unknown; stateDir?: unknown }
    | undefined
  const { host } = answer
  if (typeof host !== 'string' || !HOST.test(host) || !fleet || typeof fleet !== 'object')
    throw new Error('unexpected remote host')
  const { alias, control, stateDir } = fleet
  if (typeof alias !== 'string' || !ALIAS.test(alias) || IPV4.test(alias))
    throw new Error('unexpected fleet peer')
  if (control !== controlSocketPath(host, env)) throw new Error('unexpected fleet command socket')
  if (
    stateDir !== undefined &&
    stateDir !== null &&
    (typeof stateDir !== 'string' ||
      !/^\/[A-Za-z0-9._/-]+$/.test(stateDir) ||
      /\.\./.test(stateDir))
  )
    throw new Error('unexpected state dir')
  return { host, alias, control, stateDir: typeof stateDir === 'string' ? stateDir : null }
}

/** The fleet command socket socket for `host` (`tether-link@<host>`). */
export function controlSocketPath(host: string, env: NodeJS.ProcessEnv = process.env): string {
  const runtime = env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`
  return `${runtime}/aico/fleet/${host}/exec.sock`
}

/** True when `path` is a Tether instance's tmux socket on that host. */
export function trustedRemoteSocket(path: unknown, remote: RemoteHost): boolean {
  if (typeof path !== 'string') return false
  const state = remote.stateDir ? escapeRegExp(remote.stateDir.replace(/\/+$/, '')) : REMOTE_STATE
  return new RegExp(`^${state}${SOCKET_TAIL}`).test(path)
}

/** `ssh … <alias> -- env LANG=C.UTF-8 tmux -u -S '<socket>' attach-session -t '<target>'`. */
export function remoteAttachArgv(
  remote: RemoteHost,
  tmuxBin: string,
  socket: string,
  target: string,
): string[] {
  return [
    ...fleetPrefix(remote),
    // LANG and -u: tmux marks the client UTF-8 (non-ASCII is underscores otherwise).
    'env',
    'LANG=C.UTF-8',
    tmuxBin,
    '-u',
    '-S',
    socket,
    'attach-session',
    '-t',
    target,
  ]
}

/** ssh's own words when the host's sshd refuses another session on the link's
 * master (its MaxSessions is reached): the host is up, it just has no room. */
export const FLEET_SESSION_REFUSED = /Fleet peer is disconnected/

function fleetPrefix(remote: RemoteHost): string[] {
  return [FLEET_BIN, 'fleet', 'exec', remote.control, '--']
}

/** Where the tmux binary sits in an attach argv: first, or after ssh's `--`. */
export function tmuxIndex(argv: readonly string[]): number {
  if (argv[0] !== FLEET_BIN) return 0
  const dashes = argv.indexOf('--')
  const at = argv.findIndex((arg, i) => i > dashes && arg.endsWith('/tmux'))
  if (dashes < 0 || at < 0) throw new Error('fleet attach argv has no tmux')
  return at
}
