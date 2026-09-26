import { execFile } from 'node:child_process'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { isOwnedPaneControlGroup, isOwnedPaneScope, isSystemdInvocationId } from './ownership'

const execFileAsync = promisify(execFile)
const SYSTEMCTL_BIN = '/usr/bin/systemctl'
const SYSTEMD_QUERY_TIMEOUT_MS = 2_000
const SYSTEMD_STOP_TIMEOUT_MS = 5_000

export interface ScopeIdentity {
  loadState: string
  activeState: string
  controlGroup: string
  invocationId: string
  job: string
}

export async function scopeIdentity(unit: string): Promise<ScopeIdentity | null> {
  try {
    const { stdout } = await execFileAsync(
      SYSTEMCTL_BIN,
      [
        '--user',
        'show',
        unit,
        '--no-pager',
        '--property=LoadState',
        '--property=ActiveState',
        '--property=ControlGroup',
        '--property=InvocationID',
        '--property=Job',
      ],
      { timeout: SYSTEMD_QUERY_TIMEOUT_MS },
    )
    const properties = new Map<string, string>()
    for (const line of stdout.split('\n')) {
      const separator = line.indexOf('=')
      if (separator > 0) properties.set(line.slice(0, separator), line.slice(separator + 1))
    }
    return {
      loadState: properties.get('LoadState') ?? 'unknown',
      activeState: properties.get('ActiveState') ?? 'unknown',
      controlGroup: properties.get('ControlGroup') ?? '',
      invocationId: properties.get('InvocationID') ?? '',
      job: properties.get('Job') ?? '',
    }
  } catch {
    return null
  }
}

export function readCgroupPopulated(controlGroup: string): boolean | null {
  try {
    const events = readFileSync(`/sys/fs/cgroup${controlGroup}/cgroup.events`, 'utf8')
    if (/^populated 0$/m.test(events)) return false
    if (/^populated 1$/m.test(events)) return true
    return null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    return null
  }
}

interface CgroupIdentity {
  dev: bigint
  ino: bigint
}

function cgroupIdentity(controlGroup: string): CgroupIdentity | null {
  try {
    const stat = statSync(`/sys/fs/cgroup${controlGroup}`, { bigint: true })
    return { dev: stat.dev, ino: stat.ino }
  } catch {
    return null
  }
}

function sameCgroupIdentity(left: CgroupIdentity, right: CgroupIdentity | null): boolean {
  return Boolean(right && left.dev === right.dev && left.ino === right.ino)
}

async function emptyOwnedCgroup(
  unit: string,
  controlGroup: string,
  expectedIdentity: CgroupIdentity,
  reason: string,
): Promise<boolean> {
  const uid = process.getuid?.() ?? -1
  if (!isOwnedPaneControlGroup(unit, controlGroup, uid)) return false
  const populated = readCgroupPopulated(controlGroup)
  if (populated === false) return true
  if (populated === null) return false

  // The exact cgroup identity is checked again before cgroup.kill so a replaced
  // unit cannot inherit cleanup authority after systemctl stop.
  console.warn(`[aico:lifecycle] forcing still-populated owned cgroup ${unit} after ${reason}`)
  if (!sameCgroupIdentity(expectedIdentity, cgroupIdentity(controlGroup))) {
    console.error(`[aico:lifecycle] refusing cgroup.kill for replaced cgroup ${unit}`)
    return false
  }
  try {
    writeFileSync(`/sys/fs/cgroup${controlGroup}/cgroup.kill`, '1')
  } catch (error) {
    console.error(`[aico:lifecycle] cgroup.kill failed for ${unit}:`, error)
    return false
  }
  const deadline = Date.now() + SYSTEMD_QUERY_TIMEOUT_MS
  do {
    const state = readCgroupPopulated(controlGroup)
    if (state === false) return true
    if (state === null) return false
    await new Promise((resolve) => setTimeout(resolve, 25))
  } while (Date.now() < deadline)
  return false
}

export async function stopOwnedPaneScope(
  unit: string | null,
  expectedInvocationId: string | null,
  reason: string,
): Promise<boolean> {
  if (!isOwnedPaneScope(unit) || !isSystemdInvocationId(expectedInvocationId)) return false
  const before = await scopeIdentity(unit)
  if (!before) return false
  const uid = process.getuid?.() ?? -1
  if (before.loadState === 'not-found' && !before.controlGroup) {
    const expectedControlGroup = `/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/${unit}`
    const residue = readCgroupPopulated(expectedControlGroup)
    if (residue === false) return true
    console.error(
      `[aico:lifecycle] refusing to treat missing unit ${unit} as clean: cgroup residue is ${
        residue === true ? 'populated' : 'unverifiable'
      }`,
    )
    return false
  }
  if (
    before.invocationId !== expectedInvocationId ||
    !isOwnedPaneControlGroup(unit, before.controlGroup, uid)
  ) {
    console.error(`[aico:lifecycle] refusing ${unit}: invocation identity changed before ${reason}`)
    return false
  }
  const beforeCgroupIdentity = cgroupIdentity(before.controlGroup)
  if (!beforeCgroupIdentity) {
    console.error(
      `[aico:lifecycle] refusing ${unit}: cgroup identity is unavailable before ${reason}`,
    )
    return false
  }
  try {
    await execFileAsync(SYSTEMCTL_BIN, ['--user', 'stop', unit], {
      timeout: SYSTEMD_STOP_TIMEOUT_MS,
    })
  } catch (error) {
    console.warn(`[aico:lifecycle] stop ${unit} (${reason}) returned an error:`, error)
  }
  try {
    if (await emptyOwnedCgroup(unit, before.controlGroup, beforeCgroupIdentity, reason)) {
      console.log(`[aico:lifecycle] scope ${unit} empty after ${reason}`)
      return true
    }
    console.error(`[aico:lifecycle] scope ${unit} remains populated after ${reason}`)
    return false
  } catch (error) {
    console.error(`[aico:lifecycle] could not verify scope ${unit} after ${reason}:`, error)
    return false
  }
}
