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

import { dirname, join } from 'node:path'
import { ADAPTERS, adapterByHarness, adapterOf } from './lifecycle/tui/registry'
import {
  KEY,
  type ModelEvent,
  type ModelSource,
  model,
  refusalCategory,
  UNKNOWN_MODEL,
  UUID,
} from './model-record'
import type { FileTail } from './proc-fs'

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

/** An adapter's `harness`: `claude`, `codex`, `pi`. */
export type ModelTool = string

// --- the follower ------------------------------------------------------------------------

/** A refused reply whose turn has not gone on yet. */
export interface PendingRefusal {
  model: string | null
  category: string | null
  key: string
  at: number
  /** The prompt of the refused turn. */
  prompt: string | null
  /** Where that prompt's row starts in the record. */
  promptAt: number | null
}

/** What a follower keeps across a Tether restart. */
export interface FollowerState {
  baseline: string | null
  current: string | null
  requested: string | null
  /** A model picker ran and no answer has come since. */
  chosen: boolean
  /** The latest owner's prompt (Claude), and where its row starts. */
  prompt: string | null
  promptAt: number | null
  /** The model now came from a refusal or a substitution, not a pick: an
   * allowed alternate is still a switch until someone picks it. */
  unasked: boolean
  /** A refused reply not yet answered by a retry or a switch. */
  pending: PendingRefusal | null
  /** The turn stopped on a refusal and nothing has answered since. */
  paused: boolean
  /** Refusal keys already counted (the last few). */
  refusals: string[]
  /** Switches counted (keys). */
  seq: number
}

const EMPTY_FOLLOWER: Readonly<FollowerState> = Object.freeze({
  baseline: null,
  current: null,
  requested: null,
  chosen: false,
  prompt: null,
  promptAt: null,
  unasked: false,
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
  /** Where the rewind target's row starts in the record. */
  rewindAt: number | null
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

  /** On the baseline model (or an allowed alternate nobody was put on) and
   * not paused. */
  settled(): boolean {
    const { baseline, current, paused, unasked } = this.state
    return !paused && (!isModelSwitch(baseline, current) || (!unasked && this.allowed(current)))
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
    rewind: { uuid: string | null; at: number | null } = { uuid: null, at: null },
  ): RawSwitch {
    this.state.seq += 1
    this.state.unasked = kind === 'refusal' || kind === 'substituted'
    return {
      key: `${this.state.seq}@${at}`,
      kind,
      from,
      to,
      category,
      at,
      rewindTo: rewind.uuid,
      rewindAt: rewind.uuid ? rewind.at : null,
    }
  }

  /** Someone picked the model the session was put on: no longer unasked. */
  private picked(model: string, at: number): RawSwitch | null {
    const s = this.state
    if (!s.unasked || isModelSwitch(s.current, model) || !isModelSwitch(s.baseline, model))
      return null
    return this.next('changed', s.baseline ?? model, model, null, at)
  }

  /** The pending refusal ended its turn with no switch. */
  pause(now: number): RawSwitch | null {
    const s = this.state
    const pending = s.pending
    if (!pending) return null
    s.pending = null
    s.paused = true
    const on = pending.model ?? s.current ?? s.baseline ?? UNKNOWN_MODEL
    const unasked = s.unasked
    const raw = this.next('paused', on, on, pending.category, pending.at ?? now, {
      uuid: pending.prompt,
      at: pending.promptAt,
    })
    s.unasked = unasked
    return raw
  }

  /** `offset`: where the event's row starts in the record. */
  apply(event: ModelEvent, now: number, offset: number | null = null): RawSwitch | null {
    const s = this.state
    const at = event.at ?? now
    switch (event.type) {
      case 'chosen':
        s.chosen = true
        return null
      case 'kept':
        s.chosen = false
        return null
      case 'prompt':
        s.prompt = event.uuid
        s.promptAt = offset
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
            promptAt: s.promptAt,
          }
        return null
      case 'noFallback': {
        const pending = s.pending
        s.pending = null
        if (this.seen(event.key) || (pending && s.refusals.includes(pending.key) && s.paused))
          return null
        if (pending) this.seen(pending.key)
        s.paused = true
        const on = event.model ?? pending?.model ?? s.current ?? s.baseline ?? UNKNOWN_MODEL
        const unasked = s.unasked
        const raw = this.next('paused', on, on, event.category ?? pending?.category ?? null, at, {
          uuid: pending?.prompt ?? s.prompt,
          at: pending ? pending.promptAt : s.promptAt,
        })
        s.unasked = unasked
        return raw
      }
      case 'refusal': {
        const prompt = s.pending
          ? { uuid: s.pending.prompt, at: s.pending.promptAt }
          : { uuid: s.prompt, at: s.promptAt }
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
        // The tool's own pick changed (its model picker), perhaps to the model
        // the session was put on.
        const picked = this.picked(event.model, at)
        if (picked) return picked
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
          // `/model` kept on the model the session was put on: picked now.
          const picked = s.chosen ? this.picked(event.model, at) : null
          s.chosen = false
          return picked
        }
        s.current = event.model
        const chosen =
          s.chosen || (s.requested !== null && !isModelSwitch(s.requested, event.model))
        s.chosen = false
        if (!isModelSwitch(s.baseline, event.model) || this.allowed(event.model)) {
          s.unasked = false
          return null
        }
        return this.next(chosen ? 'changed' : 'substituted', from, event.model, null, at)
      }
    }
  }
}

