// The web terminal: `WS /ws/:sessionId`, one tmux control-mode client
// (tether/term's ControlTerminal) per open socket, speaking the frames the web
// UI already speaks. The page sends text frames (typed input, or `{__ctrl:
// true, …}` JSON) or binary 0x01/0x02 frames; the server sends 0x01 pane text
// and 0x02 control JSON.
//
// A socket's first control message carries the viewer's size: the client
// starts at that size, or unsized (leaving the window's size to the other
// clients) when none arrives in time. Looking does not take the size: the
// socket claims the shared window size at attach only when nobody holds it yet
// (sizeAtAttach), and otherwise when the page sends `claim: true` (the owner
// typed, pasted or pressed Use here). Claims are labelled `{app: 'web',
// device}`; whenever the holder changes, the page gets a `size_holder` notice
// saying whether this socket holds it and, if not, which app and device does
// ("Viewing on …") and the session's size, which the page then shows.

import type { IncomingMessage } from 'node:http'
import {
  type SessionDescriptor,
  type TetherClient,
  TetherError,
  type TetherEvent,
  TetherUnavailable,
  type ViewerLabel,
} from 'tether/client'
import {
  attachEnvironment,
  ControlTerminal,
  controlFrame,
  createSizeClaim,
  ownAttachTarget,
  parseViewerFrame,
  sizeAtAttach,
  streamToViewer,
  VIEWER_CREDIT_BYTES,
} from 'tether/term'
import { WebSocket } from 'ws'
import { findSession } from './tether'

export const TERMINAL_PATH = /^\/ws\/([^/]+)$/
/** The close code the page treats as "this session is gone" (no reconnect). */
export const SESSION_DEAD_CODE = 4000
/** Closed for a reason the page retries ("service restart"). */
export const RECONNECT_CODE = 1012

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/
const FIRST_MESSAGE_WAIT_MS = 5_000
const HEARTBEAT_MS = 30_000
const MAX_COLS = 512
const MAX_ROWS = 256

export interface Size {
  cols: number
  rows: number
}

/** What a socket uses of its control client (ControlTerminal fits; tests pass a fake). */
export type TerminalLink = Pick<
  ControlTerminal,
  | 'pid'
  | 'cols'
  | 'rows'
  | 'ready'
  | 'closed'
  | 'write'
  | 'paste'
  | 'reseed'
  | 'resize'
  | 'settleSize'
  | 'windowState'
  | 'kill'
  | 'refusedByHost'
  | 'onData'
  | 'onExit'
  | 'delivered'
>

export interface TerminalDeps {
  tether: TetherClient
  /** Marks the session's tab as just viewed. */
  touched(sessionId: string): void
  historyLines: number
  openLink?(argv: string[], env: Record<string, string>, size: Size | null): TerminalLink
  /** The wait before remote reattach try `attempt`; tests shorten it. */
  retryDelay?(attempt: number): number
}

export type ClientMessage =
  | { kind: 'data'; text: string }
  | { kind: 'control'; message: Record<string, unknown> }

/**
 * A frame from the page. Text is input unless it is a JSON object with
 * `__ctrl: true` (typed JSON stays input); binary is a 0x01/0x02 frame.
 */
export function parseClientMessage(data: Buffer, isBinary: boolean): ClientMessage | null {
  if (isBinary) return parseViewerFrame(data)
  const text = data.toString('utf8')
  if (text.startsWith('{')) {
    try {
      const value = JSON.parse(text) as unknown
      if (value && typeof value === 'object' && (value as Record<string, unknown>).__ctrl)
        return { kind: 'control', message: value as Record<string, unknown> }
    } catch {
      // Not JSON: input like any other text.
    }
  }
  return text ? { kind: 'data', text } : null
}

const clamp = (value: number, max: number) => Math.min(max, Math.max(1, Math.trunc(value)))

/** A resize message's size (clamped), or null when it is malformed. */
export function sizeOf(message: Record<string, unknown>): Size | null {
  const resize = message.resize as Record<string, unknown> | undefined
  if (!resize || typeof resize !== 'object') return null
  const { cols, rows } = resize
  if (typeof cols !== 'number' || typeof rows !== 'number') return null
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null
  return { cols: clamp(cols, MAX_COLS), rows: clamp(rows, MAX_ROWS) }
}

/** "Chrome on Android": how other views name this device in "Viewing on …". */
export function deviceLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? ''
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser'
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Mac OS X|Macintosh/.test(ua)
            ? 'Mac'
            : /Linux|X11/.test(ua)
              ? 'Linux'
              : null
  return os ? `${browser} on ${os}` : browser
}

