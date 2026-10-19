import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Host policy for which uids may launch panes, and for cross-user attach
 * (shared mode). Both live in root-owned files Tether only reads:
 *
 *   /etc/tether/policy.json   {"refuse_pane_uids":[1000], "attach":{"agent":["kasadis"]}}
 *   /etc/tether/allow-refused instance names still allowed while refused, one per line
 *
 * A missing policy file means no refusal and no shared mode (today's
 * behavior). Files are re-read on every use, never cached, and trusted only
 * when /etc/tether and the file are regular, root-owned and not group/other
 * writable (lstat, no symlinks).
 */
export const PANE_UID_REFUSED = 'pane_uid_refused'

export interface PolicyLocation {
  /** Directory that must itself be trusted. */
  dir: string
  policyFile: string
  allowFile: string
  /** Parent of `<username>/<instance>/` runtime dirs in shared mode. */
  sharedRoot: string
  /** Owner the files and directory must have. Only tests change it. */
  trustedUid: number
}

export const HOST_POLICY: PolicyLocation = {
  dir: '/etc/tether',
  policyFile: '/etc/tether/policy.json',
  allowFile: '/etc/tether/allow-refused',
  sharedRoot: '/run/tether',
  trustedUid: 0,
}

/** A test-only location rooted at `dir` (callers pass it explicitly). */
export function policyLocationIn(
  dir: string,
  sharedRoot: string,
  trustedUid: number,
): PolicyLocation {
  return {
    dir,
    policyFile: join(dir, 'policy.json'),
    allowFile: join(dir, 'allow-refused'),
    sharedRoot,
    trustedUid,
  }
}

export interface PanePolicy {
  /** absent: no file (no policy). untrusted/invalid: ignored, shown in doctor. */
  state: 'absent' | 'ok' | 'untrusted' | 'invalid'
  detail: string
  refuseUids: number[]
  attach: Record<string, string[]>
}

export interface AllowFlag {
  state: 'absent' | 'ok' | 'untrusted'
  detail: string
  instances: string[]
}

type Trusted =
  | { kind: 'absent' }
  | { kind: 'untrusted'; why: string }
  | { kind: 'ok'; text: string }

function readTrusted(location: PolicyLocation, file: string): Trusted {
  let dir: ReturnType<typeof lstatSync>
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }
    return { kind: 'untrusted', why: `${file} is not readable` }
  }
  try {
    dir = lstatSync(location.dir)
  } catch {
    return { kind: 'untrusted', why: `${location.dir} is not readable` }
  }
  if (!dir.isDirectory() || dir.uid !== location.trustedUid || dir.mode & 0o022)
    return {
      kind: 'untrusted',
      why: `${location.dir} must be a directory owned by root, not group/other writable`,
    }
  if (!stat.isFile() || stat.uid !== location.trustedUid || stat.mode & 0o022)
    return {
      kind: 'untrusted',
      why: `${file} must be a regular file owned by root, not group/other writable`,
    }
  try {
    return { kind: 'ok', text: readFileSync(file, 'utf8') }
  } catch {
    return { kind: 'untrusted', why: `${file} is not readable` }
  }
}

const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/

export function readPanePolicy(location: PolicyLocation = HOST_POLICY): PanePolicy {
  const none = { refuseUids: [], attach: {} }
  const read = readTrusted(location, location.policyFile)
  if (read.kind === 'absent')
    return { state: 'absent', detail: `no ${location.policyFile}`, ...none }
  if (read.kind === 'untrusted') return { state: 'untrusted', detail: read.why, ...none }
  try {
    const body = JSON.parse(read.text) as Record<string, unknown>
    const uids = body.refuse_pane_uids ?? []
    if (!Array.isArray(uids) || !uids.every((u) => Number.isSafeInteger(u) && (u as number) >= 0))
      throw new Error('refuse_pane_uids must be a list of uids')
    const attach: Record<string, string[]> = {}
    const raw = (body.attach ?? {}) as Record<string, unknown>
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
      throw new Error('attach must be an object')
    for (const [user, list] of Object.entries(raw)) {
      if (
        !USER_RE.test(user) ||
        !Array.isArray(list) ||
        !list.every((u) => typeof u === 'string' && USER_RE.test(u))
      )
        throw new Error(`attach.${user} must be a list of user names`)
      attach[user] = list as string[]
    }
    return { state: 'ok', detail: location.policyFile, refuseUids: uids as number[], attach }
  } catch (error) {
    return {
      state: 'invalid',
      detail: `${location.policyFile}: ${(error as Error).message}`,
      ...none,
    }
  }
}