// --- the watch -------------------------------------------------------------------------

/** One session's persisted follow (settings `model-watch`). */
export interface WatchEntry {
  path: string | null
  offset: number
  follower: FollowerState
  /** The switch the descriptor shows; null while settled. */
  current: ModelSwitch | null
  /** The tool and agent process followed. */
  tool: ModelTool | null
  agent: number | null
  /** Where the shown switch's rewind target row starts. */
  rewindAt: number | null
  /** The switch key a rewind already undid. */
  rewound: string | null
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

/** Bytes read per poll, forward from where the last read stopped: a record
 * further behind is caught up over several polls, and only once caught up is
 * a switch shown or a turn stopped. */
const STEP_BYTES = 4 * 1024 * 1024
/** The most a rewind reads from its target prompt on. */
const PROMPT_READ_BYTES = 32 * 1024 * 1024
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
  /** Claude: the folder of the transcript followed before a `/clear`. */
  near: string | null
  /** A new agent process resumed this record: read it from its end. */
  resumes: string | null
  /** The next read starts inside a line longer than a step. */
  midLine: boolean
  /** The latest switch found while catching up, shown once caught up. */
  held: RawSwitch | null
  dirty: boolean
  savedAt: number
  /** An Escape is being sent. */
  busy: boolean
  stoppedAt: number
  /** The shown switch's turn still needs its Escape. */
  stopDue: boolean
  /** When the pending refusal was first seen with the agent out of its turn. */
  quietSince: number | null
  /** The reader the record was last read with (contained for an entry home). */
  reader: FileTail | null
}

