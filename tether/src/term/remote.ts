// Attaching to a session on another host. The local Tether hub answers for a
// remote session with the peer's own attach answer plus `host` and that
// host's `ssh` (alias, the link's control socket, and optionally its state
// dir). The tmux client then runs on the host, over the link's ssh master.
//
// ssh hands the remote command to the host's shell as one line, so every
// remote argument that came from an answer is quoted here: a target like `$3`
// would otherwise expand there.

export const SSH_BIN = '/usr/bin/ssh'

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
  answer: { host?: unknown; ssh?: unknown },
  env: NodeJS.ProcessEnv = process.env,
): RemoteHost | null {
  if (answer.host === undefined || answer.host === null) return null
  const ssh = answer.ssh as { alias?: unknown; control?: unknown; stateDir?: unknown } | undefined
  const { host } = answer
  if (typeof host !== 'string' || !HOST.test(host) || !ssh || typeof ssh !== 'object')
    throw new Error('unexpected remote host')
  const { alias, control, stateDir } = ssh
  if (typeof alias !== 'string' || !ALIAS.test(alias) || IPV4.test(alias))
    throw new Error('unexpected ssh alias')
  if (control !== controlSocketPath(host, env)) throw new Error('unexpected ssh control socket')
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

/** The link's ssh master socket for `host` (`tether-link@<host>`). */
export function controlSocketPath(host: string, env: NodeJS.ProcessEnv = process.env): string {
  const runtime = env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`
  return `${runtime}/tether/peers/${host}/ssh.ctl`
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
    ...sshPrefix(remote),
    // LANG and -u: tmux marks the client UTF-8 (non-ASCII is underscores otherwise).
    'env',
    'LANG=C.UTF-8',
    tmuxBin,
    '-u',
    '-S',
    shellQuote(socket),
    'attach-session',
    '-t',
    shellQuote(target),
  ]
}

function sshPrefix(remote: RemoteHost): string[] {
  // -F /dev/null: no user config can redirect it; the master already holds
  // the connection, so the alias only names it.
  return [
    SSH_BIN,
    '-F',
    '/dev/null',
    '-T',
    '-o',
    'BatchMode=yes',
    '-S',
    remote.control,
    remote.alias,
    '--',
  ]
}

/** Where the tmux binary sits in an attach argv: first, or after ssh's `--`. */
export function tmuxIndex(argv: readonly string[]): number {
  if (argv[0] !== SSH_BIN) return 0
  const dashes = argv.indexOf('--')
  const at = argv.findIndex((arg, i) => i > dashes && arg.endsWith('/tmux'))
  if (dashes < 0 || at < 0) throw new Error('ssh attach argv has no tmux')
  return at
}
