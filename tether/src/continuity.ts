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
  statSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join } from 'node:path'

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
  /** Last modification time in ms; null when the file is gone. Readers that
   * pick the newest file (entry homes) use it; without it they go by name. */
  mtimeMs?(path: string): number | null
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

function readClaudeSession(fs: ProcFs, home: string, pid: number): ClaudeSession | null {
  const file = join(home, '.claude', 'sessions', `${pid}.json`)
  try {
    const state = JSON.parse(fs.readFile(file)) as Record<string, unknown>
    return state.pid === pid ? { pid, file, state } : null
  } catch {
    return null
  }
}

/** The running background job `jobId` (`kind: bg`, under Claude's daemon):
 * in the pane's tree when this session's own daemon hosts it, else any live
 * session file that names it. */
function claudeJob(fs: ProcFs, home: string, pids: number[], jobId: string): ClaudeSession | null {
  const isJob = (session: ClaudeSession | null) =>
    session?.state.jobId === jobId && session.state.kind === 'bg'
  for (const pid of pids) {
    const session = readClaudeSession(fs, home, pid)
    if (isJob(session)) return session
  }
  let names: string[] = []
  try {
    names = fs.readdir(join(home, '.claude', 'sessions'))
  } catch {
    return null
  }
  for (const name of names) {
    const pid = /^([1-9][0-9]*)\.json$/.exec(name)?.[1]
    if (!pid || pids.includes(Number(pid))) continue
    const session = readClaudeSession(fs, home, Number(pid))
    if (!isJob(session)) continue
    try {
      fs.readFile(`/proc/${pid}/stat`)
      return session
    } catch {
      // a file left by a job that ended
    }
  }
  return null
}

/** Claude Code writes ~/.claude/sessions/<pid>.json for each interactive
 * process. Yields each pid whose file parses and names that pid (a stale file
 * left by a reused pid names another process). A session parked into a
 * background job (`parkedJobId`) stops updating its own file: the pane shows
 * the job, so the job's file stands in for it. */
export function* claudeSessions(
  fs: ProcFs,
  home: string,
  pids: number[],
): Generator<ClaudeSession> {
  const seen = new Set<number>()
  for (const pid of pids) {
    if (seen.has(pid)) continue
    let session = readClaudeSession(fs, home, pid)
    if (!session) continue
    const parked = session.state.parkedJobId
    if (typeof parked === 'string' && parked) session = claudeJob(fs, home, pids, parked) ?? session
    seen.add(session.pid)
    yield session
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
      const user = codexUserThread(fs, target)
      if (user) yield { pid, path: target, threadId: user.threadId }
    }
  }
}

/** A rollout's session_meta when it marks the user thread (not a subagent's);
 * null for a subagent's or an unreadable or partial rollout. */
function codexUserThread(fs: ProcFs, path: string): { threadId: string | null } | null {
  try {
    const first = fs.readHead(path, 1024 * 1024).split('\n', 1)[0] as string
    const meta = JSON.parse(first) as { type?: string; payload?: Record<string, unknown> }
    const payload = meta.payload ?? {}
    if (meta.type !== 'session_meta' || payload.parent_thread_id) return null
    if (payload.thread_source !== undefined && payload.thread_source !== 'user') return null
    return {
      threadId: typeof payload.id === 'string' && UUID_RE.test(payload.id) ? payload.id : null,
    }
  } catch {
    return null
  }
}

// --- entry sessions (src/lifecycle/entries.ts) ---------------------------------

/** Set by Tether on a session's entry process only: the host path of the
 * agent's home. Not passed into the entry's container by Tether. */
export const ENTRY_HOME_ENV = 'TETHER_ENTRY_HOME'
/** Set next to ENTRY_HOME_ENV: which agent runs through the entry, so its
 * state is read the way that agent writes it. A session launched before this
 * marker existed has none and is Claude Code (the only entry tool then). */
export const ENTRY_TOOL_ENV = 'TETHER_ENTRY_TOOL'
/** The tools an entry can run: Tether reads their state from the entry home. */
export const ENTRY_TOOLS = ['claude-code', 'codex'] as const
export type EntryTool = (typeof ENTRY_TOOLS)[number]

export interface EntryProcess {
  /** The entry process on this host: alive exactly while the agent runs. */
  pid: number
  /** Host path of the agent's home. */
  home: string
  /** The agent it runs; null for a marker naming no entry tool (read nothing). */
  tool: EntryTool | null
}

/** The pane's entry process, the first in pane order marked with the home. */
export function findEntryProcess(fs: ProcFs, pids: number[]): EntryProcess | null {
  for (const pid of pids) {
    let environ: string
    try {
      environ = fs.readFile(`/proc/${pid}/environ`)
    } catch {
      continue
    }
    let home: string | null = null
    let tool: string | null = null
    for (const entry of environ.split('\0')) {
      if (entry.startsWith(`${ENTRY_HOME_ENV}=`)) home = entry.slice(ENTRY_HOME_ENV.length + 1)
      else if (entry.startsWith(`${ENTRY_TOOL_ENV}=`)) tool = entry.slice(ENTRY_TOOL_ENV.length + 1)
    }
    if (home === null || !isAbsolute(home)) continue
    const known = (ENTRY_TOOLS as readonly string[]).includes(tool ?? 'claude-code')
    return { pid, home, tool: known ? ((tool ?? 'claude-code') as EntryTool) : null }
  }
  return null
}

