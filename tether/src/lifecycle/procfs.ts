// Read-only views of /proc and the cgroup v2 tree, used to prove which exact
// process and scope a tmux server or pane is before acting on it. Readers answer
// null (or false) when the process is gone or unreadable, except
// processControlGroup, which throws so its callers can tell "gone" apart.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function processEnvironment(pid: number): ReadonlyMap<string, string> | null {
  try {
    return new Map(
      readFileSync(`/proc/${pid}/environ`, 'utf8')
        .split('\0')
        .filter(Boolean)
        .map((entry) => {
          const separator = entry.indexOf('=')
          return separator < 0
            ? ([entry, ''] as const)
            : ([entry.slice(0, separator), entry.slice(separator + 1)] as const)
        }),
    )
  } catch {
    return null
  }
}

export function processStartTime(pid: number): string | null {
  try {
    return processStartTimeFromStat(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    return null
  }
}

export function processStartTimeFromStat(stat: string): string | null {
  const fields = stat
    .slice(stat.lastIndexOf(') ') + 2)
    .trim()
    .split(/\s+/)
  // The slice starts at proc field 3 (state); field 22 is process starttime.
  return fields[19] ?? null
}

export function processControlGroup(pid: number): string | null {
  const cgroup = readFileSync(`/proc/${pid}/cgroup`, 'utf8')
  for (const line of cgroup.split('\n')) {
    const separator = line.indexOf('::')
    if (separator >= 0) return line.slice(separator + 2)
  }
  return null
}

export function processInControlGroup(pid: number, controlGroup: string): boolean {
  try {
    return readFileSync(`/proc/${pid}/cgroup`, 'utf8')
      .split('\n')
      .some((line) => line.endsWith(`:${controlGroup}`))
  } catch {
    return false
  }
}

export function cgroupProcessIds(controlGroup: string): number[] | null {
  try {
    const root = `/sys/fs/cgroup${controlGroup}`
    const pending = [root]
    const processIds: number[] = []
    while (pending.length > 0) {
      const directory = pending.pop() as string
      processIds.push(
        ...readFileSync(join(directory, 'cgroup.procs'), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map(Number)
          .filter((pid) => Number.isInteger(pid) && pid > 0),
      )
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) pending.push(join(directory, entry.name))
      }
    }
    return processIds
  } catch {
    return null
  }
}

/** The fixed gate is safe to advance only while it is the sole process in the
 * exact owned cgroup, including every descendant cgroup. If a prior send
 * already started or delegated anything, ambiguity preserves it and never
 * replays a launcher. `runInPaneTargetArgs` also clears a partially typed line
 * before its literal send, making restart recovery idempotent before Enter. */
export function isExactLaunchGateProcess(pid: number): boolean | null {
  try {
    const command = readFileSync(`/proc/${pid}/cmdline`)
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
    return (
      command.length === 3 &&
      command[0] === '/bin/bash' &&
      command[1] === '--noprofile' &&
      command[2] === '--norc'
    )
  } catch {
    return null
  }
}