interface View {
  sizeHeld(clientPid: number, viewer: ViewerLabel | null, size: Size | null): void
  ended(): void
  close(code: number, reason: string): void
  /** The remote host the session runs on; null on this computer. */
  host: string | null
  /** The hub's link to that host changed state. */
  peer(state: string): void
  /** The hub's link to that host is back: attach again if the link is gone. */
  resync(): void
}

/** Reattach tries after a remote link drops while its host still counts as
 * up; then the socket waits for the hub's resync (or the page's Reconnect). */
const REMOTE_RETRIES = 6
const REMOTE_RETRY_BASE_MS = 1_000
const REMOTE_RETRY_CAP_MS = 30_000
/** A link that stayed up this long starts its retries from the first again. */
const REMOTE_STABLE_MS = 30_000

/** Capped exponential backoff, jittered to 50–150% so sockets don't retry in step. */
export function retryDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(REMOTE_RETRY_CAP_MS, REMOTE_RETRY_BASE_MS * 2 ** attempt)
  return Math.round(base * (0.5 + random()))
}

const defaultOpenLink =
  (historyLines: number) =>
  (argv: string[], env: Record<string, string>, size: Size | null): TerminalLink =>
    new ControlTerminal(argv, env, size, { historyLines, creditBytes: VIEWER_CREDIT_BYTES })

export class TerminalHub {
  private readonly views = new Map<string, Set<View>>()
  private readonly openLink: NonNullable<TerminalDeps['openLink']>

  constructor(private readonly deps: TerminalDeps) {
    this.openLink = deps.openLink ?? defaultOpenLink(deps.historyLines)
  }

  /** Close every open socket (the server is stopping). */
  stop(): void {
    for (const views of this.views.values())
      for (const view of views) view.close(1001, 'server stopping')
  }

  get openCount(): number {
    let count = 0
    for (const views of this.views.values()) count += views.size
    return count
  }

  /** One Tether event (size holders, ended sessions) for the open sockets; the server's stream feeds it. */
  event(event: TetherEvent): void {
    if (event.type === 'peer.state' || event.type === 'peer.resync') {
      const host = typeof event.data.host === 'string' ? event.data.host : null
      if (!host) return
      for (const views of this.views.values())
        for (const view of views) {
          if (view.host !== host) continue
          if (event.type === 'peer.resync') view.resync()
          else if (typeof event.data.state === 'string') view.peer(event.data.state)
        }
      return
    }
    const id = typeof event.data.id === 'string' ? event.data.id : null
    const views = id ? this.views.get(id) : undefined
    if (!views) return
    if (event.type === 'session.resized' && typeof event.data.clientPid === 'number') {
      const viewer = (event.data.viewer as ViewerLabel | undefined) ?? null
      const { cols, rows } = event.data
      const size =
        typeof cols === 'number' && typeof rows === 'number' && cols > 0 && rows > 0
          ? { cols, rows }
          : null
      for (const view of views) view.sizeHeld(event.data.clientPid, viewer, size)
    } else if (event.type === 'session.ended') {
      for (const view of views) view.ended()
    }
  }

  private add(id: string, view: View): void {
    const views = this.views.get(id) ?? new Set<View>()
    views.add(view)
    this.views.set(id, views)
  }

  private remove(id: string, view: View): void {
    const views = this.views.get(id)
    views?.delete(view)
    if (views?.size === 0) this.views.delete(id)
  }

  /** Serve one upgraded socket for `sessionId` until either side closes. */
  async serve(ws: WebSocket, req: IncomingMessage, sessionId: string): Promise<void> {
    const { tether } = this.deps
    const viewer: ViewerLabel = { app: 'web', device: deviceLabel(req.headers['user-agent']) }
    const dead = (message: string) =>
      ws.close(SESSION_DEAD_CODE, JSON.stringify({ error: 'session_dead', message }))
    if (!SESSION_ID.test(sessionId)) return dead('Invalid session id')

    let open = true
    let cleanup = () => {}
    let alive = true
    const beat = setInterval(() => {
      if (!alive) return ws.terminate()
      alive = false
      ws.ping()
    }, HEARTBEAT_MS)
    ws.on('pong', () => {
      alive = true
    })
    ws.on('close', () => {
      open = false
      clearInterval(beat)
      cleanup()
    })
    ws.on('error', () => {})

    // Messages that arrive before the client exists wait here.
    const early: ClientMessage[] = []
    let dispatch: ((message: ClientMessage) => void) | null = null
    let firstArrived = () => {}
    const first = new Promise<void>((resolve) => {
      firstArrived = resolve
    })
    ws.on('message', (data, isBinary) => {
      const buffer = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data)
      const message = parseClientMessage(buffer, isBinary)
      if (!message) return
      if (dispatch) dispatch(message)
      else {
        early.push(message)
        firstArrived()
      }
    })

