// Agent state: whether the agent in a session is working, idle, or blocked on
// the user (a permission prompt or a question). Tether keeps exactly one state
// per session, in memory; it is rebuilt from the agents' own files after a
// restart. Two inputs feed it (docs/agent-state.md):
//
// - a poll of each agent's own state: Claude Code's ~/.claude/sessions/<pid>.json
//   (`status` busy | waiting | idle, plus `waitingFor`), the tail of the
//   Codex thread's rollout file (task_started / task_complete, an unanswered
//   request_user_input call), the tail of Pi's session file (the last
//   message: a finished assistant reply is idle) and agy's conversation
//   database (its steps' status and executor runs);
// - hook reports (`POST /v1/sessions/:id/agent-event`) from Claude Code's
//   Notification and UserPromptSubmit hooks, which arrive before the next poll.
//
// A hook's `blocked` holds until the user answers: a UserPromptSubmit report,
// or a poll whose status changed after the hook fired and is no longer waiting.

import type { AgentSignal, AgentState } from './agent-signal'
import { findEntryProcess } from './continuity'
import type {
  AgentProbe,
  AgentRunLookup,
  StateContext,
  TuiAdapter,
} from './lifecycle/tui/adapters/contract'
import { ADAPTERS, adapterOf } from './lifecycle/tui/registry'
import type { ModelSource } from './model-record'
import { entryReaders, type FileTail, type ProcFs, processTree } from './proc-fs'

export type { AgentSignal, AgentState } from './agent-signal'
export { AGENT_STATES } from './agent-signal'

export interface AgentStateRecord {
  state: AgentState
  /** What said so: `claude-status`, `claude-hook`, `codex-rollout`, `codex-hook`,
   * `pi-session`, `agy-conversation`, or `none`. */
  stateSource: string
  /** When the state last changed (ms since the epoch). */
  stateAt: number
  /** Why blocked (`permission prompt`, `input needed`, …); null otherwise. */
  stateDetail: string | null
  /** The state before this one, so a client can tell a finished turn
   * (working → idle) from an idle agent Tether only just found. */
  statePrevious: AgentState
  /** The agent's own time of its latest state (Claude's `statusUpdatedAt`,
   * the Codex turn line, the Pi message), else when Tether saw the change; 0
   * while unknown. It only moves forward. A later time while idle means a turn
   * ended, even one too short for the poll to see working (lane reports). */
  stateAgentAt: number
}

// --- hook reports -------------------------------------------------------------

export interface HookReport {
  /** The hook event (`Notification`, `UserPromptSubmit`, `PermissionRequest`, `Stop`). */
  event: string
  /** Claude's `notification_type` for a Notification. */
  notificationType?: string | null
  /** The tool's `harness` name (`claude`, `codex`). */
  agent: string
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
        statePrevious: 'unknown',
        stateAgentAt: 0,
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
    at: number | null = null,
  ): void {
    const before = entry.record
    const now = this.now()
    if (before.state === state && before.stateDetail === detail) {
      // Same state; keep its time, but name the latest source.
      const agentAt =
        state !== 'unknown' && at !== null && at > before.stateAgentAt ? at : before.stateAgentAt
      entry.record = { ...before, stateSource: source, stateAgentAt: agentAt }
      // Idle again, later by the agent's own clock: a turn ended between polls.
      if (state === 'idle' && agentAt !== before.stateAgentAt) this.onChange(id, entry.record)
      return
    }
    entry.record = {
      state,
      stateSource: source,
      stateAt: now,
      stateDetail: detail,
      statePrevious: before.state,
      // Without the agent's own time, a first sighting (Tether just started)
      // keeps the old time: it may be a turn that ended long ago.
      stateAgentAt:
        state === 'unknown' || (at === null && before.state === 'unknown')
          ? before.stateAgentAt
          : Math.max(at ?? now, before.stateAgentAt),
    }
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
    this.set(id, entry, signal.state, signal.source, signal.detail, signal.at)
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

/** What the poller found in one session's pane: the adapter that read it and its probe. */
interface Found {
  adapter: TuiAdapter
  probe: AgentProbe
}

interface Watched {
  generation: string
  panePid: number | null
  found: Found | null
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
      /** Test seams for an adapter's readers, keyed by adapter id. */
      seams?: Record<string, unknown>
      /** Each poll's agent record, for the model watch (model-switch.ts). */
      models?: (id: string, source: ModelSource) => void
      /** Runs pushed to the session history (the Aico agent's state). */
      runs?: AgentRunLookup
      /** Persist the conversation's workload owner before the workload can end. */
      conversation?: (session: string, tool: string, nativeId: string) => void
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

  private context(pids: number[]): StateContext {
    return {
      fs: this.fs,
      home: this.home,
      pids,
      ...(this.options.tail ? { tail: this.options.tail } : {}),
      ...(this.options.seams ? { seams: this.options.seams } : {}),
      ...(this.options.runs ? { runs: this.options.runs } : {}),
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
          found: null,
          searchedAt: Number.NEGATIVE_INFINITY,
        }
        this.watched.set(session.id, watched)
      }
      if (watched.panePid === null) {
        this.tracker.observe(session.id, null)
        continue
      }
      const lost = watched.found !== null && !this.alive(watched.found.probe.pid)
      if (lost || now - watched.searchedAt >= SEARCH_EVERY_MS) {
        watched.found = this.search(watched.panePid, watched.found)
        watched.searchedAt = now
      } else if (watched.found?.probe.follow) {
        watched.found.probe = watched.found.probe.follow(this.context([watched.found.probe.pid]))
      }
      const signal = watched.found?.probe.poll() ?? null
      if (signal?.agentSessionId && watched.found)
        this.options.conversation?.(
          session.id,
          watched.found.adapter.harness,
          signal.agentSessionId,
        )
      this.tracker.observe(session.id, signal)
      if (this.options.models) {
        const source = watched.found?.probe.models?.(signal)
        if (source) this.options.models(session.id, source)
      }
    }
    for (const id of [...this.watched.keys()]) {
      if (!live.has(id)) {
        this.watched.delete(id)
        this.tracker.observe(id, null)
      }
    }
    for (const id of this.tracker.ids()) if (!live.has(id)) this.tracker.forget(id)
  }

  private search(panePid: number, previous: Found | null): Found | null {
    const pids = processTree(this.fs, panePid)
    const ctx = this.context(pids)
    const kept = (adapter: TuiAdapter): AgentProbe | null =>
      previous?.adapter === adapter ? previous.probe : null
    // An entry session: its agent's files in the entry home (never the host
    // home), alive with the entry process. Every read there stays inside the
    // home (entryReaders).
    const entry = findEntryProcess(this.fs, pids)
    if (entry) {
      const adapter = adapterOf(entry.tool)
      const readers = entry.tool ? entryReaders(this.fs, entry.home) : null
      if (!adapter || !readers) return null
      const probe = adapter.state.findInEntry?.({ ...ctx, readers, entry }, kept(adapter)) ?? null
      return probe ? { adapter, probe } : null
    }
    for (const adapter of ADAPTERS) {
      const probe = adapter.state.find(ctx, kept(adapter))
      if (probe) return { adapter, probe }
    }
    return null
  }
}
