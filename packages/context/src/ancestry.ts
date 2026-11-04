// Who started this process. `aico context deliver` runs from a tool's hook, so
// the agent that started it is a few parents up; the delivered marker
// (AICO_CONTEXT_PID, the pid of the agent Tether launched) counts only then.

import { readFileSync } from 'node:fs'

/** The parent of a process, or null when it cannot be read (Linux /proc). */
export function parentOf(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // "pid (comm) S ppid ...": comm may hold spaces and parentheses, so cut after the last ")".
    const parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
    return Number.isInteger(parent) && parent > 0 ? parent : null
  } catch {
    return null
  }
}

/** Is `agent` this process's parent, or one of its next `hops - 1` ancestors? */
export function startedBy(
  agent: number,
  hops: number,
  self: number = process.pid,
  parent: (pid: number) => number | null = parentOf,
): boolean {
  let pid = self
  for (let hop = 0; hop < hops; hop++) {
    const next = parent(pid)
    if (next === null) return false
    if (next === agent) return true
    pid = next
  }
  return false
}