    let descriptor: SessionDescriptor | null
    try {
      descriptor = await findSession(tether, sessionId)
    } catch (error) {
      if (open) ws.close(1011, unavailable(error))
      return
    }
    if (!descriptor) return dead('Session not found')
    if (!open) return
    ws.send(
      controlFrame({ __ctrl: true, transport: 'control', history_lines: this.deps.historyLines }),
    )
    let waitTimer: NodeJS.Timeout | undefined
    await Promise.race([
      first,
      new Promise<void>((resolve) => {
        waitTimer = setTimeout(resolve, FIRST_MESSAGE_WAIT_MS)
      }),
    ])
    clearTimeout(waitTimer)
    if (!open) return

    let size: Size | null = null
    for (const message of early) {
      if (message.kind === 'control') size = sizeOf(message.message) ?? size
    }

    // A session on a remote host can lose its link (the host went down, or
    // ssh dropped) while this socket stays open: the page then shows the
    // host's state and this socket attaches again when the host is back.
    const host = typeof descriptor.host === 'string' ? descriptor.host : null
    let link: TerminalLink | null = null
    let generation = descriptor.generation ?? ''
    let detach = () => {}
    let claimed = false
    let lastNotice = ''
    let lastHostState = ''
    let retries = 0
    let retryTimer: NodeJS.Timeout | undefined
    let attaching = false
    const isCurrent = () => open && link !== null && !link.closed
    const hostState = (state: string) => {
      if (!open || !host || state === lastHostState) return
      lastHostState = state
      ws.send(controlFrame({ __ctrl: true, host_state: { host, state } }))
    }
    const notice = (here: boolean, label: ViewerLabel | null, held: Size | null = null) => {
      const holder = {
        here,
        viewer: here ? viewer : label,
        ...(!here && held ? { size: { cols: held.cols, rows: held.rows } } : {}),
      }
      const key = JSON.stringify(holder)
      if (!isCurrent() || key === lastNotice) return
      lastNotice = key
      ws.send(controlFrame({ __ctrl: true, size_holder: holder }))
    }
    /** Drop the link (if any) and show why: the host cannot be reached. */
    const waitForHost = (state: string) => {
      clearTimeout(retryTimer)
      retryTimer = undefined
      const current = link
      link = null
      detach()
      detach = () => {}
      current?.kill()
      hostState(state)
    }
    /** A remote link dropped with the host still up: try again, jittered and bounded. */
    const retryRemote = () => {
      if (!open) return
      if (retries >= REMOTE_RETRIES) return hostState('disconnected')
      hostState('connecting')
      const delay = (this.deps.retryDelay ?? retryDelay)(retries)
      retries += 1
      clearTimeout(retryTimer)
      retryTimer = setTimeout(() => {
        retryTimer = undefined
        void attach()
      }, delay)
    }
    let claim: () => Promise<void> = async () => {}
    const claimWhenReady = () => {
      const current = link
      if (current) void current.ready.then(() => (isCurrent() ? claim() : undefined))
    }

