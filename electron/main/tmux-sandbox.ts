// How Aico attaches to a Tether session without trusting what Tether returns.
//
// Tether may run as another user, so its attach answer is data, not a command.
// Aico takes only the tmux socket path and the target from it, builds the
// `tmux` argv itself and runs that client inside bubblewrap with nothing but
// tmux in it. A tmux server can tell an attached client to run a command
// (`detach-client -E`, via /bin/sh); with no shell in the sandbox that command
// cannot run as this user.

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'

export const TMUX_BIN = '/usr/bin/tmux'
export const BWRAP_BIN = '/usr/bin/bwrap'

// Sockets Aico will attach to: the agent instance's runtime tree, or this
// user's own Tether instance state (`$XDG_STATE_HOME/tether/<instance>`).
const SERVER_TAIL = 'tmux/[0-9a-f]{32}/server\\.sock$'
const AGENT_SOCKET = new RegExp(`^/run/tether/[a-z]+/default/${SERVER_TAIL}`)
const OWN_SOCKET_TAIL = `/tether/[a-z0-9_-]+/${SERVER_TAIL}`
const TARGET = /^[$%@]?[A-Za-z0-9_.:][A-Za-z0-9_.:-]{0,63}$/
/** The only variables the client sees (Tether sets exactly these today). */
const ENV_KEYS = ['TERM', 'COLORTERM', 'CLICOLOR'] as const
const ENV_VALUE = /^[A-Za-z0-9._-]{1,32}$/
/** Read-only data the client needs besides tmux and its libraries. */
const DATA_DIRS = ['/usr/share/terminfo', '/usr/lib/locale/C.utf8']

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** True when `path` is a Tether tmux server socket of the agent or of this user. */
export function trustedSocket(path: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  if (typeof path !== 'string') return false
  const state = env.XDG_STATE_HOME || `${env.HOME || homedir()}/.local/state`
  return (
    AGENT_SOCKET.test(path) || new RegExp(`^${escapeRegExp(state)}${OWN_SOCKET_TAIL}`).test(path)
  )
}

/** `tmux -S <socket> attach-session -t <target>` and the client environment,
 * built from Tether's answer: only the socket and target are taken from it. */
export function attachFromTether(
  answer: { argv: string[]; env: Record<string, string> },
  env: NodeJS.ProcessEnv = process.env,
): { argv: string[]; env: Record<string, string> } {
  const { argv } = answer
  if (
    argv.length !== 6 ||
    argv[1] !== '-S' ||
    !trustedSocket(argv[2], env) ||
    (argv[3] !== 'attach-session' && argv[3] !== 'attach') ||
    argv[4] !== '-t' ||
    !TARGET.test(argv[5])
  )
    throw new Error('unexpected attach target')
  // LANG is ours: tmux marks a client UTF-8 from it (the sandbox has the
  // C.UTF-8 locale); without it non-ASCII text shows as underscores.
  const clientEnv: Record<string, string> = { TERM: 'xterm-256color', LANG: 'C.UTF-8' }
  for (const key of ENV_KEYS) {
    const value = answer.env[key]
    if (typeof value === 'string' && ENV_VALUE.test(value)) clientEnv[key] = value
  }
  return { argv: [TMUX_BIN, '-S', argv[2], 'attach-session', '-t', argv[5]], env: clientEnv }
}

let libsCache: { key: string; paths: string[] } | null = null

/** The files the dynamic loader maps for tmux (`ldd`), cached per tmux build. */
function libraries(): string[] {
  const stat = statSync(TMUX_BIN)
  const key = `${stat.mtimeMs}:${stat.size}`
  if (libsCache?.key === key) return libsCache.paths
  const out = execFileSync('/usr/bin/ldd', [TMUX_BIN], { encoding: 'utf8', timeout: 10_000 })
  const paths: string[] = []
  for (const line of out.split('\n')) {
    const words = line.trim().split(/\s+/)
    const path = words.includes('=>') ? words[2] : words[0]
    if (path?.startsWith('/')) paths.push(path)
  }
  if (!paths.length) throw new Error("could not list tmux's libraries")
  libsCache = { key, paths }
  return paths
}

/** `tmuxArgv` (`/usr/bin/tmux -S <socket> …`) run under bubblewrap.
 *
 * Inside: tmux, its libraries, terminfo and the C.UTF-8 locale (read-only), a
 * minimal /dev plus the host's /dev/pts (so the client names its tty), and the
 * socket's directory (read-only; connecting needs no write). No shell, no
 * network of its own, no other executable. The pid namespace stays shared so
 * the client's pid is the one Tether's resize claim looks for (bubblewrap
 * forks, so that is bwrap's child: see `tmuxClientPid`). */
export function sandboxedTmux(tmuxArgv: readonly string[]): string[] {
  const at = tmuxArgv.indexOf('-S')
  const socket = at > 0 ? tmuxArgv[at + 1] : undefined
  if (tmuxArgv[0] !== TMUX_BIN || !socket) throw new Error('not a tmux argv with a socket')
  if (!trustedSocket(socket)) throw new Error('tmux socket is not a Tether server socket')
  const argv = [
    BWRAP_BIN,
    '--unshare-user',
    '--unshare-ipc',
    '--unshare-net',
    '--unshare-uts',
    '--unshare-cgroup-try',
    '--die-with-parent',
    '--chdir',
    '/',
    '--dev',
    '/dev',
    '--ro-bind',
    '/dev/pts',
    '/dev/pts',
    '--ro-bind',
    TMUX_BIN,
    TMUX_BIN,
  ]
  for (const lib of libraries()) argv.push('--ro-bind', realpathSync(lib), lib)
  for (const dir of DATA_DIRS) argv.push('--ro-bind-try', dir, dir)
  const socketDir = dirname(socket)
  argv.push('--ro-bind', socketDir, socketDir, '--', ...tmuxArgv)
  return argv
}

/** The tmux client's pid: the child bubblewrap forks to run it. Tether's
 * resize claim names the client by pid, and tmux reports its own, not
 * bubblewrap's. Falls back to `bwrapPid` if no child appears. */
export async function tmuxClientPid(bwrapPid: number, timeoutMs = 2_000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue
      try {
        // "pid (comm) state ppid ..."; comm may hold spaces and parens.
        const stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
        const fields = stat
          .slice(stat.lastIndexOf(')') + 1)
          .trim()
          .split(/\s+/)
        if (fields[1] === String(bwrapPid)) return Number(entry)
      } catch {
        // the process ended while we looked
      }
    }
    if (Date.now() >= deadline) return bwrapPid
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
