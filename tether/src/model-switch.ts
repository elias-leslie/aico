// Model switches (docs/api-v1.md "Model switches"). A session's agent can end
// up on a model other than the one it started on, or stop on a refused
// request: Claude Code retries a refused request on a fallback model
// (`model_refusal_fallback`) and stays there, or, with the switch turned off,
// pauses the turn; a provider serves another model than the one asked for
// (Pi's `responseModel`); someone picks another model in the window
// (`/model`). Claude Code's own opt-outs have not always held, and a fallback
// model must never do the work, so Tether follows each agent's own record:
//
// - Claude Code: its transcript (~/.claude/projects/<dir>/<sessionId>.jsonl):
//   the `model_refusal_fallback` and `model_refusal_no_fallback` rows, each
//   main-thread assistant row's `message.model` and `stop_reason: refusal`,
//   the `/model` command row and the owner's prompts (the rewind target);
// - Codex: the rollout's `turn_context.model` (what the thread asks for) and
//   an `event_msg` `model_reroute` (Codex 0.164 has the event but does not
//   write it to the rollout yet);
// - Pi: each assistant message's `model` (asked for) and `responseModel`
//   (served).
//
// The baseline is the session's first model; a switch is a model that is not
// the baseline (the rule of Agent Hub's is_model_switch: provider prefix, case
// and dated snapshot suffix are the same model). A switch nobody asked for (a
// refusal fallback, a substitution) stops the agent's turn at once (Escape,
// as the owner would) and again whenever the fallback model answers while it
// stands; a model picked in the window is only reported. A refusal that ended
// the turn with no switch is `paused`. The descriptor's `modelSwitch` shows
// the latest until the session is back on its baseline and answering; the
// lane line and the owner notice read it there. Models listed for the tool in
// ~/.config/tether/model-alternates.json are no switch unless a refusal put
// them there.

import { join } from 'node:path'
import type { FileTail } from './agent-state'
import type { ProcFs } from './continuity'

export const SWITCH_KINDS = ['refusal', 'substituted', 'changed', 'paused'] as const
export type SwitchKind = (typeof SWITCH_KINDS)[number]

/** The `modelSwitch` a descriptor carries. Typed values only: never refusal
 * text or request content. */
export interface ModelSwitch {
  /** Unique within the session; a new key is a new switch. */
  key: string
  kind: SwitchKind
  /** The model before; for `paused`, the model that was refused. */
  from: string
  /** The model now (for `paused`, the same as `from`). */
  to: string
  /** The refusal's category (`cyber`), else null. */
  category: string | null
  /** The agent's own time of the switch (ms). */
  at: number
  /** Escape was sent to stop a turn on the fallback model. */
  stopped: boolean
  /** The project's HEAD (short) once looked at; null without git or not yet. */
  commit: string | null
  /** A commit or a changed file after the switch; null when unknown. */
  worktreeChanged: boolean | null
  /** The worktree has been looked at: the line and the notice go out now. */
  checked: boolean
  /** Claude: the uuid of the owner's prompt whose turn was refused (the
   * rewind target); null when unknown or not Claude. */
  rewindTo: string | null
}

// --- the rule ----------------------------------------------------------------------

const SNAPSHOT_SUFFIX = /-(?:\d{4}-\d{2}-\d{2}|\d{8})$/

/** A model id as compared: no provider prefix, case, `[1m]`-style tag or
 * dated snapshot suffix. */
export function bareModel(model: string): string {
  const last = model.trim().toLowerCase().split('/').pop() ?? ''
  return last.replace(/\[[^\]]*\]$/, '').replace(SNAPSHOT_SUFFIX, '')
}

/** True when `served` is a different model than `requested` (Agent Hub's
 * `is_model_switch`). Unknown on either side is no switch. */
export function isModelSwitch(
  requested: string | null | undefined,
  served: string | null | undefined,
): boolean {
  if (!requested || !served) return false
  return bareModel(requested) !== bareModel(served)
}

// --- the agents' records -------------------------------------------------------------

export type ModelEvent =
  /** The model that answered. */
  | { type: 'served'; model: string; at: number | null }
  /** The model the tool itself asks for (Codex turn context, Pi message). */
  | { type: 'requested'; model: string; at: number | null }
  /** Someone ran the tool's model picker (Claude `/model`). */
  | { type: 'chosen'; at: number | null }
  /** An owner's prompt (Claude), the start of a turn a rewind can go back to. */
  | { type: 'prompt'; uuid: string; at: number | null }
  /** A reply was refused (Claude `stop_reason: refusal`); the turn may still
   * go on (a same-model retry, a fallback). */
  | {
      type: 'refused'
      model: string | null
      category: string | null
      key: string
      at: number | null
    }
  /** The tool switched models because a request was refused. */
  | {
      type: 'refusal'
      from: string | null
      to: string
      category: string | null
      key: string
      at: number | null
    }
  /** A refusal ended the turn without a switch. */
  | {
      type: 'noFallback'
      model: string | null
      category: string | null
      key: string
      at: number | null
    }

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/
const CATEGORY = /^[a-z][a-z0-9_]{0,31}$/
const KEY = /^[A-Za-z0-9_.:@-]{1,128}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function model(value: unknown): string | null {
  return typeof value === 'string' && MODEL_ID.test(value.trim()) ? value.trim() : null
}