function emptyEntry(tool: ModelTool, agent: number): WatchEntry {
  return {
    path: null,
    offset: 0,
    follower: { ...EMPTY_FOLLOWER },
    current: null,
    tool,
    agent,
    rewindAt: null,
    rewound: null,
  }
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

  private liveOf(id: string, source: ModelSource, now: number): Live {
    const live = this.live.get(id)
    if (live && live.tool === source.tool && live.entry.agent === source.agent) return live
    let entry = this.entries[id]
    let resumes: string | null = null
    if (entry && (entry.tool !== source.tool || entry.agent !== source.agent)) {
      // Another agent in the session: its own launch model. The same record
      // resumed is read on from its end; what was shown belonged to the last.
      this.ops.log(
        `session=${id} new agent ${source.tool} pid ${source.agent}: following it afresh`,
      )
      resumes = entry.tool === source.tool ? entry.path : null
      const shown = entry.current !== null
      entry = emptyEntry(source.tool, source.agent)
      if (shown) this.ops.changed(id)
    }
    entry ??= emptyEntry(source.tool, source.agent)
    const follower = new ModelFollower(entry.follower, this.ops.alternates(source.tool))
    entry.follower = follower.state
    const current = entry.current
    const next: Live = {
      entry,
      follower,
      tool: source.tool,
      conversation: null,
      searchedAt: Number.NEGATIVE_INFINITY,
      near: null,
      resumes,
      midLine: false,
      held: null,
      dirty: resumes !== null,
      savedAt: now,
      busy: false,
      stoppedAt: Number.NEGATIVE_INFINITY,
      stopDue: current !== null && STOPPING.has(current.kind) && !current.stopped,
      quietSince: null,
      reader: null,
    }
    this.live.set(id, next)
    this.entries[id] = entry
    // A switch whose facts a restart cut off gets them now.
    if (current && !current.checked) void this.facts(id, next, current.key, current.at)
    return next
  }

  /** A poll found the session's agent record (the agent-state poller). */
  see(id: string, source: ModelSource, tail: FileTail): void {
    const now = this.ops.now()
    const live = this.liveOf(id, source, now)
    const path = this.pathOf(live, source, now)
    if (!path) return
    const reader = source.tail ?? tail
    live.reader = reader
    let size: number
    try {
      size = reader.read(path, 0, 0).size
    } catch {
      return
    }
    if (live.entry.path !== path) {
      // Another conversation (Claude `/clear`, a resumed thread): read it from
      // its start; the baseline stays the session's. A record a new agent
      // process resumed goes on from its end.
      live.entry.path = path
      live.entry.offset = path === live.resumes ? size : 0
      live.resumes = null
      live.midLine = false
      live.dirty = true
    }
    // A shrunk record starts over.
    if (live.entry.offset > size) live.entry.offset = 0
    const start = live.entry.offset
    const end = Math.min(size, start + STEP_BYTES)
    let buffer: Buffer
    try {
      buffer = end > start ? reader.range(path, start, end) : Buffer.alloc(0)
    } catch {
      return
    }
    let at = 0
    if (live.midLine) {
      const newline = buffer.indexOf(0x0a)
      at = newline < 0 ? buffer.length : newline + 1
      live.midLine = newline < 0
    }
    let cut = buffer.lastIndexOf(0x0a) + 1
    if (cut <= at && buffer.length >= STEP_BYTES) {
      // One line longer than a step: skip it.
      cut = buffer.length
      live.midLine = true
    }
    const found: RawSwitch[] = []
    let spoke = false
    while (at < cut) {
      const newline = buffer.indexOf(0x0a, at)
      const stop = newline < 0 || newline >= cut ? cut : newline
      const line = buffer.subarray(at, stop).toString('utf8')
      const lineAt = start + at
      at = stop + 1
      if (!line) continue
      for (const event of adapterByHarness(source.tool)?.models?.events(line) ?? []) {
        const raw = live.follower.apply(event, now, lineAt)
        if (raw) found.push(raw)
        else if (
          event.type === 'served' &&
          !isModelSwitch(event.model, live.follower.state.current)
        )
          spoke = true
      }
    }
    if (start + cut !== live.entry.offset) {
      live.entry.offset = start + cut
      live.dirty = true
    }
    const caughtUp = end >= size
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
    // While catching up, only the latest switch counts, once caught up.
    let latest = found.at(-1) ?? live.held
    live.held = caughtUp ? null : latest
    if (!caughtUp) latest = null
    if (live.follower.settled()) {
      live.held = null
      if (live.entry.current) {
        this.ops.log(`session=${id} settled on ${live.follower.state.current ?? 'its model'}`)
        live.entry.current = null
        live.entry.rewindAt = null
        live.stopDue = false
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
      (live.stopDue || (spoke && !isModelSwitch(shown.to, live.follower.state.current)))
    )
      void this.stop(id, live, shown, agent)
    if (live.dirty && (found.length || spoke || now - live.savedAt >= SAVE_EVERY_MS))
      this.save(live, now)
  }

  private pathOf(live: Live, source: ModelSource, now: number): string | null {
    const where = source.locate
    if (!where) return source.path ?? null
    const name = where.fileName
    if (live.conversation === where.sessionId) {
      if (live.entry.path?.endsWith(`/${name}`)) return live.entry.path
      // A new conversation's file appears with its first prompt, most likely
      // beside the last one: looked for there on every poll.
      const near = live.near ? join(live.near, name) : null
      if (near && where.exists(near)) return near
      if (now - live.searchedAt < TRANSCRIPT_SEARCH_MS) return null
    }
    live.searchedAt = now
    live.conversation = where.sessionId
    if (live.entry.path) live.near = dirname(live.entry.path)
    // A transcript followed before a restart is still the one.
    if (live.entry.path?.endsWith(`/${name}`)) return live.entry.path
    return where.find()
  }

  /** The switch goes on the descriptor; the worktree facts follow. */
  private show(id: string, live: Live, raw: RawSwitch): void {
    const { rewindAt, ...shown } = raw
    live.entry.current = {
      ...shown,
      stopped: false,
      commit: null,
      worktreeChanged: null,
      checked: false,
    }
    live.entry.rewindAt = rewindAt
    live.stopDue = STOPPING.has(raw.kind)
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
    if (current?.key !== key || this.live.get(id) !== live) return
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
   * `STOP_EVERY_MS`. Never into a dialog the owner opened. A due stop waits
   * for a turn, and is dropped once the agent is idle (no turn to stop). */
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
      if (agent.state === 'idle' && live.stopDue) {
        live.stopDue = false
        this.ops.log(`session=${id} on ${shown.to} while idle: no turn to stop`)
      }
      return
    }
    live.busy = true
    live.stoppedAt = now
    try {
      const sent = await this.ops.interrupt(id).catch(() => false)
      this.ops.log(
        `session=${id} stopping its turn on ${shown.to}: ${sent ? 'sent Escape' : 'Escape failed'}`,
      )
      if (sent) live.stopDue = false
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

  /** The rewind target of the shown switch in the Claude transcript followed
   * for a session: the prompt's text and the first lines of the prompts after
   * it, read with the same reader from that prompt's row on. */
  promptOf(id: string): { key: string; text: string; after: string[] } | null {
    const live = this.live.get(id)
    const entry = this.entries[id]
    const change = entry?.current
    const promptAt = adapterByHarness(live?.tool)?.models?.promptAt
    if (!promptAt || !live?.reader || !entry?.path || !change?.rewindTo) return null
    if (entry.rewindAt === null) return null
    try {
      const { size } = live.reader.read(entry.path, 0, 0)
      if (size - entry.rewindAt > PROMPT_READ_BYTES) return null
      const text = live.reader.range(entry.path, entry.rewindAt, size).toString('utf8')
      const found = promptAt(text, change.rewindTo)
      return found ? { key: change.key, ...found } : null
    } catch {
      return null
    }
  }

  /** The switch a rewind undid, so it is not undone twice. */
  rewoundOf(id: string): string | null {
    return this.entries[id]?.rewound ?? null
  }

  markRewound(id: string, key: string): void {
    const entry = this.entries[id]
    if (!entry) return
    entry.rewound = key
    try {
      this.ops.write(this.entries)
    } catch {}
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
          tool: adapterByHarness(entry.tool)?.models ? (entry.tool as ModelTool) : null,
          agent: typeof entry.agent === 'number' ? entry.agent : null,
          rewindAt: typeof entry.rewindAt === 'number' ? entry.rewindAt : null,
          rewound: typeof entry.rewound === 'string' ? entry.rewound : null,
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
  const watched = ADAPTERS.filter((adapter) => adapter.models)
  const none: Record<ModelTool, string[]> = Object.fromEntries(
    watched.map((adapter) => [adapter.harness, []]),
  )
  if (!text) return none
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    for (const adapter of watched) {
      const list = value?.[adapter.id]
      if (Array.isArray(list))
        none[adapter.harness] = list.filter(
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

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/

/** What the lane should do next, per tool. */
function advice(tool: string | null, requestId: string | null): string {
  const request = requestId && REQUEST_ID.test(requestId) ? requestId : null
  const adapter = adapterOf(tool)
  if (adapter?.capabilities.rewind)
    return `rewind it${request ? ` (st aico root rewind ${request})` : ''}, or relaunch from a handoff`
  const name = adapter?.displayName ?? 'this agent'
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
