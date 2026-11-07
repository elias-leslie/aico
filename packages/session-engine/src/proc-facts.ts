// What Tether and the agent adapters read about processes and files, as plain
// interfaces, plus the one reader every adapter shares (the conversation id Tether
// chose, from a process's environment). A leaf: it imports no Tether module but
// config, so the adapter contract can name these without a cycle through the
// registry. proc-fs.ts, entry-files.ts and recovery-facts.ts re-export them.

import type { EntryScanConfig } from './entry-scan'

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

export interface FileReader {
  /** The file's text, or only its last `maxBytes` (starting at a line). */
  read(path: string, maxBytes?: number): string | null
  list(path: string): string[]
  mtime(path: string): number | null
}

/** Readers bound to one entry home: none of them reads outside it. */
export interface EntryHomeFiles {
  /** The home as the host resolves it (its parent's symlinks resolved): build
   * paths from this. */
  home: string
  fs: ProcFs
  tail: FileTail
  reader: FileReader
  scan: EntryScanConfig
}

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

/** Environment variable carrying the conversation ID Tether chose for an
 * agent that keeps no observable session record (root-launch.ts). */
export const AGENT_SESSION_ENV = 'TETHER_AGENT_SESSION_ID'

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
