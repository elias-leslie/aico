import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { callSocket } from './client'
import type { TetherPaths } from './config'

export type CheckStatus = 'ok' | 'warn' | 'fail'

export interface Check {
  name: string
  status: CheckStatus
  detail: string
}

export const MIN_SYSTEMD = 254
export const MIN_NODE: [number, number] = [22, 13]

export function checkLinger(value: string | null): Check {
  if (value === 'yes') return { name: 'linger', status: 'ok', detail: 'Linger=yes' }
  return {
    name: 'linger',
    status: 'fail',
    detail: `Linger=${value ?? 'unknown'}; durable sessions die at logout. Run: sudo loginctl enable-linger $USER`,
  }
}

export function parseSystemdVersion(output: string): number | null {
  const match = /^systemd (\d+)/m.exec(output)
  return match ? Number(match[1]) : null
}

export function checkSystemd(output: string | null): Check {
  const version = output === null ? null : parseSystemdVersion(output)
  if (version === null) return { name: 'systemd', status: 'fail', detail: 'systemctl not found' }
  return version >= MIN_SYSTEMD
    ? { name: 'systemd', status: 'ok', detail: `systemd ${version}` }
    : { name: 'systemd', status: 'fail', detail: `systemd ${version} < ${MIN_SYSTEMD}` }
}

/** Unified hierarchy: cgroup.controllers at the root and a single `0::` line. */
export function checkCgroup(hasControllers: boolean, selfCgroup: string | null): Check {
  const unified = selfCgroup !== null && /^0::\//.test(selfCgroup.trim())
  return hasControllers && unified
    ? { name: 'cgroup-v2', status: 'ok', detail: 'unified cgroup v2 hierarchy' }
    : { name: 'cgroup-v2', status: 'fail', detail: 'cgroup v2 (unified) hierarchy required' }
}

export function checkNode(version: string, hasSqlite: boolean): Check {
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number)
  const okVersion = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])
  if (!okVersion) {
    return {
      name: 'node',
      status: 'fail',
      detail: `node ${version} < ${MIN_NODE.join('.')}`,
    }
  }
  return hasSqlite
    ? { name: 'node', status: 'ok', detail: `node ${version} with node:sqlite` }
    : { name: 'node', status: 'fail', detail: `node ${version} lacks node:sqlite` }
}

export interface PathMode {
  exists: boolean
  isSocket?: boolean
  isDirectory?: boolean
  mode?: number
  uid?: number
}

export function checkSocket(dir: PathMode, socket: PathMode, uid: number): Check {
  if (!socket.exists) {
    return { name: 'socket', status: 'warn', detail: 'control socket absent (daemon not running)' }
  }
  const problems: string[] = []
  if (!dir.isDirectory || dir.uid !== uid || ((dir.mode ?? 0) & 0o777) !== 0o700)
    problems.push(`directory must be 0700 and owned by uid ${uid}`)
  if (!socket.isSocket || socket.uid !== uid || ((socket.mode ?? 0) & 0o777) !== 0o600)
    problems.push(`socket must be a 0600 socket owned by uid ${uid}`)
  return problems.length
    ? { name: 'socket', status: 'fail', detail: problems.join('; ') }
    : { name: 'socket', status: 'ok', detail: 'directory 0700, socket 0600' }
}

export function checkMemoryGuard(confs: string[]): Check {
  const guarded = confs.some((text) => /^\s*MemoryMax=/m.test(text))
  return guarded
    ? { name: 'memory-guard', status: 'ok', detail: 'tmux-spawn-.scope MemoryMax drop-in present' }
    : {
        name: 'memory-guard',
        status: 'warn',
        detail: 'no tmux-spawn-.scope MemoryMax drop-in; run scripts/install.sh',
      }
}

/** Only `tether@default` should start at boot. A test instance enabled at
 * boot comes back after every reboot with its own catalog and sockets. */
