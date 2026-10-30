// `tether link <host>`: the process behind `tether-link@<host>.service`. It
// holds one ssh ControlMaster to the host that forwards the remote Tether's
// control socket to `$XDG_RUNTIME_DIR/tether/peers/<host>/control.sock` and,
// optionally, workstation ports back to the host. It never powers a host on:
// while the host is down it retries quietly with jittered, capped backoff,
// which resets only after a link stayed up. SIGUSR1 retries at once (a wake).

import { type ChildProcess, spawn } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import type { HostEntry } from './hosts'

export const SSH_BIN = '/usr/bin/ssh'
export const LINK_BACKOFF_MIN_MS = 2_000
export const LINK_BACKOFF_MAX_MS = 300_000
/** A link up this long resets the backoff. */
export const LINK_STABLE_MS = 60_000

export interface LinkPaths {
  dir: string
  control: string
  forwarded: string
}

export function linkPaths(dir: string): LinkPaths {
  return { dir, control: join(dir, 'ssh.ctl'), forwarded: join(dir, 'control.sock') }
}

/** The ssh argv of one link (without the binary). */
export function linkArgv(host: HostEntry, paths: LinkPaths): string[] {
  const options = [
    'ControlPersist=no',
    'ExitOnForwardFailure=yes',
    'StreamLocalBindUnlink=yes',
    'StreamLocalBindMask=0177',
    'ServerAliveInterval=15',
    'ServerAliveCountMax=3',
    'ConnectTimeout=5',
    'BatchMode=yes',
    'LogLevel=ERROR',
  ]
  return [
    '-N',
    '-T',
    '-M',
    '-S',
    paths.control,
    ...options.flatMap((option) => ['-o', option]),
    '-L',
    `${paths.forwarded}:${host.socket}`,
    ...host.forwards.flatMap((p) => ['-R', `127.0.0.1:${p}:127.0.0.1:${p}`]),
    '--',
    host.ssh,
  ]
}

/** Jittered exponential backoff: full jitter over the upper half, capped. */
export function linkBackoff(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(LINK_BACKOFF_MAX_MS, LINK_BACKOFF_MIN_MS * 2 ** Math.max(0, attempt))
  return Math.round(ceiling / 2 + (random() * ceiling) / 2)
}

function liveSocket(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = createConnection(path)
    client.once('connect', () => {
      client.destroy()
      resolve(true)
    })
    client.once('error', () => resolve(false))
  })
}

/** The peer directory, 0700 and ours; a stale ControlMaster socket is removed
 * (ssh would otherwise run without a master and clients could not attach). */
export async function prepareLinkDir(paths: LinkPaths): Promise<void> {
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 })
  const stat = lstatSync(paths.dir)
  if (!stat.isDirectory() || stat.uid !== process.getuid?.())
    throw new Error(`${paths.dir} is not a directory owned by this user`)
  chmodSync(paths.dir, 0o700)
  if (existsSync(paths.control)) {
    if (!lstatSync(paths.control).isSocket())
      throw new Error(`refusing to replace non-socket ${paths.control}`)
    if (await liveSocket(paths.control))
      throw new Error(`another link already holds ${paths.control}`)
    unlinkSync(paths.control)
  }
}

export interface LinkRuntime {
  spawn(argv: string[]): ChildProcess
  log(message: string): void
  now(): number
  random(): number
}

const defaultRuntime: LinkRuntime = {
  spawn: (argv) => spawn(SSH_BIN, argv, { stdio: ['ignore', 'inherit', 'inherit'] }),
  log: (message) => console.log(`[tether-link] ${message}`),
  now: Date.now,
  random: Math.random,
}

/** Run the link until SIGTERM/SIGINT. Logs only changes: up, lost, and the
 * first failure of a run of failures. */
export async function runLink(
  host: HostEntry,
  paths: LinkPaths,
  runtime: LinkRuntime = defaultRuntime,
): Promise<number> {
  let stopping = false
  let child: ChildProcess | null = null
  let wakeNow: (() => void) | null = null
  const stop = () => {
    stopping = true
    child?.kill('SIGTERM')
    wakeNow?.()
  }
  const retry = () => wakeNow?.()
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  process.on('SIGUSR1', retry)
  let attempt = 0
  let failing = false
  try {
    while (!stopping) {
      await prepareLinkDir(paths)
      const startedAt = runtime.now()
      let upAt: number | null = null
      const proc = runtime.spawn(linkArgv(host, paths))
      child = proc
      // Up means the master socket exists: ssh authenticated and set up forwards.
      const watch = setInterval(() => {
        if (upAt === null && existsSync(paths.control)) {
          upAt = runtime.now()
          runtime.log(`${host.name}: link up`)
          failing = false
        }
      }, 500)
      const code = await new Promise<number | null>((resolve) => {
        proc.once('exit', (exitCode) => resolve(exitCode))
        proc.once('error', () => resolve(null))
      })
      clearInterval(watch)
      child = null
      if (stopping) break
      const uptime = upAt === null ? 0 : runtime.now() - upAt
      if (upAt !== null) runtime.log(`${host.name}: link lost after ${Math.round(uptime / 1000)}s`)
      else if (!failing)
        runtime.log(
          `${host.name}: cannot reach ${host.ssh} (ssh exit ${code ?? 'error'} after ${runtime.now() - startedAt}ms); retrying quietly`,
        )
      failing = upAt === null
      attempt = uptime >= LINK_STABLE_MS ? 0 : attempt + 1
      const delay = linkBackoff(attempt, runtime.random)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay)
        wakeNow = () => {
          clearTimeout(timer)
          resolve()
        }
      })
      wakeNow = null
    }
  } finally {
    process.off('SIGTERM', stop)
    process.off('SIGINT', stop)
    process.off('SIGUSR1', retry)
  }
  return 0
}
