// Process and file facts the agent adapters and the continuity code share:
// /proc reads, process trees, the readers an entry home allows. A leaf module
// (no adapter imports it back), so adapters can build on it at load time.

import {
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  statSync,
} from 'node:fs'
import { ENTRY_SCAN_DEFAULTS } from './config'
import { entryHomeFiles, fileTail } from './entry-files'
import type { EntryReaders, FileTail, ProcFs } from './proc-facts'

export type {
  AgentObservation,
  EntryProcess,
  EntryReaders,
  FileTail,
  ProcFs,
} from './proc-facts'
export {
  AGENT_SESSION_ENV,
  observeChosenSession,
  UUID_RE,
} from './proc-facts'

export const nodeProcFs: ProcFs = {
  readFile: (path) => readFileSync(path, 'utf8'),
  readHead: (path, bytes) => {
    const fd = openSync(path, 'r')
    try {
      const buffer = Buffer.alloc(bytes)
      return buffer.subarray(0, readSync(fd, buffer, 0, bytes, 0)).toString('utf8')
    } finally {
      closeSync(fd)
    }
  },
  readdir: (path) => readdirSync(path),
  readlink: (path) => readlinkSync(path),
  mtimeMs: (path) => {
    try {
      return statSync(path).mtimeMs
    } catch {
      return null
    }
  },
  entryHome: (home) => entryHomeFiles(home),
}

/** The pane process and all its descendants (bounded). */
export function processTree(fs: ProcFs, root: number, limit = 512): number[] {
  const seen = new Set<number>()
  const queue = [root]
  while (queue.length && seen.size < limit) {
    const pid = queue.shift() as number
    if (seen.has(pid)) continue
    seen.add(pid)
    let tasks: string[] = []
    try {
      tasks = fs.readdir(`/proc/${pid}/task`)
    } catch {
      continue
    }
    for (const task of tasks) {
      try {
        for (const child of fs.readFile(`/proc/${pid}/task/${task}/children`).split(/\s+/)) {
          if (/^[1-9][0-9]*$/.test(child)) queue.push(Number(child))
        }
      } catch {
        // task ended mid-walk
      }
    }
  }
  return [...seen]
}

export const nodeFileTail: FileTail = fileTail((path) => openSync(path, 'r'))

export function entryReaders(fs: ProcFs, home: string): EntryReaders | null {
  if (!fs.entryHome) return { home, fs, tail: null, scan: ENTRY_SCAN_DEFAULTS }
  return fs.entryHome(home)
}

/** The fresh conversation id Tether picks host-side for such an agent's launch
 * (root-launch.ts), so a host reader knows it even when the agent runs where
 * its environment cannot be read (an entry's container). */
export const FRESH_SESSION_ENV = 'AICO_ROOT_FRESH_SESSION_ID'
