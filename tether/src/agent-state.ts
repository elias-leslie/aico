// Agent state: whether the agent in a session is working, idle, or blocked on
// the user (a permission prompt or a question). Tether keeps exactly one state
// per session, in memory; it is rebuilt from the agents' own files after a
// restart. Two inputs feed it (docs/agent-state.md):
//
// - a poll of each agent's own state: Claude Code's ~/.claude/sessions/<pid>.json
//   (`status` busy | waiting | idle, plus `waitingFor`) and the tail of the
//   Codex thread's rollout file (task_started / task_complete, an unanswered
//   request_user_input call);
// - hook reports (`POST /v1/sessions/:id/agent-event`) from Claude Code's
//   Notification and UserPromptSubmit hooks, which arrive before the next poll.
//
// A hook's `blocked` holds until the user answers: a UserPromptSubmit report,
// or a poll whose status changed after the hook fired and is no longer waiting.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { type ProcFs, processTree } from './continuity'

export const AGENT_STATES = ['working', 'idle', 'blocked', 'unknown'] as const
export type AgentState = (typeof AGENT_STATES)[number]

export interface AgentStateRecord {
  state: AgentState
  /** What said so: `claude-status`, `claude-hook`, `codex-rollout`, `codex-hook`, or `none`. */
  stateSource: string
  /** When the state last changed (ms since the epoch). */
  stateAt: number
  /** Why blocked (`permission prompt`, `input needed`, …); null otherwise. */
  stateDetail: string | null
}

/** One observation of an agent's own state. `at` is when the agent last
 * changed it, when the agent says; hook holds compare against it. */
export interface AgentSignal {
  state: Exclude<AgentState, 'unknown'>
  source: string
  detail: string | null
  at: number | null
  /** The agent's native conversation ID, to match hook reports. */
  agentSessionId: string | null
}

const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/

// --- Claude Code ------------------------------------------------------------

export interface ClaudeProcess {
  pid: number
  file: string
}

/** The Claude Code process in a pane's process tree, by its session file. */
export function findClaude(fs: ProcFs, home: string, pids: number[]): ClaudeProcess | null {
  for (const pid of pids) {
    const file = join(home, '.claude', 'sessions', `${pid}.json`)
    try {
      const state = JSON.parse(fs.readFile(file)) as Record<string, unknown>
      if (state.pid === pid) return { pid, file }
    } catch {
      // not a Claude process
    }
  }
  return null
}

/** Claude's status: busy → working, waiting → blocked, idle or shell → idle. */
export function claudeSignal(text: string): AgentSignal | null {
  let state: Record<string, unknown>
  try {
    state = JSON.parse(text)
  } catch {
    return null
  }
  const at = typeof state.statusUpdatedAt === 'number' ? state.statusUpdatedAt : null
  const agentSessionId =
    typeof state.sessionId === 'string' && UUID_RE.test(state.sessionId) ? state.sessionId : null
  const base = { source: 'claude-status', at, agentSessionId }
  switch (state.status) {
    case 'busy':
      return { ...base, state: 'working', detail: null }
    case 'waiting':
      return {
        ...base,
        state: 'blocked',
        detail: typeof state.waitingFor === 'string' ? state.waitingFor : 'waiting',
      }
    case 'idle':
    case 'shell':
      return { ...base, state: 'idle', detail: null }
    default:
      return null
  }
}

// --- Codex ------------------------------------------------------------------

const ROLLOUT_RE = /\/\.codex\/sessions\/.*\/rollout-[^/]*\.jsonl$/
/** Tools whose call waits for the user's answer. */
const CODEX_QUESTION_TOOLS = new Set(['request_user_input'])
/** Approval prompts, if a Codex build ever records them in the rollout. */
const CODEX_APPROVAL_EVENTS = new Set([
  'exec_approval_request',
  'apply_patch_approval_request',
  'request_permissions',
])
/** First read of an existing rollout: enough tail for the current turn. */
const ROLLOUT_TAIL_BYTES = 512 * 1024
const ROLLOUT_MAX_STEP_BYTES = 4 * 1024 * 1024