export function checkEnabledInstances(enabled: string[]): Check {
  const extra = enabled.filter((instance) => instance !== 'default').sort()
  if (extra.length === 0) {
    return {
      name: 'instances',
      status: 'ok',
      detail: enabled.includes('default')
        ? 'only tether@default is enabled at boot'
        : 'no instance is enabled at boot',
    }
  }
  const units = extra.map((instance) => `tether@${instance}.service`).join(' ')
  return {
    name: 'instances',
    status: 'warn',
    detail: `enabled at boot besides default: ${extra.join(', ')}. Run: systemctl --user disable ${units}`,
  }
}

/** Instances enabled in the user unit directory's `*.wants` links. */
function readEnabledInstances(): string[] {
  const unitDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user')
  const instances = new Set<string>()
  let wants: string[] = []
  try {
    wants = readdirSync(unitDir).filter((name) => name.endsWith('.wants'))
  } catch {
    return []
  }
  for (const dir of wants) {
    try {
      for (const name of readdirSync(join(unitDir, dir))) {
        const match = /^tether@([a-z0-9][a-z0-9-]{0,31})\.service$/.exec(name)
        if (match?.[1]) instances.add(match[1])
      }
    } catch {
      // unreadable wants directory: nothing enabled through it
    }
  }
  return [...instances]
}

function stat(path: string): PathMode {
  try {
    const s = lstatSync(path)
    return {
      exists: true,
      isSocket: s.isSocket(),
      isDirectory: s.isDirectory(),
      mode: s.mode,
      uid: s.uid,
    }
  } catch {
    return { exists: false }
  }
}

function run(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, { encoding: 'utf8', timeout: 3_000 })
  } catch {
    return null
  }
}

async function hasNodeSqlite(): Promise<boolean> {
  try {
    await import('node:sqlite')
    return true
  } catch {
    return false
  }
}

function readMemoryGuardConfs(): string[] {
  const dir = join(
    process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
    'systemd',
    'user',
    'tmux-spawn-.scope.d',
  )
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.conf'))
      .map((name) => readFileSync(join(dir, name), 'utf8'))
  } catch {
    return []
  }
}

export async function runDoctor(paths: TetherPaths): Promise<Check[]> {
  const uid = process.getuid?.() ?? -1
  const linger = run('loginctl', ['show-user', String(uid), '--property=Linger', '--value'])
  const selfCgroup = existsSync('/proc/self/cgroup')
    ? readFileSync('/proc/self/cgroup', 'utf8')
    : null
  const checks: Check[] = [
    checkLinger(linger?.trim() ?? null),
    checkSystemd(run('systemctl', ['--version'])),
    checkCgroup(existsSync('/sys/fs/cgroup/cgroup.controllers'), selfCgroup),
    checkNode(process.version, await hasNodeSqlite()),
    run('/usr/bin/tmux', ['-V'])
      ? { name: 'tmux', status: 'ok', detail: (run('/usr/bin/tmux', ['-V']) ?? '').trim() }
      : { name: 'tmux', status: 'fail', detail: '/usr/bin/tmux not found' },
    checkMemoryGuard(readMemoryGuardConfs()),
    checkEnabledInstances(readEnabledInstances()),
    checkSocket(stat(paths.socketDir), stat(paths.socket), uid),
  ]
  const socketCheck = checks.at(-1)
  if (socketCheck?.status === 'ok') {
    try {
      const health = await callSocket(paths.socket, 'GET', '/v1/health', undefined, 2_000)
      const body = health.body as { apiVersion?: number; version?: string } | null
      checks.push(
        health.status === 200
          ? {
              name: 'daemon',
              status: 'ok',
              detail: `tether ${body?.version} api v${body?.apiVersion} (${paths.instance})`,
            }
          : { name: 'daemon', status: 'fail', detail: `health returned HTTP ${health.status}` },
      )
    } catch (error) {
      checks.push({ name: 'daemon', status: 'fail', detail: (error as Error).message })
    }
  }
  return checks
}
