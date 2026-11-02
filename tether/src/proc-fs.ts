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
import { ENTRY_SCAN_DEFAULTS, type EntryScanConfig } from './config'
import { type EntryHomeFiles, entryHomeFiles, fileTail } from './entry-files'

/** The shape of Claude Code session IDs and Codex thread IDs. */
export const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/

export interface ProcFs {
  readFile(path: string): string
  /** At most the first `bytes` of a file (rollouts grow to many MB). */
  readHead(path: string, bytes: number): string
  readdir(path: string): string[]
  readlink(path: string): string
  /** Last modification time in ms; null when the file is gone. Readers that
   * pick the newest file (entry homes) use it; without it they go by name. */
  mtimeMs?(path: string): number | null
  /** Readers that never leave an entry home (entry-files.ts); null when the
   * home is not a real directory. The host's ProcFs has them. */
  entryHome?(home: string): EntryHomeFiles | null
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

export interface AgentObservation {
  /** The agent's process (the one holding the session file or rollout). */
  pid: number
  resumeId: string
  /** Claude reports busy/idle; null when the tool does not say. */
  idle: boolean | null
  /** Claude is at a permission prompt or question; false when the tool does not say. */
  blocked: boolean
}

export interface FileTail {
  /** Bytes appended since `offset` (at most `max`, ending at a newline), and
   * the new offset. A shrunk file restarts from 0. */
  read(path: string, offset: number, max: number): { text: string; offset: number; size: number }
  /** Bytes `[start, end)` of the file. */
  range(path: string, start: number, end: number): Buffer
}

export const nodeFileTail: FileTail = fileTail((path) => openSync(path, 'r'))

/** The entry process of a session that runs its agent through an entry. */
export interface EntryProcess {
  /** The entry process on this host: alive exactly while the agent runs. */
  pid: number
  /** Host path of the agent's home. */
  home: string
  /** The agent it runs (an adapter id); null for a marker naming no entry tool (read nothing). */
  tool: string | null
  /** The conversation id Tether chose for this launch (Pi), from the entry
   * process's own environment as root-launch.ts set it: the resume id of an
   * initial launch that resumes, else the fresh id. null when it carries none. */
  chosenId: string | null
}

export interface EntryReaders {
  /** The home to build paths from. */
  home: string
  fs: ProcFs
  /** The contained tail for a file found here; null: the reader's own. */
  tail: FileTail | null
  scan: EntryScanConfig
}

export function entryReaders(fs: ProcFs, home: string): EntryReaders | null {
  if (!fs.entryHome) return { home, fs, tail: null, scan: ENTRY_SCAN_DEFAULTS }
  return fs.entryHome(home)
}

/** Environment variable carrying the conversation ID Tether chose for an
 * agent that keeps no observable session record (root-launch.ts). */
export const AGENT_SESSION_ENV = 'TETHER_AGENT_SESSION_ID'
/** The fresh conversation id Tether picks host-side for such an agent's launch
 * (root-launch.ts), so a host reader knows it even when the agent runs where
 * its environment cannot be read (an entry's container). */
export const FRESH_SESSION_ENV = 'AICO_ROOT_FRESH_SESSION_ID'

/** The first process in `pids` (pane order, so the agent before anything it
 * started) launched under a Tether-chosen conversation ID. */
export function observeChosenSession(fs: ProcFs, pids: number[]): AgentObservation | null {
  for (const pid of pids) {
    let environ: string
    try {
      environ = fs.readFile(`/proc/${pid}/environ`)
    } catch {
      continue
    }
    for (const entry of environ.split('\0')) {
      if (!entry.startsWith(`${AGENT_SESSION_ENV}=`)) continue
      const id = entry.slice(AGENT_SESSION_ENV.length + 1)
      if (UUID_RE.test(id)) return { pid, resumeId: id, idle: null, blocked: false }
    }
  }
  return null
}