/** The user thread's rollout (not a subagent's) a Codex process holds open. */
export function findCodexRollout(
  fs: ProcFs,
  pids: number[],
): { pid: number; path: string; threadId: string | null } | null {
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
      try {
        const first = fs.readHead(target, 1024 * 1024).split('\n', 1)[0]
        const meta = JSON.parse(first) as { type?: string; payload?: Record<string, unknown> }
        const payload = meta.payload ?? {}
        if (meta.type !== 'session_meta' || payload.parent_thread_id) continue
        if (payload.thread_source !== undefined && payload.thread_source !== 'user') continue
        const threadId =
          typeof payload.id === 'string' && UUID_RE.test(payload.id) ? payload.id : null
        return { pid, path: target, threadId }
      } catch {
        // unreadable or partial rollout
      }
    }
  }
  return null
}

/** Folds rollout lines into the thread's turn state. */
export class CodexTurn {
  private active = false
  private approval = false
  private readonly questions = new Set<string>()
  /** Timestamp of the last line that changed the state. */
  at: number | null = null

  constructor(readonly threadId: string | null = null) {}

  apply(line: string): void {
    let item: { timestamp?: string; type?: string; payload?: Record<string, unknown> }
    try {
      item = JSON.parse(line)
    } catch {
      return
    }
    const payload = item.payload ?? {}
    const kind = payload.type
    const at = item.timestamp ? Date.parse(item.timestamp) : Number.NaN
    const stamp = () => {
      if (Number.isFinite(at)) this.at = at
    }
    if (item.type === 'event_msg') {
      if (kind === 'task_started') {
        this.active = true
        this.approval = false
        this.questions.clear()
        stamp()
      } else if (kind === 'task_complete' || kind === 'turn_aborted') {
        this.active = false
        this.approval = false
        this.questions.clear()
        stamp()
      } else if (typeof kind === 'string' && CODEX_APPROVAL_EVENTS.has(kind)) {
        this.approval = true
        stamp()
      } else if (this.approval && kind !== 'token_count') {
        // Anything the turn does next means the approval was answered.
        this.approval = false
        stamp()
      }
      return
    }
    if (item.type !== 'response_item') return
    const callId = typeof payload.call_id === 'string' ? payload.call_id : null
    if (
      (kind === 'function_call' || kind === 'custom_tool_call') &&
      callId &&
      typeof payload.name === 'string' &&
      CODEX_QUESTION_TOOLS.has(payload.name)
    ) {
      this.questions.add(callId)
      stamp()
    } else if (
      (kind === 'function_call_output' || kind === 'custom_tool_call_output') &&
      callId &&
      this.questions.delete(callId)
    ) {
      stamp()
    } else if (this.approval) {
      this.approval = false
      stamp()
    }
  }

  signal(): AgentSignal {
    const base = { source: 'codex-rollout', at: this.at, agentSessionId: this.threadId }
    if (this.active && this.questions.size > 0)
      return { ...base, state: 'blocked', detail: 'input needed' }
    if (this.active && this.approval)
      return { ...base, state: 'blocked', detail: 'permission prompt' }
    return { ...base, state: this.active ? 'working' : 'idle', detail: null }
  }
}

export interface FileTail {
  /** Bytes appended since `offset` (at most `max`, ending at a newline), and
   * the new offset. A shrunk file restarts from 0. */
  read(path: string, offset: number, max: number): { text: string; offset: number; size: number }
}

