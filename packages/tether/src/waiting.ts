// The owner's "waiting" notice. A session blocked on the owner (a permission
// prompt or a question), or a workflow run waiting for an answer, that nobody
// has opened for 2 minutes gets one Nightshift notice (contract v1: the desktop
// tray, never the phone). It is resolved once the session no longer waits:
// answered, seen or gone. "Seen" is Aico web telling Tether the owner had the
// session open and visible (POST /v1/sessions/seen).
//
// Only the Tether that knows where Aico is (TETHER_AICO_URL) sends these: it
// sees its own sessions and every remote host's, so a remote Tether stays quiet.

import { HttpError, type Router, readJsonObject, sendJson } from './http'

/** Blocked and unseen this long: one notice. */
export const WAIT_NOTICE_MS = 2 * 60_000
/** Seen marks kept across restarts (newest first). */
const SEEN_KEPT = 500
const SESSION_ID = /^[0-9a-f]{8}$/
const SEEN_MAX_IDS = 50

export interface WaitingNotice {
  v: 1
  source: 'aico'
  kind: 'todo'
  severity: 'warning'
  title: string
  body: string
  key: string
  open?: string
  actions: ['open']
  primary: 'open'
  push: 'tray'
}

/** A session or run waiting on the owner, as a Nightshift notice (contract v1). */
export function waitingNotice(parts: {
  key: string
  title: string
  body: string
  open?: string
}): WaitingNotice {
  return {
    v: 1,
    source: 'aico',
    kind: 'todo',
    severity: 'warning',
    title: parts.title.slice(0, 200),
    body: parts.body.slice(0, 1000),
    key: parts.key.replace(/[^A-Za-z0-9_.:/@+=,-]/g, '-').slice(0, 200),
    ...(parts.open?.startsWith('https://') ? { open: parts.open } : {}),
    actions: ['open'],
    primary: 'open',
    push: 'tray',
  }
}

/** The part of a session descriptor the notice reads. */
export interface WaitingSession {
  id: string
  tool?: string
  label?: string
  displayTitle?: string
  state?: string
  stateAt?: number
  stateSource?: string
}

export interface WaitingTool {
  slug: string
  name: string
  processName?: string | null
  aliases?: readonly string[]
}

/** Which agent a state came from (`Claude Code`, `Codex`): the tool the state
 * source names by its first word (`claude-status` names the tool whose slug,
 * process name or alias is `claude`), else the session's own tool. */
export function agentName(session: WaitingSession, tools: readonly WaitingTool[]): string {
  const own = tools.find((t) => t.slug === session.tool)?.name ?? session.tool ?? 'An agent'
  const word = session.stateSource?.split('-')[0]
  if (!word || word === 'none') return own
  const tool = tools.find(
    (t) => t.slug === word || t.processName === word || t.aliases?.includes(word),
  )
  return tool?.name ?? own
}

/** The notice for a waiting session, or a run (`run:` ids). */
export function noticeFor(
  item: { session: WaitingSession },
  tools: readonly WaitingTool[],
  origin: string,
): WaitingNotice {
  const { session } = item
  const name = session.displayTitle?.trim() || session.label || `Session ${session.id}`
  return waitingNotice({
    key: `aico-waiting:${session.id}`,
    title: `${agentName(session, tools)} waiting in ${name}`,
    body: 'Open it in Aico to answer.',
    open: `${origin}/?session=${encodeURIComponent(session.id)}`,
  })
}

/** What survives a restart: when each session was last seen, and the notices
 * still open (id to its key and the wait it was sent for). */
export interface WaitingState {
  seen: Record<string, number>
  sent: Record<string, { key: string; since: number }>
}

export function readWaitingState(raw: string | null): WaitingState {
  const state: WaitingState = { seen: {}, sent: {} }
  try {
    const value = JSON.parse(raw ?? '{}') as Partial<Record<keyof WaitingState, unknown>>
    const seen = value.seen && typeof value.seen === 'object' ? value.seen : {}
    for (const [id, at] of Object.entries(seen)) if (typeof at === 'number') state.seen[id] = at
    const sent = value.sent && typeof value.sent === 'object' ? value.sent : {}
    for (const [id, entry] of Object.entries(sent)) {
      const e = entry as { key?: unknown; since?: unknown } | null
      if (typeof e?.key === 'string' && typeof e.since === 'number')
        state.sent[id] = { key: e.key, since: e.since }
    }
  } catch {
    // A damaged setting starts empty.
  }
  return state
}

