// The web terminal: `WS /ws/a-term/:sessionId`, one tmux control-mode client
// (tether/term's ControlTerminal) per open socket, speaking the frames the web
// UI already speaks. The page sends text frames (typed input, or `{__ctrl:
// true, …}` JSON) or binary 0x01/0x02 frames; the server sends 0x01 pane text
// and 0x02 control JSON.
//
// A socket's first control message carries the viewer's size: the client
// starts at that size, or unsized (leaving the window's size to the other
// clients) when none arrives in time. `claim: true` claims the shared window
// size for this socket's client, labelled `{app: 'web', device}`; whenever the
// holder changes, the page gets a `size_holder` notice saying whether this
// socket holds it and, if not, which app and device does ("Viewing on …").

import type { IncomingMessage } from 'node:http'
import {
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
  streamToViewer,
  VIEWER_CREDIT_BYTES,
} from 'tether/term'
import { WebSocket } from 'ws'
import { findSession } from './tether'

export const TERMINAL_PATH = /^\/ws\/a-term\/([^/]+)$/
/** The close code the page treats as "this session is gone" (no reconnect). */
export const SESSION_DEAD_CODE = 4000

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
  | 'kill'
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
  sizeHeld(clientPid: number, viewer: ViewerLabel | null): void
  ended(): void
  close(code: number, reason: string): void
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
    const id = typeof event.data.id === 'string' ? event.data.id : null
    const views = id ? this.views.get(id) : undefined
    if (!views) return
    if (event.type === 'session.resized' && typeof event.data.clientPid === 'number') {
      const viewer = (event.data.viewer as ViewerLabel | undefined) ?? null
      for (const view of views) view.sizeHeld(event.data.clientPid, viewer)
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

    try {
      if (!(await findSession(tether, sessionId))) return dead('Session not found')
    } catch (error) {
      if (open) ws.close(1011, unavailable(error))
      return
    }
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

    let target: ReturnType<typeof ownAttachTarget>
    try {
      target = ownAttachTarget(await tether.attach(sessionId))
    } catch (error) {
      if (!open) return
      if (
        error instanceof TetherError &&
        (error.status === 404 || error.code === 'workload_unavailable')
      )
        return dead('Session is not running')
      ws.close(1011, unavailable(error))
      return
    }
    if (!open) return

    const link = this.openLink(target.argv, attachEnvironment(target), size)
    let generation = target.generation
    const isCurrent = () => open && !link.closed
    let lastNotice = ''
    const notice = (here: boolean, label: ViewerLabel | null) => {
      const holder = { here, viewer: here ? viewer : label }
      const key = JSON.stringify(holder)
      if (!isCurrent() || key === lastNotice) return
      lastNotice = key
      ws.send(controlFrame({ __ctrl: true, size_holder: holder }))
    }
    const claim = createSizeClaim({
      tether,
      id: sessionId,
      generation: () => generation,
      link,
      viewer,
      isCurrent,
      refresh: async () => {
        const descriptor = await findSession(tether, sessionId)
        if (descriptor?.generation) generation = descriptor.generation
      },
      applied: (changed) => {
        notice(true, viewer)
        if (changed && isCurrent()) link.settleSize()
      },
    })
    const claimWhenReady = () => void link.ready.then(() => (isCurrent() ? claim() : undefined))

    const detach = streamToViewer(link, {
      send: (frame, done) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(frame, { binary: true }, done)
        else done()
      },
      close: (code, reason) => ws.close(code, reason),
    })
    const view: View = {
      sizeHeld: (clientPid, label) => notice(clientPid === link.pid, label),
      ended: () => {
        if (open) dead('Session ended')
      },
      close: (code, reason) => ws.close(code, reason),
    }
    this.add(sessionId, view)
    cleanup = () => {
      this.remove(sessionId, view)
      detach()
    }
    this.deps.touched(sessionId)

    let claimed = false
    dispatch = (message) => {
      if (!isCurrent()) return
      if (message.kind === 'data') {
        link.write(message.text)
        return
      }
      const control = message.message
      if ('resize' in control) {
        const next = sizeOf(control)
        if (next) link.resize(next.cols, next.rows)
      }
      if (control.claim === true) {
        claimed = true
        claimWhenReady()
      }
      if (typeof control.paste === 'string' && control.paste) link.paste(control.paste)
      if (control.refresh) link.reseed()
    }
    for (const message of early.splice(0)) dispatch(message)

    // Say who holds the size now, unless this socket is claiming it anyway.
    void link.ready.then(async () => {
      if (claimed || !isCurrent()) return
      try {
        const answer = await tether.resizeHolder(sessionId)
        if (answer.holder && answer.generation === generation)
          notice(answer.holder.clientPid === link.pid, answer.holder.viewer)
      } catch {
        // No holder notice: Tether will say on the next claim.
      }
    })
  }
}

function unavailable(error: unknown): string {
  if (!(error instanceof TetherUnavailable) && !(error instanceof TetherError))
    console.error('[aico-web] terminal attach failed:', error)
  return 'Tether unavailable'
}