export const nodeFileTail: FileTail = {
  read(path, offset, max) {
    const fd = openSync(path, 'r')
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
}

/** Incremental reader of one rollout file. */
export class CodexRollout {
  private offset = 0
  private readonly turn: CodexTurn
  private started = false

  constructor(
    readonly path: string,
    threadId: string | null,
    private readonly tail: FileTail = nodeFileTail,
  ) {
    this.turn = new CodexTurn(threadId)
  }

  poll(): AgentSignal | null {
    let chunk: { text: string; offset: number }
    try {
      if (!this.started) {
        const probe = this.tail.read(this.path, 0, ROLLOUT_TAIL_BYTES)
        const lines = probe.text.split('\n')
        // A tail that starts mid-file begins with a partial line.
        if (probe.offset - Buffer.byteLength(probe.text) > 0) lines.shift()
        for (const line of lines) if (line) this.turn.apply(line)
        this.offset = probe.offset
        this.started = true
        return this.turn.signal()
      }
      chunk = this.tail.read(this.path, this.offset, ROLLOUT_MAX_STEP_BYTES)
    } catch {
      return null
    }
    this.offset = chunk.offset
    for (const line of chunk.text.split('\n')) if (line) this.turn.apply(line)
    return this.turn.signal()
  }
}

// --- hook reports -------------------------------------------------------------

export interface HookReport {
  /** The hook event (`Notification`, `UserPromptSubmit`, `PermissionRequest`, `Stop`). */
  event: string
  /** Claude's `notification_type` for a Notification. */
  notificationType?: string | null
  agent: 'claude' | 'codex'
  agentSessionId?: string | null
}

/** Claude Notification types that mean the agent is waiting on the user.
 * `idle_prompt` (sent after a finished turn sits idle) is not: a finished
 * turn is idle, and Aico tells the owner about it separately. */
export const BLOCKING_NOTIFICATIONS: Record<string, string> = {
  permission_prompt: 'permission prompt',
  elicitation_dialog: 'input needed',
}

/** The state a hook report sets, or null when it says nothing about state. */
export function hookState(
  report: HookReport,
): { state: Exclude<AgentState, 'unknown'>; detail: string | null } | null {
  switch (report.event) {
    case 'Notification': {
      const detail = BLOCKING_NOTIFICATIONS[report.notificationType ?? '']
      return detail ? { state: 'blocked', detail } : null
    }
    case 'PermissionRequest':
      return { state: 'blocked', detail: 'permission prompt' }
    case 'UserPromptSubmit':
      return { state: 'working', detail: null }
    case 'Stop':
      return { state: 'idle', detail: null }
    default:
      return null
  }
}

// --- the tracker ----------------------------------------------------------------

interface Entry {
  record: AgentStateRecord
  /** A hook's blocked state, held until the agent's own status moves on. */
  hold: { at: number; detail: string | null; source: string } | null
  agentSessionId: string | null
}

export class AgentStateTracker {
  private readonly entries = new Map<string, Entry>()

  constructor(
    private readonly onChange: (id: string, record: AgentStateRecord) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  get(id: string): AgentStateRecord {
    return (
      this.entries.get(id)?.record ?? {
        state: 'unknown',
        stateSource: 'none',
        stateAt: 0,
        stateDetail: null,
      }
    )
  }

  private entry(id: string): Entry {
    let entry = this.entries.get(id)
    if (!entry) {
      entry = { record: this.get(id), hold: null, agentSessionId: null }
      this.entries.set(id, entry)
    }
    return entry
  }

  private set(
    id: string,
    entry: Entry,
    state: AgentState,
    source: string,
    detail: string | null,
  ): void {
    const before = entry.record
    if (before.state === state && before.stateDetail === detail) {
      // Same state; keep its time, but name the latest source.
      entry.record = { ...before, stateSource: source }
      return
    }
    entry.record = { state, stateSource: source, stateAt: this.now(), stateDetail: detail }
    this.onChange(id, entry.record)
  }

  /** A poll result; null means no agent was found (the state is unknown). */
  observe(id: string, signal: AgentSignal | null): void {
    const entry = this.entry(id)
    if (!signal) {
      entry.hold = null
      entry.agentSessionId = null
      this.set(id, entry, 'unknown', 'none', null)
      return
    }
    if (signal.agentSessionId && signal.agentSessionId !== entry.agentSessionId) {
      // A new conversation: an earlier hook hold belonged to the old one.
      if (entry.agentSessionId) entry.hold = null
      entry.agentSessionId = signal.agentSessionId
    }
    if (entry.hold) {
      const movedOn = signal.at !== null && signal.at > entry.hold.at && signal.state !== 'blocked'
      if (!movedOn) {
        this.set(
          id,
          entry,
          'blocked',
          entry.hold.source,
          signal.state === 'blocked' ? (signal.detail ?? entry.hold.detail) : entry.hold.detail,
        )
        return
      }
      entry.hold = null
    }
    this.set(id, entry, signal.state, signal.source, signal.detail)
  }

  /** A hook report. Returns false when it was ignored. */
  report(id: string, report: HookReport): boolean {
    const next = hookState(report)
    if (!next) return false
    const entry = this.entry(id)
    // A nested agent (one the session's agent started) shares the pane's
    // environment; its reports are not the session's.
    if (
      report.agentSessionId &&
      entry.agentSessionId &&
      report.agentSessionId !== entry.agentSessionId
    )
      return false
    const source = `${report.agent}-hook`
    if (next.state === 'blocked') entry.hold = { at: this.now(), detail: next.detail, source }
    else entry.hold = null
    this.set(id, entry, next.state, source, next.detail)
    return true
  }

  forget(id: string): void {
    this.entries.delete(id)
  }

  ids(): string[] {
    return [...this.entries.keys()]
  }
}

// --- the poller ------------------------------------------------------------------

/** What the poller found in one session's pane. */
type Found =
  | { kind: 'claude'; pid: number; file: string }
  | { kind: 'codex'; pid: number; rollout: CodexRollout }
  | { kind: 'none' }

interface Watched {
  generation: string
  panePid: number | null
  found: Found
  /** When the process tree was last searched. */
  searchedAt: number
}

export interface AgentStateSource {
  /** Running sessions: id, generation, and a lazy pane PID lookup (it asks tmux). */
  sessions(): { id: string; generation: string; panePid: () => Promise<number | null> }[]
}

const SEARCH_EVERY_MS = 15_000

/** Polls each running session's agent and feeds the tracker. */
export class AgentStatePoller {
  private readonly watched = new Map<string, Watched>()
  private timer: NodeJS.Timeout | null = null
  private polling: Promise<void> | null = null

  constructor(
    private readonly tracker: AgentStateTracker,
    private readonly source: AgentStateSource,
    private readonly fs: ProcFs,
    private readonly home: string,
    private readonly options: {
      now?: () => number
      tail?: FileTail
      alive?: (pid: number) => boolean
    } = {},
  ) {}

  start(intervalMs = 2_000): void {
    this.timer = setInterval(() => void this.poll(), intervalMs)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  poll(): Promise<void> {
    if (!this.polling) {
      this.polling = this.pollOnce()
        .catch((error) => console.error('[tether:agent-state] poll failed:', error))
        .finally(() => {
          this.polling = null
        })
    }
    return this.polling
  }

  private alive(pid: number): boolean {
    if (this.options.alive) return this.options.alive(pid)
    try {
      this.fs.readFile(`/proc/${pid}/stat`)
      return true
    } catch {
      return false
    }
  }

  private async pollOnce(): Promise<void> {
    const now = (this.options.now ?? Date.now)()
    const live = new Set<string>()
    for (const session of this.source.sessions()) {
      live.add(session.id)
      let watched = this.watched.get(session.id)
      if (!watched || watched.generation !== session.generation) {
        watched = {
          generation: session.generation,
          panePid: await session.panePid().catch(() => null),
          found: { kind: 'none' },
          searchedAt: Number.NEGATIVE_INFINITY,
        }
        this.watched.set(session.id, watched)
      }
      if (watched.panePid === null) {
        this.tracker.observe(session.id, null)
        continue
      }
      const lost = watched.found.kind !== 'none' && !this.alive(watched.found.pid)
      if (lost || now - watched.searchedAt >= SEARCH_EVERY_MS) {
        watched.found = this.search(watched.panePid, watched.found)
        watched.searchedAt = now
      }
      this.tracker.observe(session.id, this.read(watched.found))
    }
    for (const id of [...this.watched.keys()]) {
      if (!live.has(id)) {
        this.watched.delete(id)
        this.tracker.observe(id, null)
      }
    }
    for (const id of this.tracker.ids()) if (!live.has(id)) this.tracker.forget(id)
  }

  private search(panePid: number, previous: Found): Found {
    const pids = processTree(this.fs, panePid)
    const claude = findClaude(this.fs, this.home, pids)
    if (claude) return { kind: 'claude', ...claude }
    const codex = findCodexRollout(this.fs, pids)
    if (codex) {
      // Keep the reader (and its offset) while the thread is the same.
      if (previous.kind === 'codex' && previous.rollout.path === codex.path)
        return { kind: 'codex', pid: codex.pid, rollout: previous.rollout }
      return {
        kind: 'codex',
        pid: codex.pid,
        rollout: new CodexRollout(codex.path, codex.threadId, this.options.tail),
      }
    }
    return { kind: 'none' }
  }

  private read(found: Found): AgentSignal | null {
    if (found.kind === 'claude') {
      try {
        return claudeSignal(this.fs.readFile(found.file))
      } catch {
        return null
      }
    }
    if (found.kind === 'codex') return found.rollout.poll()
    return null
  }
}