function time(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function keyOf(...values: unknown[]): string | null {
  const found = values.find(
    (value): value is string => typeof value === 'string' && KEY.test(value),
  )
  return found ?? null
}

/** A refusal category as a short lowercase word (`cyber`), else null. */
export function refusalCategory(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const word = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
  // Codex reroute reasons (Agent Hub refusal_codes.py).
  if (word.replace(/_/g, '') === 'highriskcyberactivity') return 'cyber'
  return CATEGORY.test(word) ? word : null
}

function parse(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line)
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const CLAUDE_HINT = /"type":\s*"(?:assistant|user)"|model_refusal|command-name>\/model</

/** An owner's prompt: a user row with text, not a tool result, meta row or
 * compact summary. */
function isPrompt(row: Record<string, unknown>): boolean {
  if (
    row.isMeta === true ||
    row.isCompactSummary === true ||
    row.isVisibleInTranscriptOnly === true
  )
    return false
  const content = (row.message as { content?: unknown } | undefined)?.content
  if (typeof content === 'string') return !content.startsWith('<') && content.trim() !== ''
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every(
      (part) =>
        (part as { type?: unknown })?.type === 'text' ||
        (part as { type?: unknown })?.type === 'image',
    )
  )
}

/** One Claude Code transcript row. Sidechain rows (subagents run their own
 * models) say nothing about the session; a `<synthetic>` row (an error Claude
 * Code wrote itself) names no model. */
export function claudeModelEvents(line: string): ModelEvent[] {
  if (!CLAUDE_HINT.test(line)) return []
  const row = parse(line)
  if (!row || row.isSidechain === true) return []
  const at = time(row.timestamp)
  if (row.type === 'system' && row.subtype === 'model_refusal_fallback') {
    const to = model(row.fallbackModel)
    if (!to) return []
    return [
      {
        type: 'refusal',
        from: model(row.originalModel),
        to,
        category: refusalCategory(row.apiRefusalCategory),
        key: keyOf(row.requestId, row.uuid, row.timestamp) ?? `at-${at ?? 0}`,
        at,
      },
    ]
  }
  if (row.type === 'system' && row.subtype === 'model_refusal_no_fallback')
    return [
      {
        type: 'noFallback',
        model: model(row.originalModel),
        category: refusalCategory(row.apiRefusalCategory),
        key: keyOf(row.requestId, row.uuid, row.timestamp) ?? `at-${at ?? 0}`,
        at,
      },
    ]
  if (
    row.type === 'system' &&
    row.subtype === 'local_command' &&
    typeof row.content === 'string' &&
    row.content.includes('<command-name>/model</command-name>')
  )
    return [{ type: 'chosen', at }]
  if (row.type === 'user') {
    return typeof row.uuid === 'string' && UUID.test(row.uuid) && isPrompt(row)
      ? [{ type: 'prompt', uuid: row.uuid, at }]
      : []
  }
  if (row.type === 'assistant') {
    const message = row.message as Record<string, unknown> | undefined
    const served = model(message?.model)
    if (message?.stop_reason === 'refusal') {
      const details = message.stop_details as { category?: unknown } | undefined
      return [
        {
          type: 'refused',
          model: served,
          category: refusalCategory(details?.category),
          key: keyOf(row.requestId, row.uuid, message.id, row.timestamp) ?? `at-${at ?? 0}`,
          at,
        },
      ]
    }
    return served ? [{ type: 'served', model: served, at }] : []
  }
  return []
}

/** One Codex rollout line. */
export function codexModelEvents(line: string): ModelEvent[] {
  if (!line.includes('"turn_context"') && !line.includes('model_reroute')) return []
  const row = parse(line)
  const payload = row?.payload as Record<string, unknown> | undefined
  if (!row || !payload) return []
  const at = time(row.timestamp)
  if (row.type === 'turn_context') {
    const asked = model(payload.model)
    return asked ? [{ type: 'requested', model: asked, at }] : []
  }
  if (row.type === 'event_msg' && payload.type === 'model_reroute') {
    const to = model(payload.to_model ?? payload.toModel)
    if (!to) return []
    return [
      {
        type: 'refusal',
        from: model(payload.from_model ?? payload.fromModel),
        to,
        category: refusalCategory(payload.reason),
        key: `reroute-${keyOf(payload.turn_id, payload.turnId) ?? at ?? 0}`,
        at,
      },
    ]
  }
  return []
}

