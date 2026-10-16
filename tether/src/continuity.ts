// Session continuity across reboots.
//
// While sessions run, Tether records each one's agent resume handle (the
// Claude Code session ID or the Codex thread ID its process holds open) in
// <stateDir>/continuity.json. After a reboot, startup reconciliation finds
// those sessions' tmux servers dead; Tether then recreates each session and
// relaunches its agent with the tool's resume adapter and a short "resumed
// after reboot" prompt. The catalog keeps the identity (tool, name, project);
// the snapshot adds only what the catalog cannot know: the native resume ID.
//
// Nightshift drives a planned reboot through `prepare` (list, ask agents to
// checkpoint, report readiness) and reads `status` after boot.

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

export const RESUME_PROMPT =
  'Tether resumed this session after a host reboot. Continue where you left off. ' +
  'Processes, servers and watchers you started before the reboot are gone; restart any you still need.'

export const CHECKPOINT_PROMPT =
  'A host reboot is pending. Checkpoint now: commit or save work in progress and write down your next step. ' +
  'Tether will resume this session after the reboot.'

/** The shape of Claude Code session IDs and Codex thread IDs. */
export const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/

export interface SnapshotSession {
  id: string
  tool: string
  /** Native resume ID, or null when none was observed (a shell, or an agent
   * that has not started a conversation yet). */
  resumeId: string | null
  observedAt: number
}

export interface ContinuitySnapshot {
  v: 1
  bootId: string
  updatedAt: number
  sessions: SnapshotSession[]
}

export interface RestoreEntry {
  id: string
  name: string | null
  tool: string
  resumed?: boolean
  reason?: string
}

export interface RestoreReport {
  v: 1
  bootId: string
  startedAt: number
  finishedAt: number | null
  restored: RestoreEntry[]
  failed: RestoreEntry[]
  pending: RestoreEntry[]
}

// --- agent observation --------------------------------------------------------

