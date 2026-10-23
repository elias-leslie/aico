// Tells the owner when a session needs them, from Tether's per-session agent
// state (`state` on the session descriptor; tether docs/agent-state.md).
//
// - Blocked (a permission prompt or a question) while the window is not
//   focused: flash the window and show the tray's "needs you" icon. If it is
//   still blocked and unfocused 2 minutes later, send one phone push.
//   Nightshift keeps repeats for the same session quiet for an hour, so Aico
//   keeps no cooldown of its own.
// - Done (working -> idle) while unfocused: flash only, and only after the
//   window has stayed unfocused and idle for 30 s. No tray change.
// - Focusing the window, or the session leaving the state, clears both.
// No sounds.
//
// The window itself shows the same through its eyes (renderer eyes.ts), in
// stages: a blocked window starts `fresh` (a "?" bubble and one eye motion),
// is `rising` after 30 s (amber border and titlebar, a motion every ~8 s) and
// `urgent` after 2 minutes (the other windows' eyes turn to it). A finished
// one shows a "✓" bubble and happy eyes, nothing more.

import type { TetherTool } from 'tether/client'

export type AgentState = 'working' | 'idle' | 'blocked' | 'unknown'

export const DONE_FLASH_MS = 30_000
/** Blocked and unseen this long: the window's border and titlebar turn amber. */
export const RISE_AFTER_MS = 30_000
export const PUSH_AFTER_MS = 2 * 60_000

export type AttentionMode = 'none' | 'blocked' | 'finished'
export type AttentionStage = 'fresh' | 'rising' | 'urgent'

export interface AttentionDeps {
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  isFocused(id: string): boolean
  flash(id: string, on: boolean): void
  /** The tray's "needs you" icon. */
  needsYou(on: boolean): void
  push(id: string): void
  /** What the session's window shows on itself (its eyes, border, titlebar). */
  attend(id: string, mode: AttentionMode, stage: AttentionStage): void
}

interface Entry {
  state: AgentState
  /** When the state began (Tether's stateAt), or null when unknown. */
  at: number | null
  /** Done (working -> idle) while unfocused, and not looked at since. */
  finished: boolean
  /** Blocked, unfocused and not yet seen: drives the tray icon. */
  needsYou: boolean
  flashing: boolean
  mode: AttentionMode
  stage: AttentionStage
  doneTimer: unknown
  riseTimer: unknown
  pushTimer: unknown
}

export class Attention {
  private readonly entries = new Map<string, Entry>()
  private trayOn = false

  constructor(private readonly deps: AttentionDeps) {}

  /** A session's current agent state (every descriptor Aico receives). */
  update(id: string, state: AgentState, at: number | null = null): void {
    let entry = this.entries.get(id)
    const previous = entry?.state
    if (!entry) {
      entry = {
        state,
        at,
        finished: false,
        needsYou: false,
        flashing: false,
        mode: 'none',
        stage: 'fresh',
        doneTimer: null,
        riseTimer: null,
        pushTimer: null,
      }
      this.entries.set(id, entry)
    }
    entry.at = at
    if (previous === state) return
    entry.state = state
    entry.finished = false
    this.cancelDone(entry)

    if (state === 'blocked') {
      if (!this.deps.isFocused(id)) {
        entry.needsYou = true
        this.setFlash(id, entry, true)
        this.cancelPush(entry)
        this.setAttend(id, entry, 'blocked', 'fresh')
        entry.riseTimer = this.deps.setTimer(() => {
          entry.riseTimer = null
          if (this.entries.get(id) === entry && entry.mode === 'blocked')
            this.setAttend(id, entry, 'blocked', 'rising')
        }, RISE_AFTER_MS)
        entry.pushTimer = this.deps.setTimer(() => this.maybePush(id), PUSH_AFTER_MS)
      }
    } else {
      entry.needsYou = false
      this.cancelPush(entry)
      this.setFlash(id, entry, false)
      this.setAttend(id, entry, 'none', 'fresh')
      if (previous === 'working' && state === 'idle' && !this.deps.isFocused(id)) {
        entry.finished = true
        this.setAttend(id, entry, 'finished', 'fresh')
        entry.doneTimer = this.deps.setTimer(() => {
          entry.doneTimer = null
          if (this.entries.get(id) === entry && entry.state === 'idle' && !this.deps.isFocused(id))
            this.setFlash(id, entry, true)
        }, DONE_FLASH_MS)
      }
    }
    this.syncTray()
  }