/** One Pi session line: an assistant message names the model asked for
 * (`provider/model`) and, when the provider says, the one that answered. */
export function piModelEvents(line: string): ModelEvent[] {
  if (!line.includes('"assistant"')) return []
  const row = parse(line)
  const message = row?.message as Record<string, unknown> | undefined
  if (row?.type !== 'message' || message?.role !== 'assistant') return []
  const at = time(row.timestamp)
  const asked = model(message.model)
  if (!asked) return []
  const provider = typeof message.provider === 'string' ? message.provider : null
  const full = (id: string) => (provider && !id.includes('/') ? `${provider}/${id}` : id)
  const served = model(message.responseModel) ?? asked
  return [
    { type: 'requested', model: full(asked), at },
    { type: 'served', model: full(served), at },
  ]
}

export type ModelTool = 'claude' | 'codex' | 'pi'

const EVENTS: Record<ModelTool, (line: string) => ModelEvent[]> = {
  claude: claudeModelEvents,
  codex: codexModelEvents,
  pi: piModelEvents,
}

// --- the follower ------------------------------------------------------------------------

/** A refused reply whose turn has not gone on yet. */
export interface PendingRefusal {
  model: string | null
  category: string | null
  key: string
  at: number
  /** The prompt of the refused turn. */
  prompt: string | null
}

/** What a follower keeps across a Tether restart. */
export interface FollowerState {
  baseline: string | null
  current: string | null
  requested: string | null
  /** A model picker ran and no answer has come since. */
  chosen: boolean
  /** The latest owner's prompt (Claude). */
  prompt: string | null
  /** A refused reply not yet answered by a retry or a switch. */
  pending: PendingRefusal | null
  /** The turn stopped on a refusal and nothing has answered since. */
  paused: boolean
  /** Refusal keys already counted (the last few). */
  refusals: string[]
  /** Switches counted (keys). */
  seq: number
}

export const EMPTY_FOLLOWER: Readonly<FollowerState> = Object.freeze({
  baseline: null,
  current: null,
  requested: null,
  chosen: false,
  prompt: null,
  pending: null,
  paused: false,
  refusals: [],
  seq: 0,
})

export interface RawSwitch {
  key: string
  kind: SwitchKind
  from: string
  to: string
  category: string | null
  at: number
  rewindTo: string | null
}

/** Folds one session's model events into its switches. */
export class ModelFollower {
  readonly state: FollowerState

  constructor(
    state: FollowerState = EMPTY_FOLLOWER,
    /** Models that are no switch for this tool (refusals aside). */
    private readonly alternates: readonly string[] = [],
  ) {
    this.state = { ...EMPTY_FOLLOWER, ...state, refusals: [...(state.refusals ?? [])] }
  }

  /** On the baseline model (or an allowed alternate) and not paused. */
  settled(): boolean {
    const { baseline, current, paused } = this.state
    return !paused && (!isModelSwitch(baseline, current) || this.allowed(current))
  }

  private allowed(model: string | null): boolean {
    return model !== null && this.alternates.some((alt) => !isModelSwitch(alt, model))
  }

  private seen(key: string): boolean {
    if (this.state.refusals.includes(key)) return true
    this.state.refusals = [...this.state.refusals, key].slice(-16)
    return false
  }

  private next(
    kind: SwitchKind,
    from: string,
    to: string,
    category: string | null,
    at: number,
    rewindTo: string | null = null,
  ): RawSwitch {
    this.state.seq += 1
    return { key: `${this.state.seq}@${at}`, kind, from, to, category, at, rewindTo }
  }

  /** The session's first model, from the start of a record read late. */
  seed(model: string): void {
    this.state.baseline ??= model
    this.state.current ??= model
  }

  /** The pending refusal ended its turn with no switch. */
  pause(now: number): RawSwitch | null {
    const s = this.state
    const pending = s.pending
    if (!pending) return null
    s.pending = null
    s.paused = true
    const on = pending.model ?? s.current ?? s.baseline ?? 'its model'
    return this.next('paused', on, on, pending.category, pending.at ?? now, pending.prompt)
  }

