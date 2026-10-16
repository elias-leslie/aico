import { readFileSync, unlinkSync } from 'node:fs'

/**
 * Linux process start time: field 22 of `/proc/<pid>/stat`, in clock ticks
 * since boot, exactly as procfs prints it. Together with the PID it names one
 * process: a reused PID has a different start time. Readers compare the
 * string with their own read of `/proc/<pid>/stat`.
 */
export function parseStartTime(stat: string): string | null {
  // The command name (field 2) is in parentheses and may hold spaces or ')'.
  const close = stat.lastIndexOf(')')
  if (close < 0) return null
  const starttime = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/)[19]
  return starttime && /^\d+$/.test(starttime) ? starttime : null
}

/** This process's start time, or null where procfs can't be read. */
export function ownStartTime(): string | null {
  try {
    return parseStartTime(readFileSync('/proc/self/stat', 'utf8'))
  } catch {
    return null
  }
}

/**
 * Remove a pidfile only while it still names `pid`, so a quitting process never
 * deletes a newer runtime's registration. True when it removed the file.
 */
export function removeOwnPidFile(path: string, pid: number = process.pid): boolean {
  try {
    if (readFileSync(path, 'utf8').trim() !== String(pid)) return false
    unlinkSync(path)
    return true
  } catch {
    return false // already gone, or unreadable: nothing of ours to remove
  }
}