  /** The session's window gained focus: the owner has seen it. */
  focused(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    entry.needsYou = false
    entry.finished = false
    this.cancelDone(entry)
    this.cancelPush(entry)
    this.setFlash(id, entry, false)
    this.setAttend(id, entry, 'none', 'fresh')
    this.syncTray()
  }

  /** The session ended or left the catalog. */
  removed(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this.cancelDone(entry)
    this.cancelPush(entry)
    this.setFlash(id, entry, false)
    this.setAttend(id, entry, 'none', 'fresh')
    this.entries.delete(id)
    this.syncTray()
  }

  /** The session's tray group and the time its state began. */
  group(id: string): { group: AttentionGroup; state: AgentState; at: number | null } {
    const entry = this.entries.get(id)
    if (!entry) return { group: 'idle', state: 'unknown', at: null }
    const group: AttentionGroup = entry.needsYou
      ? 'needs-you'
      : entry.finished
        ? 'finished'
        : entry.state === 'working'
          ? 'working'
          : 'idle'
    return { group, state: entry.state, at: entry.at }
  }

  /** Session ids currently shown as needing the owner. */
  needing(): string[] {
    return [...this.entries].filter(([, entry]) => entry.needsYou).map(([id]) => id)
  }

  /** Blocked windows two minutes unseen: the other windows look at them. */
  urgent(): string[] {
    return [...this.entries]
      .filter(([, entry]) => entry.mode === 'blocked' && entry.stage === 'urgent')
      .map(([id]) => id)
  }

  private maybePush(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    entry.pushTimer = null
    if (entry.state !== 'blocked' || !entry.needsYou || this.deps.isFocused(id)) return
    this.setAttend(id, entry, 'blocked', 'urgent')
    this.deps.push(id)
  }

  private setFlash(id: string, entry: Entry, on: boolean): void {
    if (entry.flashing === on) return
    entry.flashing = on
    this.deps.flash(id, on)
  }

  private setAttend(id: string, entry: Entry, mode: AttentionMode, stage: AttentionStage): void {
    if (mode !== 'blocked' && entry.riseTimer !== null) {
      this.deps.clearTimer(entry.riseTimer)
      entry.riseTimer = null
    }
    if (entry.mode === mode && entry.stage === stage) return
    entry.mode = mode
    entry.stage = stage
    this.deps.attend(id, mode, stage)
  }

  private cancelDone(entry: Entry): void {
    if (entry.doneTimer !== null) this.deps.clearTimer(entry.doneTimer)
    entry.doneTimer = null
  }

  private cancelPush(entry: Entry): void {
    if (entry.pushTimer !== null) this.deps.clearTimer(entry.pushTimer)
    entry.pushTimer = null
  }

  private syncTray(): void {
    const on = [...this.entries.values()].some((entry) => entry.needsYou)
    if (on === this.trayOn) return
    this.trayOn = on
    this.deps.needsYou(on)
  }
}

export type AttentionGroup = 'needs-you' | 'finished' | 'working' | 'idle'

/** Most urgent first; the tray menu lists its groups under these titles. */
export const ATTENTION_GROUPS: readonly { group: AttentionGroup; title: string }[] = [
  { group: 'needs-you', title: 'Needs you' },
  { group: 'finished', title: 'Finished' },
  { group: 'working', title: 'Working' },
  { group: 'idle', title: 'Idle' },
]