  apply(event: ModelEvent, now: number): RawSwitch | null {
    const s = this.state
    const at = event.at ?? now
    switch (event.type) {
      case 'chosen':
        s.chosen = true
        return null
      case 'prompt':
        s.prompt = event.uuid
        return null
      case 'refused':
        s.baseline ??= event.model
        s.current ??= event.model
        if (!s.refusals.includes(event.key))
          s.pending = {
            model: event.model ?? s.current,
            category: event.category,
            key: event.key,
            at,
            prompt: s.prompt,
          }
        return null
      case 'noFallback': {
        const pending = s.pending
        s.pending = null
        if (this.seen(event.key) || (pending && s.refusals.includes(pending.key) && s.paused))
          return null
        if (pending) this.seen(pending.key)
        s.paused = true
        const on = event.model ?? pending?.model ?? s.current ?? s.baseline ?? 'its model'
        return this.next(
          'paused',
          on,
          on,
          event.category ?? pending?.category ?? null,
          at,
          pending?.prompt ?? s.prompt,
        )
      }
      case 'refusal': {
        const prompt = s.pending?.prompt ?? s.prompt
        if (s.pending) this.seen(s.pending.key)
        s.pending = null
        s.paused = false
        s.baseline ??= event.from ?? s.current ?? event.to
        if (this.seen(event.key)) return null
        const from = event.from ?? s.current ?? s.baseline
        s.current = event.to
        return this.next('refusal', from, event.to, event.category, at, prompt)
      }
      case 'requested': {
        if (s.baseline === null) {
          s.baseline = event.model
          s.current = event.model
          s.requested = event.model
          return null
        }
        const before = s.requested
        s.requested = event.model
        if (!isModelSwitch(before, event.model)) return null
        // The tool's own pick changed (its model picker).
        const from = s.current ?? s.baseline
        s.current = event.model
        if (!isModelSwitch(s.baseline, event.model) || !isModelSwitch(from, event.model))
          return null
        if (this.allowed(event.model)) return null
        return this.next('changed', from, event.model, null, at)
      }
      case 'served': {
        // An answer: the turn went on (a retry), or a new turn began.
        if (s.pending) this.seen(s.pending.key)
        s.pending = null
        s.paused = false
        if (s.baseline === null) {
          s.baseline = event.model
          s.current = event.model
          return null
        }
        const from = s.current ?? s.baseline
        if (!isModelSwitch(from, event.model)) {
          s.chosen = false
          return null
        }
        s.current = event.model
        const chosen =
          s.chosen || (s.requested !== null && !isModelSwitch(s.requested, event.model))
        s.chosen = false
        if (!isModelSwitch(s.baseline, event.model) || this.allowed(event.model)) return null
        return this.next(chosen ? 'changed' : 'substituted', from, event.model, null, at)
      }
    }
  }
}

// --- the watch -------------------------------------------------------------------------

/** Where one session's agent keeps its record. */
export type ModelSource =
  | { tool: 'claude'; sessionId: string; home: string; fs: ProcFs; tail?: FileTail }
  | { tool: 'codex'; path: string; tail?: FileTail }
  | { tool: 'pi'; path: string; tail?: FileTail }

/** One session's persisted follow (settings `model-watch`). */
export interface WatchEntry {
  path: string | null
  offset: number
  follower: FollowerState
  /** The switch the descriptor shows; null while settled. */
  current: ModelSwitch | null
}

export interface ModelWatchOperations {
  now(): number
  read(): Record<string, WatchEntry>
  write(entries: Record<string, WatchEntry>): void
  /** Allowed alternates for a tool. */
  alternates(tool: ModelTool): readonly string[]
  /** The agent's state: `working`, `idle`, `blocked` (with its detail) or `unknown`. */
  agent(id: string): { state: string; detail: string | null }
  /** Stop the agent's current turn (Escape into the pane). */
  interrupt(id: string): Promise<boolean>
  /** HEAD and whether anything changed after `since` in the session's project. */
  worktree(id: string, since: number): Promise<{ commit: string | null; changed: boolean | null }>
  /** The session's descriptor changed (publish `session.updated`). */
  changed(id: string): void
  log(message: string): void
}

/** Bytes read per poll: a record further behind is read from its last step
 * (the reader skips ahead). */
const STEP_BYTES = 4 * 1024 * 1024
/** The longest transcript a rewind reads for its prompt. */
const TRANSCRIPT_MAX_BYTES = 256 * 1024 * 1024
/** The start of a record read for its first model. */
const HEAD_BYTES = 2 * 1024 * 1024
/** Persist an advancing offset at most this often when nothing else changed. */
const SAVE_EVERY_MS = 60_000
const TRANSCRIPT_SEARCH_MS = 15_000
/** Two quick Escapes open Claude Code's rewind menu: at most one per this. */
const STOP_EVERY_MS = 5_000
/** The worktree is looked at once a stop has had its moment. */
const FACTS_DELAY_MS = 3_000
/** A refused reply with the agent out of its turn this long is a pause. */
const PAUSE_SETTLE_MS = 5_000
/** Switches nobody asked for: the turn on the new model is stopped. */
const STOPPING: ReadonlySet<SwitchKind> = new Set(['refusal', 'substituted'])
/** Blocked details that are the agent's own turn waiting on the user. */
const TURN_BLOCKS: ReadonlySet<string> = new Set(['permission prompt', 'input needed'])

