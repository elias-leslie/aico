// Tells the owner when a session needs them, from Tether's per-session agent
// state (`state` on the session descriptor; tether docs/agent-state.md).
//
// - Blocked (a permission prompt or a question) while the window is not
//   focused: flash the window and show the tray's "needs you" icon. If it is
//   still blocked and unfocused 2 minutes later, send one phone push.
// - Done (working -> idle) while unfocused: flash only, and only after the
//   window has stayed unfocused and idle for 30 s. No tray change.
// - Focusing the window, or the session leaving the state, clears both.
// No sounds.

export type AgentState = 'working' | 'idle' | 'blocked' | 'unknown'

export const DONE_FLASH_MS = 30_000
export const PUSH_AFTER_MS = 2 * 60_000
/** At most one push per session in this window. */
export const PUSH_COOLDOWN_MS = 15 * 60_000

export interface AttentionDeps {
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  isFocused(id: string): boolean
  flash(id: string, on: boolean): void
  /** The tray's "needs you" icon. */
  needsYou(on: boolean): void
  push(id: string): void
}

interface Entry {
  state: AgentState
  /** Blocked, unfocused and not yet seen: drives the tray icon. */
  needsYou: boolean
  flashing: boolean
  doneTimer: unknown
  pushTimer: unknown
}

export class Attention {
  private readonly entries = new Map<string, Entry>()
  private readonly lastPush = new Map<string, number>()
  private trayOn = false

  constructor(private readonly deps: AttentionDeps) {}

  /** A session's current agent state (every descriptor Aico receives). */
  update(id: string, state: AgentState): void {
    let entry = this.entries.get(id)
    const previous = entry?.state
    if (!entry) {
      entry = { state, needsYou: false, flashing: false, doneTimer: null, pushTimer: null }
      this.entries.set(id, entry)
    }
    if (previous === state) return
    entry.state = state
    this.cancelDone(entry)

    if (state === 'blocked') {
      if (!this.deps.isFocused(id)) {
        entry.needsYou = true
        this.setFlash(id, entry, true)
        this.cancelPush(entry)
        entry.pushTimer = this.deps.setTimer(() => this.maybePush(id), PUSH_AFTER_MS)
      }
    } else {
      entry.needsYou = false
      this.cancelPush(entry)
      this.setFlash(id, entry, false)
      if (previous === 'working' && state === 'idle' && !this.deps.isFocused(id)) {
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
    this.cancelDone(entry)
    this.cancelPush(entry)
    this.setFlash(id, entry, false)
    this.syncTray()
  }

  /** The session ended or left the catalog. */
  removed(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this.cancelDone(entry)
    this.cancelPush(entry)
    this.setFlash(id, entry, false)
    this.entries.delete(id)
    this.syncTray()
  }

  /** Session ids currently shown as needing the owner. */
  needing(): string[] {
    return [...this.entries].filter(([, entry]) => entry.needsYou).map(([id]) => id)
  }

  private maybePush(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    entry.pushTimer = null
    if (entry.state !== 'blocked' || !entry.needsYou || this.deps.isFocused(id)) return
    const now = this.deps.now()
    const last = this.lastPush.get(id)
    if (last !== undefined && now - last < PUSH_COOLDOWN_MS) return
    this.lastPush.set(id, now)
    this.deps.push(id)
  }

  private setFlash(id: string, entry: Entry, on: boolean): void {
    if (entry.flashing === on) return
    entry.flashing = on
    this.deps.flash(id, on)
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

/** Which agent a state came from, for the push text (`Claude`, `Codex`). */
export function agentName(stateSource: string | undefined, fallback: string): string {
  if (stateSource?.startsWith('claude')) return 'Claude'
  if (stateSource?.startsWith('codex')) return 'Codex'
  return fallback
}

/** The phone push body, e.g. "Claude in tether is waiting for you". */
export function pushBody(agent: string, title: string): string {
  return `${agent} in ${title} is waiting for you`
}