export interface WaitingDeps {
  /** `nightshift push --json` with the notice on stdin. */
  send(notice: WaitingNotice): void
  /** `nightshift resolve <key>`. */
  resolve(key: string): void
  tools(): readonly WaitingTool[]
  origin: string
  state: { read(): WaitingState; write(state: WaitingState): void }
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

interface Entry {
  since: number
  item: { session: WaitingSession }
  timer: unknown
}

export class WaitingNotices {
  private readonly waiting = new Map<string, Entry>()
  private readonly state: WaitingState
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(private readonly deps: WaitingDeps) {
    this.state = deps.state.read()
    this.now = deps.now ?? Date.now
    this.setTimer =
      deps.setTimer ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms)
        handle.unref?.()
        return handle
      })
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout))
  }

  /** A session's latest descriptor. */
  session(session: WaitingSession): void {
    if (session.state === 'blocked') this.wait(session.id, session.stateAt ?? null, { session })
    else this.over(session.id)
  }

  /** The session ended or left the list. */
  removed(id: string): void {
    this.over(id)
  }

  /** The owner had these sessions open at `at`. */
  seen(ids: readonly string[], at: number): void {
    for (const id of ids) {
      this.state.seen[id] = Math.max(this.state.seen[id] ?? 0, at)
      const entry = this.waiting.get(id)
      if (entry && entry.since <= at) this.over(id, false)
    }
    const kept = Object.entries(this.state.seen)
    if (kept.length > SEEN_KEPT) {
      kept.sort((a, b) => b[1] - a[1])
      this.state.seen = Object.fromEntries(kept.slice(0, SEEN_KEPT))
    }
    this.save()
  }

  /** After startup: notices sent before a restart for something no longer waiting are resolved. */
  sweep(): void {
    for (const id of Object.keys(this.state.sent)) if (!this.waiting.has(id)) this.over(id)
  }

  /** Ids with a pending or open notice (tests). */
  pending(): string[] {
    return [...this.waiting.keys()]
  }

  private wait(id: string, at: number | null, item: Entry['item']): void {
    const existing = this.waiting.get(id)
    const since = at ?? existing?.since ?? this.now()
    if (existing && existing.since === since) {
      existing.item = item
      return
    }
    if (existing) this.over(id)
    const entry: Entry = { since, item, timer: null }
    this.waiting.set(id, entry)
    if ((this.state.seen[id] ?? 0) >= since) return
    if (this.state.sent[id]?.since === since) return
    entry.timer = this.setTimer(
      () => this.fire(id, entry),
      Math.max(0, since + WAIT_NOTICE_MS - this.now()),
    )
  }

  private fire(id: string, entry: Entry): void {
    entry.timer = null
    if (this.waiting.get(id) !== entry) return
    if ((this.state.seen[id] ?? 0) >= entry.since) return
    const notice = noticeFor(entry.item, this.deps.tools(), this.deps.origin)
    this.state.sent[id] = { key: notice.key, since: entry.since }
    this.save()
    this.deps.send(notice)
  }

  /** The wait is over (or seen: `forget` false keeps tracking it so it is not sent again). */
  private over(id: string, forget = true): void {
    const entry = this.waiting.get(id)
    if (entry?.timer != null) this.clearTimer(entry.timer)
    if (entry) entry.timer = null
    if (forget) this.waiting.delete(id)
    const sent = this.state.sent[id]
    if (sent) {
      delete this.state.sent[id]
      this.save()
      this.deps.resolve(sent.key)
    }
  }

  private save(): void {
    try {
      this.deps.state.write(this.state)
    } catch (error) {
      console.warn(`[tether] waiting notices not saved: ${(error as Error).message}`)
    }
  }
}

/** `POST /v1/sessions/seen` `{ ids }`: Aico web says the owner has these sessions open now. */
export function registerSeenRoute(router: Router, waiting: WaitingNotices, now = Date.now): void {
  router.add('POST', '/v1/sessions/seen', async (req, res) => {
    const body = await readJsonObject(req)
    const ids = body.ids
    if (
      !Array.isArray(ids) ||
      ids.length > SEEN_MAX_IDS ||
      !ids.every((id) => typeof id === 'string' && SESSION_ID.test(id))
    )
      throw new HttpError(400, 'invalid_body', { field: 'ids' })
    const at = now()
    waiting.seen(ids as string[], at)
    sendJson(res, 200, { seenAt: at })
  })
}