interface Live {
  entry: WatchEntry
  follower: ModelFollower
  tool: ModelTool
  /** Claude: the conversation whose transcript is followed. */
  conversation: string | null
  searchedAt: number
  dirty: boolean
  savedAt: number
  /** An Escape is being sent. */
  busy: boolean
  stoppedAt: number
  /** When the pending refusal was first seen with the agent out of its turn. */
  quietSince: number | null
  /** The reader the record was last read with (contained for an entry home). */
  reader: FileTail | null
}

/** Follows each running session's model and reports its switches. */
export class ModelWatch {
  private readonly live = new Map<string, Live>()
  private readonly entries: Record<string, WatchEntry>

  constructor(private readonly ops: ModelWatchOperations) {
    let read: Record<string, WatchEntry> = {}
    try {
      read = ops.read()
    } catch (error) {
      ops.log(
        `reading saved follows failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    this.entries = read
  }

  /** The switch to show on a session's descriptor. */
  switchOf(id: string): ModelSwitch | null {
    return this.entries[id]?.current ?? null
  }

  private liveOf(id: string, tool: ModelTool, now: number): Live {
    let live = this.live.get(id)
    if (live && live.tool === tool) return live
    const entry = this.entries[id] ?? {
      path: null,
      offset: 0,
      follower: { ...EMPTY_FOLLOWER },
      current: null,
    }
    const follower = new ModelFollower(entry.follower, this.ops.alternates(tool))
    entry.follower = follower.state
    live = {
      entry,
      follower,
      tool,
      conversation: null,
      searchedAt: Number.NEGATIVE_INFINITY,
      dirty: false,
      savedAt: now,
      busy: false,
      stoppedAt: Number.NEGATIVE_INFINITY,
      quietSince: null,
      reader: null,
    }
    this.live.set(id, live)
    this.entries[id] = entry
    return live
  }

  /** A poll found the session's agent record (the agent-state poller). */
  see(id: string, source: ModelSource, tail: FileTail): void {
    const now = this.ops.now()
    const live = this.liveOf(id, source.tool, now)
    const path = this.pathOf(live, source, now)
    if (!path) return
    if (live.entry.path !== path) {
      // Another conversation (Claude `/clear`, a resumed thread): read it from
      // its start; the baseline stays the session's.
      live.entry.path = path
      live.entry.offset = 0
      live.dirty = true
    }
    const reader = source.tail ?? tail
    live.reader = reader
    if (live.entry.offset === 0 && live.follower.state.baseline === null)
      this.seed(live, source.tool, path, reader)
    let chunk: { text: string; offset: number; size: number }
    try {
      chunk = reader.read(path, live.entry.offset, STEP_BYTES)
    } catch {
      return
    }
    const lines = chunk.text.split('\n')
    // A read that skipped ahead (more than a step behind) starts mid-line.
    if (chunk.offset - Buffer.byteLength(chunk.text) > live.entry.offset) lines.shift()
    if (chunk.offset !== live.entry.offset) {
      live.entry.offset = chunk.offset
      live.dirty = true
    }
    const found: RawSwitch[] = []
    let spoke = false
    for (const line of lines) {
      if (!line) continue
      for (const event of EVENTS[source.tool](line)) {
        const raw = live.follower.apply(event, now)
        if (raw) found.push(raw)
        else if (
          event.type === 'served' &&
          !isModelSwitch(event.model, live.follower.state.current)
        )
          spoke = true
      }
    }
    const caughtUp = chunk.offset >= chunk.size
    const agent = this.ops.agent(id)
    if (
      live.follower.state.pending &&
      caughtUp &&
      agent.state !== 'working' &&
      agent.state !== 'unknown'
    ) {
      // A refused reply and the agent out of its turn: paused, once it holds.
      live.quietSince ??= now
      if (now - live.quietSince >= PAUSE_SETTLE_MS) {
        const raw = live.follower.pause(now)
        if (raw) found.push(raw)
      }
    } else live.quietSince = null
    if (found.length) live.dirty = true
    const latest = found.at(-1) ?? null
    if (live.follower.settled()) {
      if (live.entry.current) {
        this.ops.log(`session=${id} settled on ${live.follower.state.current ?? 'its model'}`)
        live.entry.current = null
        live.dirty = true
        this.ops.changed(id)
      }
    } else if (latest) this.show(id, live, latest)
    const shown = live.entry.current
    // A fallback stops at its switch, and again whenever the fallback model
    // answers while the switch stands (a new turn on it).
    if (
      shown &&
      STOPPING.has(shown.kind) &&
      caughtUp &&
      (latest?.key === shown.key ||
        (spoke && !isModelSwitch(shown.to, live.follower.state.current)))
    )
      void this.stop(id, live, shown, agent)
    if (live.dirty && (found.length || spoke || now - live.savedAt >= SAVE_EVERY_MS))
      this.save(live, now)
  }

  /** A record longer than a step is read from its last step: its first
   * model, the baseline, is read from its start. */
  private seed(live: Live, tool: ModelTool, path: string, reader: FileTail): void {
    let head: string
    try {
      head = reader.range(path, 0, HEAD_BYTES).toString('utf8')
    } catch {
      return
    }
    const lines = head.split('\n')
    lines.pop()
    for (const line of lines)
      for (const event of EVENTS[tool](line)) {
        const first =
          event.type === 'served' || event.type === 'requested'
            ? event.model
            : event.type === 'refused' || event.type === 'noFallback'
              ? event.model
              : event.type === 'refusal'
                ? event.from
                : null
        if (first) {
          live.follower.seed(first)
          return
        }
      }
  }

  private pathOf(live: Live, source: ModelSource, now: number): string | null {
    if (source.tool !== 'claude') return source.path
    const name = `${source.sessionId}.jsonl`
    if (live.conversation === source.sessionId) {
      if (live.entry.path?.endsWith(`/${name}`)) return live.entry.path
      if (now - live.searchedAt < TRANSCRIPT_SEARCH_MS) return null
    }
    live.searchedAt = now
    live.conversation = source.sessionId
    // A transcript followed before a restart is still the one.
    if (live.entry.path?.endsWith(`/${name}`)) return live.entry.path
    return claudeTranscriptPath(source.fs, source.home, source.sessionId)
  }

  /** The switch goes on the descriptor; the worktree facts follow. */
  private show(id: string, live: Live, raw: RawSwitch): void {
    live.entry.current = {
      ...raw,
      stopped: false,
      commit: null,
      worktreeChanged: null,
      checked: false,
    }
    this.ops.changed(id)
    this.ops.log(
      `session=${id} model ${raw.kind}: ${raw.from}${raw.kind === 'paused' ? '' : ` -> ${raw.to}`}${raw.category ? ` (${raw.category})` : ''}`,
    )
    void this.facts(id, live, raw.key, raw.at)
  }

  private async facts(id: string, live: Live, key: string, since: number): Promise<void> {
    // After a stop has had its moment, so what the fallback did counts.
    await new Promise((resolve) => setTimeout(resolve, FACTS_DELAY_MS).unref?.())
    const facts = await this.ops.worktree(id, since).catch(() => ({ commit: null, changed: null }))
    const current = live.entry.current
    if (current?.key !== key) return
    live.entry.current = {
      ...current,
      commit: facts.commit,
      worktreeChanged: facts.changed,
      checked: true,
    }
    this.save(live, this.ops.now())
    this.ops.changed(id)
  }

  /** Escape into the pane while the agent is in a turn, at most once per
   * `STOP_EVERY_MS`. Never into a dialog the owner opened. */
  private async stop(
    id: string,
    live: Live,
    shown: ModelSwitch,
    agent: { state: string; detail: string | null },
  ): Promise<void> {
    const now = this.ops.now()
    if (live.busy || now - live.stoppedAt < STOP_EVERY_MS) return
    const inTurn =
      agent.state === 'working' ||
      (agent.state === 'blocked' && agent.detail !== null && TURN_BLOCKS.has(agent.detail))
    if (!inTurn) {
      this.ops.log(`session=${id} on ${shown.to} while ${agent.state}: no turn to stop`)
      return
    }
    live.busy = true
    live.stoppedAt = now
    try {
      const sent = await this.ops.interrupt(id).catch(() => false)
      this.ops.log(
        `session=${id} stopping its turn on ${shown.to}: ${sent ? 'sent Escape' : 'Escape failed'}`,
      )
      const current = live.entry.current
      if (sent && current?.key === shown.key && !current.stopped) {
        live.entry.current = { ...current, stopped: true }
        this.save(live, this.ops.now())
        this.ops.changed(id)
      }
    } finally {
      live.busy = false
    }
  }

  private save(live: Live, now: number): void {
    live.dirty = false
    live.savedAt = now
    try {
      this.ops.write(this.entries)
    } catch (error) {
      this.ops.log(`saving failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** The owner's prompt `uuid` in the Claude transcript followed for a
   * session (the rewind target), read with the same reader. */
  promptOf(id: string, uuid: string): { text: string; later: number } | null {
    const live = this.live.get(id)
    const path = this.entries[id]?.path
    if (live?.tool !== 'claude' || !live.reader || !path) return null
    try {
      const { size } = live.reader.read(path, 0, 0)
      if (size > TRANSCRIPT_MAX_BYTES) return null
      return claudePromptAt(live.reader.range(path, 0, size).toString('utf8'), uuid)
    } catch {
      return null
    }
  }

  /** Sessions that are gone lose their follow. */
  retain(ids: Iterable<string>): void {
    const keep = new Set(ids)
    let removed = false
    for (const id of Object.keys(this.entries))
      if (!keep.has(id)) {
        delete this.entries[id]
        this.live.delete(id)
        removed = true
      }
    if (removed)
      try {
        this.ops.write(this.entries)
      } catch {}
  }
}

/** `<home>/.claude/projects/<dir>/<sessionId>.jsonl`, the first that exists. */
export function claudeTranscriptPath(fs: ProcFs, home: string, sessionId: string): string | null {
  if (!UUID.test(sessionId)) return null
  const root = join(home, '.claude', 'projects')
  let dirs: string[]
  try {
    dirs = fs.readdir(root)
  } catch {
    return null
  }
  for (const dir of dirs) {
    const path = join(root, dir, `${sessionId}.jsonl`)
    if (fs.mtimeMs ? fs.mtimeMs(path) !== null : readable(fs, path)) return path
  }
  return null
}

function readable(fs: ProcFs, path: string): boolean {
  try {
    fs.readHead(path, 1)
    return true
  } catch {
    return false
  }
}

/** Saved follows, as written by `ModelWatch` (unknown shapes dropped). */
export function readWatchEntries(text: string | null): Record<string, WatchEntry> {
  if (!text) return {}
  try {
    const value = JSON.parse(text) as Record<string, WatchEntry>
    if (!value || typeof value !== 'object') return {}
    const out: Record<string, WatchEntry> = {}
    for (const [id, entry] of Object.entries(value))
      if (
        /^[0-9a-f]{8}$/.test(id) &&
        entry &&
        typeof entry.offset === 'number' &&
        entry.follower &&
        typeof entry.follower === 'object'
      )
        out[id] = {
          path: typeof entry.path === 'string' ? entry.path : null,
          offset: entry.offset,
          follower: { ...EMPTY_FOLLOWER, ...entry.follower },
          current:
            entry.current && SWITCH_KINDS.includes(entry.current.kind) ? entry.current : null,
        }
    return out
  } catch {
    return {}
  }
}

// --- worktree facts and alternates ------------------------------------------------------

export type RunCommand = (
  command: string,
  args: string[],
  timeoutMs: number,
) => Promise<string | null>

/** At most this many changed paths are looked at for a change after a switch. */
const STATUS_PATHS = 2_000

/** HEAD (short) and whether the worktree changed after `since`: a commit made
 * after it, or a changed or new file written after it. Unknown (null) without
 * git or when git fails. */
export async function worktreeFacts(
  root: string | null,
  since: number,
  run: RunCommand,
  mtimeMs: (path: string) => number | null,
): Promise<{ commit: string | null; changed: boolean | null }> {
  if (!root) return { commit: null, changed: null }
  const log = await run('git', ['-C', root, 'log', '-1', '--format=%h%x09%ct'], 5_000)
  if (log === null) return { commit: null, changed: null }
  const [sha = '', seconds = ''] = log.trim().split('\t')
  const commit = /^[0-9a-f]{4,40}$/.test(sha) ? sha : null
  if (Number(seconds) * 1000 > since) return { commit, changed: true }
  const status = await run('git', ['-C', root, 'status', '--porcelain', '-z'], 10_000)
  if (status === null) return { commit, changed: null }
  const fields = status.split('\0')
  let looked = 0
  for (let i = 0; i < fields.length && looked < STATUS_PATHS; i++) {
    const field = fields[i] ?? ''
    if (field.length < 4) continue
    // A rename or copy is followed by its original path.
    if (field[0] === 'R' || field[0] === 'C') i++
    looked++
    const at = mtimeMs(join(root, field.slice(3)))
    if (at !== null && at > since) return { commit, changed: true }
  }
  return { commit, changed: false }
}

/** `model-alternates.json`: `{ "<tool>": ["model", ...] }`, models that are
 * no switch for that tool (refusals always are). Tools are Tether's
 * (`claude-code`, `codex`, `pi`); a missing or broken file allows none. */
export function readAlternates(text: string | null): Record<ModelTool, string[]> {
  const none: Record<ModelTool, string[]> = { claude: [], codex: [], pi: [] }
  if (!text) return none
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    const names: Record<string, ModelTool> = { 'claude-code': 'claude', codex: 'codex', pi: 'pi' }
    for (const [name, tool] of Object.entries(names)) {
      const list = value?.[name]
      if (Array.isArray(list))
        none[tool] = list.filter(
          (item): item is string => typeof item === 'string' && model(item) !== null,
        )
    }
  } catch {}
  return none
}

// --- the line ------------------------------------------------------------------------------

const COMMIT = /^[0-9a-f]{4,40}$/

/** A relayed descriptor's `modelSwitch`, checked field by field; null when
 * it is not one. */
export function modelSwitchOf(value: unknown): ModelSwitch | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const from = model(v.from)
  const to = model(v.to)
  if (
    typeof v.key !== 'string' ||
    !KEY.test(v.key) ||
    !(SWITCH_KINDS as readonly unknown[]).includes(v.kind) ||
    !from ||
    !to
  )
    return null
  return {
    key: v.key,
    kind: v.kind as SwitchKind,
    from,
    to,
    category: v.category === null ? null : refusalCategory(v.category),
    at: typeof v.at === 'number' && Number.isFinite(v.at) ? v.at : 0,
    stopped: v.stopped === true,
    commit: typeof v.commit === 'string' && COMMIT.test(v.commit) ? v.commit : null,
    worktreeChanged: typeof v.worktreeChanged === 'boolean' ? v.worktreeChanged : null,
    checked: v.checked === true,
    rewindTo: typeof v.rewindTo === 'string' && UUID.test(v.rewindTo) ? v.rewindTo : null,
  }
}

/** Tools `st aico root rewind` can rewind (Claude Code's rewind menu). */
export const REWIND_TOOLS: ReadonlySet<string> = new Set(['claude-code'])

const TOOL_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  pi: 'Pi',
}