/** Compact age: `<1m`, `3m`, `2h`, `4d`. */
export function formatAge(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/** A row's state and age, e.g. `waiting 3m`, `done 1m`, `working 12m`. A
 * blocked session already looked at stays `waiting` in the Idle group. */
export function stateAge(
  state: AgentState,
  group: AttentionGroup,
  at: number | null,
  now: number,
): string | null {
  const word =
    state === 'blocked'
      ? 'waiting'
      : group === 'finished'
        ? 'done'
        : state === 'working'
          ? 'working'
          : state === 'idle'
            ? 'idle'
            : null
  if (!word) return null
  return at ? `${word} ${formatAge(now - at)}` : word
}

export interface AttentionRow<T> {
  item: T
  group: AttentionGroup
  detail: string | null
}

/** Sessions grouped most-urgent first. Needs-you rows wait longest first;
 * the others show the most recent change first. */
export function groupRows<T extends { id: string }>(
  items: readonly T[],
  attention: Pick<Attention, 'group'>,
  now: number,
): AttentionRow<T>[] {
  const rows = items.map((item) => {
    const { group, state, at } = attention.group(item.id)
    return { item, group, at, detail: stateAge(state, group, at, now) }
  })
  const rank = (group: AttentionGroup) => ATTENTION_GROUPS.findIndex((g) => g.group === group)
  rows.sort((a, b) => {
    if (a.group !== b.group) return rank(a.group) - rank(b.group)
    const ax = a.at ?? 0
    const bx = b.at ?? 0
    return a.group === 'needs-you' ? ax - bx : bx - ax
  })
  return rows.map(({ item, group, detail }) => ({ item, group, detail }))
}

/** Which agent a state came from, for the push text (`Claude Code`, `Codex`):
 * the Tether tool the state source names by its first word (`claude-status`
 * names the tool whose slug, process name or alias is `claude`), else the
 * session's own tool (`fallback`, which names it by Aico's built-in name while
 * Tether's tool list is unavailable). */
export function agentName(
  stateSource: string | undefined,
  tools: readonly Pick<TetherTool, 'slug' | 'name' | 'processName' | 'aliases'>[],
  fallback: string,
): string {
  const word = stateSource?.split('-')[0]
  if (!word || word === 'none') return fallback
  const tool = tools.find(
    (t) => t.slug === word || t.processName === word || t.aliases?.includes(word),
  )
  return tool?.name ?? fallback
}

/** The phone push body, e.g. "Claude in tether is waiting for you". */
export function pushBody(agent: string, title: string): string {
  return `${agent} in ${title} is waiting for you`
}

/** What became of one `nightshift push`. `suppressed` is Nightshift keeping a
 * repeat for the same session quiet: nothing reached the phone. */
export interface PushOutcome {
  result: 'sent' | 'suppressed' | 'failed'
  /** Nightshift's result word (`sent_1/2`, `suppressed`, `gone,rejected:410`), when it printed one. */
  nightshift?: string
  /** Exit code, spawn error code or `killed` (timeout) when the command failed. */
  exit?: string
}

/** Reads `nightshift push` output: `sent N/M` or `spooled` (Nightshift retries
 * delivery itself) count as sent, `suppressed` as suppressed, anything else
 * (no subscribers, every device rejected, a crash, a timeout) as failed.
 * Nightshift prints its result last, after any state-file diagnostics. */
export function pushOutcome(
  error: { code?: unknown; killed?: boolean } | null,
  stdout: string,
): PushOutcome {
  const last = stdout.trim().split('\n').pop()?.trim() ?? ''
  // Only a Nightshift result word goes in the journal, never other output.
  const word = /^[a-z][a-z0-9 ,:/-]{0,39}$/.test(last) ? last.replace(/ /g, '_') : undefined
  const result =
    !error && (last.startsWith('sent ') || last === 'spooled')
      ? 'sent'
      : !error && last === 'suppressed'
        ? 'suppressed'
        : 'failed'
  const outcome: PushOutcome = { result }
  if (word) outcome.nightshift = word
  if (error) {
    const code = error.code
    outcome.exit =
      typeof code === 'number' || (typeof code === 'string' && /^[A-Z0-9_]{1,24}$/.test(code))
        ? String(code)
        : error.killed
          ? 'killed'
          : 'error'
  }
  return outcome
}

/** One ids-only journal line per push: no titles, no message text. */
export function pushEventLine(id: string, outcome: PushOutcome): string {
  return [
    '[aico:event] needs_you_push',
    `result=${outcome.result}`,
    `widget=${id}`,
    outcome.nightshift ? `nightshift=${outcome.nightshift}` : '',
    outcome.exit ? `exit=${outcome.exit}` : '',
  ]
    .filter(Boolean)
    .join(' ')
}