export interface ProcFs {
  readFile(path: string): string
  /** At most the first `bytes` of a file (rollouts grow to many MB). */
  readHead(path: string, bytes: number): string
  readdir(path: string): string[]
  readlink(path: string): string
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

// Both readers below depend on Claude Code's and Codex's undocumented file
// formats (docs/agent-state.md); agent state and reboot continuity share them.

export interface ClaudeSession {
  pid: number
  /** ~/.claude/sessions/<pid>.json */
  file: string
  state: Record<string, unknown>
}

/** Claude Code writes ~/.claude/sessions/<pid>.json for each interactive
 * process. Yields each pid whose file parses and names that pid (a stale file
 * left by a reused pid names another process). */
export function* claudeSessions(
  fs: ProcFs,
  home: string,
  pids: number[],
): Generator<ClaudeSession> {
  for (const pid of pids) {
    const file = join(home, '.claude', 'sessions', `${pid}.json`)
    let state: Record<string, unknown>
    try {
      state = JSON.parse(fs.readFile(file)) as Record<string, unknown>
      if (state.pid !== pid) continue
    } catch {
      continue
    }
    yield { pid, file, state }
  }
}

const ROLLOUT_RE = /\/\.codex\/sessions\/.*\/rollout-[^/]*\.jsonl$/

export interface CodexRolloutFile {
  pid: number
  path: string
  /** The thread ID from session_meta; null when it is not a UUID. */
  threadId: string | null
}

/** Codex keeps its thread's rollout file open. Yields each held rollout whose
 * session_meta marks the user thread (not a subagent's): the conversation
 * `codex resume` takes. */
export function* codexUserRollouts(fs: ProcFs, pids: number[]): Generator<CodexRolloutFile> {
  for (const pid of pids) {
    let fds: string[] = []
    try {
      fds = fs.readdir(`/proc/${pid}/fd`)
    } catch {
      continue
    }
    for (const fd of fds) {
      let target: string
      try {
        target = fs.readlink(`/proc/${pid}/fd/${fd}`)
      } catch {
        continue
      }
      if (!ROLLOUT_RE.test(target)) continue
      let threadId: string | null
      try {
        const first = fs.readHead(target, 1024 * 1024).split('\n', 1)[0]
        const meta = JSON.parse(first) as { type?: string; payload?: Record<string, unknown> }
        const payload = meta.payload ?? {}
        if (meta.type !== 'session_meta' || payload.parent_thread_id) continue
        if (payload.thread_source !== undefined && payload.thread_source !== 'user') continue
        threadId = typeof payload.id === 'string' && UUID_RE.test(payload.id) ? payload.id : null
      } catch {
        // unreadable or partial rollout
        continue
      }
      yield { pid, path: target, threadId }
    }
  }
}

/** The first Claude Code session in `pids` with a resumable session ID. */
export function observeClaude(fs: ProcFs, home: string, pids: number[]): AgentObservation | null {
  for (const { pid, state } of claudeSessions(fs, home, pids)) {
    if (typeof state.sessionId !== 'string' || !UUID_RE.test(state.sessionId)) continue
    return {
      pid,
      resumeId: state.sessionId,
      idle: state.status !== 'busy',
      blocked: state.status === 'waiting',
    }
  }
  return null
}

/** The first Codex user thread in `pids` with a resumable thread ID. */
export function observeCodex(fs: ProcFs, pids: number[]): AgentObservation | null {
  for (const { pid, threadId } of codexUserRollouts(fs, pids)) {
    if (threadId) return { pid, resumeId: threadId, idle: null, blocked: false }
  }
  return null
}

export function observeAgent(fs: ProcFs, home: string, panePid: number): AgentObservation | null {
  const pids = processTree(fs, panePid)
  return observeClaude(fs, home, pids) ?? observeCodex(fs, pids)
}

// --- state files ----------------------------------------------------------------

export function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

export function writeJsonFile(path: string, value: unknown): void {
  const tmp = `${path}.${randomUUID()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
}

export function currentBootId(fs: ProcFs = nodeProcFs): string {
  try {
    return fs.readFile('/proc/sys/kernel/random/boot_id').trim()
  } catch {
    return 'unknown'
  }
}

/**
 * Merge a fresh observation of running sessions into the previous snapshot.
 * A running session keeps its last known resume ID when the agent is between
 * conversations. A session that is not running drops out unless `retain`
 * keeps it (one still waiting to be restored after a reboot).
 */
export function mergeSnapshot(
  previous: ContinuitySnapshot | null,
  running: { id: string; tool: string; resumeId: string | null }[],
  retain: (id: string) => boolean,
  bootId: string,
  now: number,
): ContinuitySnapshot {
  const known = new Map((previous?.sessions ?? []).map((session) => [session.id, session]))
  const sessions: SnapshotSession[] = running.map((session) => {
    const before = known.get(session.id)
    const keep = before && before.tool === session.tool ? before : null
    return {
      id: session.id,
      tool: session.tool,
      resumeId: session.resumeId ?? keep?.resumeId ?? null,
      observedAt: session.resumeId ? now : (keep?.observedAt ?? now),
    }
  })
  const listed = new Set(sessions.map((session) => session.id))
  for (const session of previous?.sessions ?? []) {
    if (!listed.has(session.id) && retain(session.id)) sessions.push(session)
  }
  return { v: 1, bootId, updatedAt: now, sessions }
}

/** Sessions the snapshot saw running whose workload is gone now (status
 * `pending` after startup reconciliation found their tmux server dead). */
export function restoreCandidates(
  snapshot: ContinuitySnapshot | null,
  statusOf: (id: string) => string | null,
): SnapshotSession[] {
  if (!snapshot || snapshot.v !== 1 || !Array.isArray(snapshot.sessions)) return []
  return snapshot.sessions.filter((session) => statusOf(session.id) === 'pending')
}