/** What the lane should do next, per tool. */
function advice(tool: string | null, requestId: string | null): string {
  if (tool && REWIND_TOOLS.has(tool))
    return `rewind it${requestId ? ` (st aico root rewind ${requestId})` : ''}, or relaunch from a handoff`
  const name = (tool && TOOL_NAMES[tool]) || 'this agent'
  return `${name} has no supported rewind: relaunch from a handoff`
}

/** The switch as words after the lane's name; typed values only. */
export function modelSwitchText(
  change: ModelSwitch,
  tool: string | null,
  requestId: string | null,
): { tag: string; what: string; tail: string } {
  const refusal = `${change.category ? `${change.category} ` : ''}refusal`
  const article = /^[aeiou]/.test(refusal) ? 'an' : 'a'
  const facts = [
    `last commit ${change.commit ?? 'none'}`,
    `worktree changed since: ${change.worktreeChanged === null ? 'unknown' : change.worktreeChanged ? 'yes' : 'no'}`,
  ]
  if (change.kind === 'changed')
    return {
      tag: '[Model changed]',
      what: `now on ${change.to} (picked in the window, was ${change.from})`,
      tail: facts.join(' · '),
    }
  if (change.kind === 'paused')
    return {
      tag: '[Model refused]',
      what: `stopped on ${article} ${refusal} on ${change.to}: it waits on retry or another model`,
      tail: [...facts, advice(tool, requestId)].join(' · '),
    }
  const why =
    change.kind === 'refusal' ? `after ${article} ${refusal}` : `instead of ${change.from}`
  return {
    tag: '[Model changed]',
    what: `now on ${change.to} ${why}`,
    tail: [
      change.stopped ? 'turn stopped' : 'turn not stopped',
      ...facts,
      advice(tool, requestId),
    ].join(' · '),
  }
}

/** The text of the owner's prompt `uuid` in a Claude transcript, and how many
 * later prompts start with the same line (a rewind skips that many). */
export function claudePromptAt(
  transcript: string,
  uuid: string,
): { text: string; later: number } | null {
  if (!UUID.test(uuid)) return null
  let text: string | null = null
  let later = 0
  for (const line of transcript.split('\n')) {
    if (!line.includes('"user"')) continue
    const row = parse(line)
    if (!row || row.type !== 'user' || row.isSidechain === true || !isPrompt(row)) continue
    const content = (row.message as { content?: unknown }).content
    const body =
      typeof content === 'string'
        ? content
        : (content as { type?: string; text?: unknown }[])
            .map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
            .join('\n')
    const first =
      body
        .split('\n')
        .find((l) => l.trim())
        ?.trim() ?? ''
    if (text === null) {
      if (row.uuid === uuid) text = body
    } else if (
      first &&
      first ===
        (text
          .split('\n')
          .find((l) => l.trim())
          ?.trim() ?? '')
    )
      later++
  }
  return text === null ? null : { text, later }
}