export function readAllowFlag(location: PolicyLocation = HOST_POLICY): AllowFlag {
  const read = readTrusted(location, location.allowFile)
  if (read.kind === 'absent')
    return { state: 'absent', detail: `no ${location.allowFile}`, instances: [] }
  if (read.kind === 'untrusted') return { state: 'untrusted', detail: read.why, instances: [] }
  const instances = read.text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
  return { state: 'ok', detail: location.allowFile, instances }
}

/** Why this uid/instance may not launch a pane right now, or null. */
export function paneUidRefusal(
  uid: number,
  instance: string,
  location: PolicyLocation = HOST_POLICY,
): string | null {
  const policy = readPanePolicy(location)
  if (!policy.refuseUids.includes(uid)) return null
  if (readAllowFlag(location).instances.includes(instance)) return null
  return `uid ${uid} may not launch panes on this host (${location.policyFile}); instance "${instance}" is not in ${location.allowFile}`
}

// The daemon binds the running instance once, so every spawn point (engine,
// recovery, the Codex probe) asks the same question without threading config.
let bound: { instance: string; location: PolicyLocation } | null = null

export function bindPanePolicy(instance: string, location: PolicyLocation = HOST_POLICY): void {
  bound = { instance, location }
}

/** Refusal message for a pane launch by this process, or null. Unbound = none. */
export function currentPaneRefusal(): string | null {
  const uid = process.getuid?.()
  if (!bound || uid === undefined) return null
  return paneUidRefusal(uid, bound.instance, bound.location)
}

export interface SharedMode {
  username: string
  /** Users allowed to attach to this instance's tmux servers. */
  attachUsers: string[]
  /** `<sharedRoot>/<username>`: made by root, owned by this uid. */
  root: string
}

/** Shared mode: `<sharedRoot>/<me>` exists and is mine, and the policy lists attach users for me. */
export function detectSharedMode(
  uid: number,
  location: PolicyLocation = HOST_POLICY,
  username?: string,
): SharedMode | null {
  const policy = readPanePolicy(location)
  if (policy.state !== 'ok') return null
  let name = username
  if (name === undefined) {
    try {
      name = userInfo().username
    } catch {
      return null
    }
  }
  const attachUsers = (policy.attach[name] ?? []).filter((user) => user !== name)
  if (attachUsers.length === 0) return null
  const root = join(location.sharedRoot, name)
  try {
    const stat = lstatSync(root)
    if (!stat.isDirectory() || stat.uid !== uid) return null
  } catch {
    return null
  }
  return { username: name, attachUsers, root }
}

/**
 * Make a shared-mode directory: born 0750 with the root-made parent's group and
 * setgid. Never chmod it afterwards: chmod by a user outside the file's group
 * silently drops setgid (chmod(2)), and sockets made later would get our own group.
 */
export function makeSharedDir(path: string): void {
  const previous = process.umask(0o027)
  try {
    mkdirSync(path, { recursive: true, mode: 0o750 })
  } finally {
    process.umask(previous)
  }
}

/**
 * The instance runtime dir in shared mode, made fresh when an earlier start left
 * it without the parent's setgid (an older Tether chmod'ed it). Only while no
 * tmux server lives in it: removing it then would cut live panes off.
 */
export function prepareSharedRuntime(runtimeDir: string, tmuxDir: string): void {
  const setgid = (path: string) => {
    try {
      return (lstatSync(path).mode & 0o2000) !== 0
    } catch {
      return false
    }
  }
  if (setgid(dirname(runtimeDir)) && !setgid(runtimeDir)) {
    let servers: string[] = []
    try {
      servers = readdirSync(tmuxDir)
    } catch {}
    try {
      lstatSync(runtimeDir)
      if (servers.length)
        throw new Error(
          `${runtimeDir} lost setgid but still holds tmux servers; restart after they end`,
        )
      rmSync(runtimeDir, { recursive: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  makeSharedDir(runtimeDir)
}