    const attach = async (): Promise<void> => {
      if (!open || attaching || isCurrent()) return
      attaching = true
      try {
        await attachOnce()
      } finally {
        attaching = false
      }
    }
    const attachOnce = async (): Promise<void> => {
      let target: ReturnType<typeof ownAttachTarget>
      try {
        target = ownAttachTarget(await tether.attach(sessionId), process.env, host)
      } catch (error) {
        if (!open) return
        if (host && error instanceof TetherError && error.code === 'host_unavailable')
          return waitForHost(hostStateOf(error.body.state))
        if (
          error instanceof TetherError &&
          (error.status === 404 || error.code === 'workload_unavailable')
        )
          return dead('Session is not running')
        if (host && lastHostState) return retryRemote()
        ws.close(1011, unavailable(error))
        return
      }
      if (!open) return

      const current = this.openLink(target.argv, attachEnvironment(target), size)
      link = current
      generation = target.generation
      this.deps.touched(sessionId)
      lastNotice = ''
      const attachedAt = Date.now()
      claim = createSizeClaim({
        tether,
        id: sessionId,
        generation: () => generation,
        link: current,
        viewer,
        isCurrent,
        refresh: async () => {
          const latest = await findSession(tether, sessionId)
          if (latest?.generation) generation = latest.generation
        },
        applied: (changed) => {
          notice(true, viewer)
          if (changed && isCurrent()) current.settleSize()
        },
      })
      detach = streamToViewer(current, {
        send: (frame, done) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(frame, { binary: true }, done)
          else done()
        },
        // The control client exited: when the session's process did too (the
        // shell's `exit`), say the session ended so the page stops retrying.
        // A remote link tries again here; a local one has the page reconnect.
        close: () => {
          if (link !== current) return
          if (host && current.refusedByHost) {
            // The host's sshd has no room for another session: retrying at
            // once cannot help, so say so and wait for Reconnect.
            link = null
            retries = REMOTE_RETRIES
            return hostState('refused')
          }
          void sessionGone(tether, sessionId).then((gone) => {
            if (!open || link !== current) return
            if (gone) return dead('Session ended')
            if (!host) return ws.close(RECONNECT_CODE, 'reattach')
            link = null
            if (Date.now() - attachedAt >= REMOTE_STABLE_MS) retries = 0
            retryRemote()
          })
        },
      })
      void current.ready.then(() => {
        if (link !== current || !open) return
        hostState('live')
      })
      if (claimed) claimWhenReady()
      else {
        // Nobody holds the size yet: this sized viewer takes it. Otherwise
        // say who holds it and at what size, unless this socket claims anyway.
        void current.ready.then(async () => {
          if (claimed || !isCurrent() || link !== current) return
          const at = await sizeAtAttach({
            tether,
            id: sessionId,
            generation: () => generation,
            link: current,
          })
          if (claimed || !isCurrent() || link !== current) return
          // An unsized socket (an observer) never claims.
          if (at.claim && current.cols > 0) {
            claimed = true
            void claim()
          } else if (at.holder)
            notice(at.holder.clientPid === current.pid, at.holder.viewer, at.size)
          else if (at.size) notice(false, null, at.size)
        })
      }
    }

    const view: View = {
      sizeHeld: (clientPid, label, held) => {
        if (!link) return
        // Another client took the size: a reattach no longer claims it back.
        if (clientPid !== link.pid) claimed = false
        notice(clientPid === link.pid, label, held)
      },
      ended: () => {
        if (open) dead('Session ended')
      },
      close: (code, reason) => ws.close(code, reason),
      host,
      peer: (state) => {
        if (state === 'connected') return
        waitForHost(state)
      },
      resync: () => {
        if (isCurrent()) return
        clearTimeout(retryTimer)
        retryTimer = undefined
        retries = 0
        void attach()
      },
    }
    this.add(sessionId, view)
    cleanup = () => {
      this.remove(sessionId, view)
      clearTimeout(retryTimer)
      detach()
    }

    const handle = (message: ClientMessage) => {
      const control = message.kind === 'control' ? message.message : null
      if (control && 'resize' in control) size = sizeOf(control) ?? size
      // A claim made while the host is away applies once a link is back.
      if (control?.claim === true) claimed = true
      // The page came back to the foreground and asks whether this socket
      // still carries frames: answer even while the host is away.
      if (control?.probe === true && ws.readyState === WebSocket.OPEN)
        ws.send(controlFrame({ __ctrl: true, pong: true }))
      if (control?.reconnect === true && !isCurrent()) {
        // The page's Reconnect: try once more now.
        retries = 0
        void attach()
        return
      }
      if (!isCurrent() || !link) return
      if (message.kind === 'data') {
        link.write(message.text)
        return
      }
      if (!control) return
      if ('resize' in control && size) link.resize(size.cols, size.rows)
      if (control.claim === true) claimWhenReady()
      if (typeof control.paste === 'string' && control.paste) link.paste(control.paste)
      if (control.refresh) link.reseed()
    }

    if (host && descriptor.peer) waitForHost(descriptor.peer.state)
    else await attach()
    if (!open) return
    dispatch = handle
    for (const message of early.splice(0)) handle(message)
  }
}

/** A `host_unavailable` refusal's state, as the page shows it. */
function hostStateOf(value: unknown): string {
  return value === 'powered_off' || value === 'identity_changed' || value === 'connecting'
    ? value
    : 'offline'
}

/** The session no longer runs: Tether doesn't know it, it ended, or its pane has no workload. */
async function sessionGone(tether: TetherClient, sessionId: string): Promise<boolean> {
  try {
    const session = await findSession(tether, sessionId)
    return !session || (session.status as string) === 'ended'
  } catch (error) {
    return (
      error instanceof TetherError &&
      (error.status === 410 || error.code === 'workload_unavailable')
    )
  }
}

function unavailable(error: unknown): string {
  if (!(error instanceof TetherUnavailable) && !(error instanceof TetherError))
    console.error('[aico-web] terminal attach failed:', error)
  return 'Tether unavailable'
}