function claudeFileTime(state: Record<string, unknown>): number {
  const times = [state.updatedAt, state.statusUpdatedAt, state.startedAt].filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  )
  return times.length ? Math.max(...times) : 0
}

/** The live Claude session file in an entry home. Its pid is the container's,
 * so it cannot be matched against the pane's processes: one agent runs per
 * home, so it is the interactive file updated last (a stale file left by an
 * earlier process is older). A session parked into a background job is
 * represented by that job's file, as in `claudeSessions`. */
export function entryClaudeSession(fs: ProcFs, home: string): ClaudeSession | null {
  const dir = join(home, '.claude', 'sessions')
  let names: string[] = []
  try {
    names = fs.readdir(dir)
  } catch {
    return null
  }
  const sessions: ClaudeSession[] = []
  for (const name of names) {
    const pid = /^([1-9][0-9]*)\.json$/.exec(name)?.[1]
    if (!pid) continue
    const session = readClaudeSession(fs, home, Number(pid))
    if (session) sessions.push(session)
  }
  let best: ClaudeSession | null = null
  for (const session of sessions) {
    if (session.state.kind === 'bg') continue
    if (!best || claudeFileTime(session.state) > claudeFileTime(best.state)) best = session
  }
  const parked = best?.state.parkedJobId
  if (best && typeof parked === 'string' && parked)
    return sessions.find((job) => job.state.jobId === parked && job.state.kind === 'bg') ?? best
  return best
}

/** At most this many rollouts are looked at per read of an entry home. */
const ENTRY_ROLLOUT_LIMIT = 2000
/** At most this many of the newest are opened to find the user thread. */
const ENTRY_ROLLOUT_OPEN = 32

/** The user thread's rollout in an entry home's `.codex/sessions`
 * (YYYY/MM/DD/rollout-*.jsonl). Codex in the container holds it open, but
 * its fds are not this host's to read, and one agent runs per home: so it is
 * the user thread's rollout written last (a subagent's is skipped; a resumed
 * thread appends to its own older file, which is then the newest). */
export function entryCodexRollout(
  fs: ProcFs,
  home: string,
): { path: string; threadId: string | null } | null {
  const root = join(home, '.codex', 'sessions')
  const files: string[] = []
  const walk = (dir: string, depth: number) => {
    let names: string[]
    try {
      names = fs.readdir(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (files.length >= ENTRY_ROLLOUT_LIMIT) return
      if (name.startsWith('.') || name.includes('/')) continue
      const path = `${dir}/${name}`
      if (depth === 3) {
        if (/^rollout-[^/]*\.jsonl$/.test(name)) files.push(path)
      } else if (/^[0-9]{2,4}$/.test(name)) walk(path, depth + 1)
    }
  }
  walk(root, 0)
  const when = new Map(files.map((path) => [path, fs.mtimeMs?.(path) ?? null]))
  // Newest first by write time; by name (creation time) without it.
  files.sort((a, b) => (when.get(b) ?? 0) - (when.get(a) ?? 0) || (a < b ? 1 : a > b ? -1 : 0))
  for (const path of files.slice(0, ENTRY_ROLLOUT_OPEN)) {
    if (fs.mtimeMs && when.get(path) === null) continue
    const user = codexUserThread(fs, path)
    if (user) return { path, threadId: user.threadId }
  }
  return null
}

/** An entry session's agent: its state from the entry home, standing on the
 * entry process (the pane's agent exits when it does). Never the host home. */
export function observeEntryAgent(fs: ProcFs, entry: EntryProcess): AgentObservation | null {
  if (entry.tool === 'codex') {
    const threadId = entryCodexRollout(fs, entry.home)?.threadId
    return threadId ? { pid: entry.pid, resumeId: threadId, idle: null, blocked: false } : null
  }
  if (entry.tool !== 'claude-code') return null
  const session = entryClaudeSession(fs, entry.home)
  const state = session?.state
  if (!state || typeof state.sessionId !== 'string' || !UUID_RE.test(state.sessionId)) return null
  return {
    pid: entry.pid,
    resumeId: state.sessionId,
    idle: state.status !== 'busy',
    blocked: state.status === 'waiting',
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

export function observeAgent(fs: ProcFs, home: string, panePid: number): AgentObservation | null {
  const pids = processTree(fs, panePid)
  // A session that runs through an entry is read only from the entry's home.
  const entry = findEntryProcess(fs, pids)
  if (entry) return observeEntryAgent(fs, entry)
  return observeClaude(fs, home, pids) ?? observeCodex(fs, pids) ?? observeChosenSession(fs, pids)
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
  if (snapshot?.v !== 1 || !Array.isArray(snapshot.sessions)) return []
  return snapshot.sessions.filter((session) => statusOf(session.id) === 'pending')
}
