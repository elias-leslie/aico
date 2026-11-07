// Process and file facts the agent adapters and the continuity code share:
// /proc reads, process trees, the readers an entry home allows. A leaf module
// (no adapter imports it back), so adapters can build on it at load time.

import {
  closeSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  statSync,
} from 'node:fs'
import type { EntryHomeFiles, FileTail, ProcFs } from './proc-facts'

export type {
  AgentObservation,
  EntryProcess,
  FileTail,
  ProcFs,
} from './proc-facts'
export {
  AGENT_SESSION_ENV,
  observeChosenSession,
  UUID_RE,
} from './proc-facts'

let entryHomeReaders: (home: string) => EntryHomeFiles | null = () => null

/** The readers for an entry home (src/entry-files.ts binds them when it loads), so
 * this leaf does not import the file that builds them. */
export function bindEntryHomeFiles(readers: (home: string) => EntryHomeFiles | null): void {
  entryHomeReaders = readers
}

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
  entryHome: (home) => entryHomeReaders(home),
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

/** A FileTail over files `open` returns descriptors for. */
export function fileTail(open: (path: string) => number): FileTail {
  return {
    read(path, offset, max) {
      const fd = open(path)
      try {
        const size = fstatSync(fd).size
        let start = offset > size ? 0 : offset
        if (size - start > max) start = size - max
        const buffer = Buffer.alloc(size - start)
        const read = readSync(fd, buffer, 0, buffer.length, start)
        const text = buffer.subarray(0, read).toString('utf8')
        // Hold back a partial last line until it is complete.
        const end = text.lastIndexOf('\n') + 1
        return {
          text: text.slice(0, end),
          offset: start + Buffer.byteLength(text.slice(0, end)),
          size,
        }
      } finally {
        closeSync(fd)
      }
    },
    range(path, start, end) {
      const fd = open(path)
      try {
        const buffer = Buffer.alloc(Math.max(0, end - start))
        return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, start))
      } finally {
        closeSync(fd)
      }
    },
  }
}

export const nodeFileTail: FileTail = fileTail((path) => openSync(path, 'r'))

/** The fresh conversation id Tether picks host-side for such an agent's launch
 * (root-launch.ts), so a host reader knows it even when the agent runs where
 * its environment cannot be read (an entry's container). */
export const FRESH_SESSION_ENV = 'AICO_ROOT_FRESH_SESSION_ID'
