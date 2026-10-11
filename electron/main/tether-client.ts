// Aico's client for Tether, the per-user session daemon that owns every tmux
// session, tmux server and agent launch (docs/tether.md; Tether docs/api-v1.md).
// Aico keeps only views and settings. Everything here speaks HTTP/1.1 over
// Tether's private 0600 Unix socket; nothing is network-exposed.
//
// Tether being down is "control unavailable", never "session gone": tmux
// servers and panes keep running while the daemon restarts.

import { request } from 'node:http'
import { join } from 'node:path'

/** Lowest Tether API version this Aico needs (GET /v1/version). */
export const MIN_TETHER_API_VERSION = 1
/** The API version this Aico speaks; Tether must still accept it. */
export const AICO_TETHER_API_VERSION = 1

const DEFAULT_TIMEOUT_MS = 5_000
/** Tether sends a heartbeat every 15 s; three missed ones mean a half-open stream. */
export const STREAM_IDLE_MS = 45_000
const RECONNECT_MIN_MS = 500
const RECONNECT_MAX_MS = 10_000

/** `TETHER_SOCKET`, else `$XDG_RUNTIME_DIR/tether/<TETHER_INSTANCE|default>/control.sock`. */
export function tetherSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  uid: number | undefined = process.getuid?.(),
): string {
  if (env.TETHER_SOCKET) return env.TETHER_SOCKET
  const runtime = env.XDG_RUNTIME_DIR || (uid === undefined ? '/tmp' : `/run/user/${uid}`)
  const instance = env.TETHER_INSTANCE || 'default'
  return join(runtime, 'tether', instance, 'control.sock')
}

export type SessionStatus = 'running' | 'pending' | 'uncertain' | 'legacy'
export type SessionOrigin = 'aico' | 'a-term' | 'cli' | 'root'

export interface SessionDescriptor {
  id: string
  ownershipId: string
  generation: string
  status: SessionStatus
  available: boolean
  tool: string
  name: string | null
  label: string
  projectId: string | null
  projectRoot: string | null
  origin: SessionOrigin
  rootRequestId: string | null
  lifecycleVersion: number
  tmux: {
    serverId: string | null
    socket: string | null
    sessionId: string | null
    paneId: string | null
    sessionName: string
  }
  createdAt: number
  /** Present on a 202 create: why the session is not running yet. */
  failure?: { code: string; reason?: string } | null
}

export interface AttachTarget {
  generation: string
  /** Exact tmux client argv, e.g. `/usr/bin/tmux -S <socket> attach-session -t $3`. */
  argv: string[]
  /** Overrides only, applied over Aico's own environment. */
  env: Record<string, string>
  /** Keys removed after the overrides. */
  unset: string[]
}

export interface ScrollbackPage {
  generation: string
  fromLine: number
  totalLines: number
  historySize: number
  text: string
}

export interface TetherTool {
  slug: string
  name: string
  color: string | null
  displayOrder: number
  isDefault: boolean
  enabled: boolean
}

export interface TetherProject {
  id: string
  name: string
  root: string
}

export interface TetherVersion {
  name: string
  version: string
  apiVersion: number
  minApiVersion: number
}

export interface TetherEvent {
  seq: number
  bootId: string
  type: string
  at: number
  data: Record<string, unknown>
}

/** A Tether answer other than 2xx. `code` is Tether's stable error code. */
export class TetherError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body: Record<string, unknown>,
  ) {
    super(typeof body.reason === 'string' ? `${code}: ${body.reason}` : code)
    this.name = 'TetherError'
  }

  get reason(): string | undefined {
    return typeof this.body.reason === 'string' ? this.body.reason : undefined
  }
}

/** The socket could not be reached or the exchange broke. Nothing is known to
 * have changed; for a mutation, the outcome is unknown. */
export class TetherUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TetherUnavailable'
  }
}

/** True when Tether accepts this Aico and offers what it needs. */
export function compatibleVersion(version: TetherVersion): boolean {
  return (
    Number.isSafeInteger(version.apiVersion) &&
    version.apiVersion >= MIN_TETHER_API_VERSION &&
    (!Number.isSafeInteger(version.minApiVersion) ||
      version.minApiVersion <= AICO_TETHER_API_VERSION)
  )
}

/** Split complete NDJSON lines from a buffer; the incomplete tail is kept. */
export function splitNdjson(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split('\n')
  const rest = parts.pop() ?? ''
  return { lines: parts.map((line) => line.trim()).filter(Boolean), rest }
}

/** The environment for a `tmux attach` PTY: Aico's own, plus Tether's
 * overrides, minus Tether's unset list (docs/api-v1.md Terminal I/O). */
export function attachEnvironment(
  base: NodeJS.ProcessEnv,
  target: Pick<AttachTarget, 'env' | 'unset'>,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value
  Object.assign(env, target.env)
  for (const key of target.unset) delete env[key]
  return env
}

/** Validate an attach answer before it is ever executed. */
export function parseAttachTarget(body: unknown): AttachTarget {
  const value = body as Partial<AttachTarget> | null
  const strings = (list: unknown): list is string[] =>
    Array.isArray(list) && list.every((item) => typeof item === 'string')
  if (
    !value ||
    typeof value.generation !== 'string' ||
    !strings(value.argv) ||
    value.argv.length < 2 ||
    !value.argv[0].startsWith('/') ||
    !value.env ||
    typeof value.env !== 'object' ||
    !Object.values(value.env).every((item) => typeof item === 'string') ||
    !strings(value.unset)
  )
    throw new TetherUnavailable('Tether returned an invalid attach target')
  return value as AttachTarget
}

/** The tmux socket and target an attach argv names, for read-only view
 * queries (pane mode, client repaint) on the client Aico itself attached. */
export function attachSocketTarget(argv: string[]): { socket: string; target: string } | null {
  const socketAt = argv.indexOf('-S')
  const targetAt = argv.lastIndexOf('-t')
  const socket = socketAt > 0 ? argv[socketAt + 1] : undefined
  const target = targetAt > 0 ? argv[targetAt + 1] : undefined
  return socket?.startsWith('/') && target ? { socket, target } : null
}

interface RequestOptions {
  timeoutMs?: number
  /** Accept these non-2xx statuses as answers instead of throwing. */
  accept?: number[]
}

export class TetherClient {
  constructor(
    readonly socketPath: string,
    private readonly defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  /** One JSON exchange. Throws TetherError for a non-2xx answer and
   * TetherUnavailable when the socket or the exchange failed. */
  request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<{ status: number; body: T }> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body)
      const req = request(
        {
          socketPath: this.socketPath,
          method,
          path,
          timeout: timeoutMs,
          headers: payload
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {},
        },
        (res) => {
          const parts: Buffer[] = []
          res.on('data', (chunk: Buffer) => parts.push(chunk))
          res.on('error', (error) => reject(new TetherUnavailable(error.message)))
          res.on('end', () => {
            const status = res.statusCode ?? 0
            let parsed: unknown = null
            try {
              const text = Buffer.concat(parts).toString('utf8')
              parsed = text ? JSON.parse(text) : null
            } catch {
              reject(new TetherUnavailable(`Tether answered ${status} with a non-JSON body`))
              return
            }
            if ((status >= 200 && status < 300) || options.accept?.includes(status)) {
              resolve({ status, body: parsed as T })
              return
            }
            const record =
              parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
            const code = typeof record.error === 'string' ? record.error : `http_${status}`
            reject(new TetherError(status, code, record))
          })
        },
      )
      req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs} ms`)))
      req.on('error', (error) => reject(new TetherUnavailable(error.message)))
      if (payload) req.write(payload)
      req.end()
    })
  }

  private async json<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<T> {
    return (await this.request<T>(method, path, body, options)).body
  }

  version(): Promise<TetherVersion> {
    return this.json('GET', '/v1/version')
  }

  async listSessions(): Promise<SessionDescriptor[]> {
    return (await this.json<{ items: SessionDescriptor[] }>('GET', '/v1/sessions')).items
  }

  /** Live-verified descriptor (`409 identity_changed` if it moved meanwhile). */
  getSession(id: string): Promise<SessionDescriptor> {
    return this.json('GET', `/v1/sessions/${encodeURIComponent(id)}`)
  }

  /** Creates and launches at the first view's grid size. 201 running, 202
   * pending/uncertain (with `failure`). Allow a slow agent admission. */
  createSession(input: {
    tool: string
    projectId?: string
    projectRoot?: string
    size: { cols: number; rows: number }
  }): Promise<SessionDescriptor> {
    return this.json('POST', '/v1/sessions', { ...input, origin: 'aico' }, { timeoutMs: 60_000 })
  }

  rename(id: string, generation: string, name: string | null): Promise<SessionDescriptor> {
    return this.json('PATCH', `/v1/sessions/${encodeURIComponent(id)}`, { generation, name })
  }

  end(id: string, generation: string): Promise<{ status: 'ended' }> {
    return this.json(
      'POST',
      `/v1/sessions/${encodeURIComponent(id)}/end`,
      { generation },
      { timeoutMs: 30_000 },
    )
  }

  loadTui(id: string, generation: string, tool: string): Promise<SessionDescriptor> {
    return this.json(
      'POST',
      `/v1/sessions/${encodeURIComponent(id)}/load-tui`,
      { generation, tool },
      { timeoutMs: 60_000 },
    )
  }

  switchProject(id: string, generation: string, projectId: string): Promise<SessionDescriptor> {
    return this.json(
      'POST',
      `/v1/sessions/${encodeURIComponent(id)}/switch-project`,
      { generation, projectId },
      { timeoutMs: 60_000 },
    )
  }

  diagnostics(id: string): Promise<Record<string, unknown>> {
    return this.json('GET', `/v1/sessions/${encodeURIComponent(id)}/diagnostics`, undefined, {
      timeoutMs: 15_000,
    })
  }

  async attach(id: string): Promise<AttachTarget> {
    return parseAttachTarget(
      await this.json('GET', `/v1/sessions/${encodeURIComponent(id)}/attach`, undefined, {
        timeoutMs: 30_000,
      }),
    )
  }

  scrollback(
    id: string,
    query: { fromLine?: number; count?: number; escapes: boolean },
  ): Promise<ScrollbackPage> {
    const params = new URLSearchParams()
    if (query.fromLine !== undefined) params.set('fromLine', String(query.fromLine))
    if (query.count !== undefined) params.set('count', String(query.count))
    if (query.escapes) params.set('escapes', '1')
    return this.json('GET', `/v1/sessions/${encodeURIComponent(id)}/scrollback?${params}`)
  }

  inject(
    id: string,
    generation: string,
    text: string,
    mode: 'type' | 'paste',
  ): Promise<{ delivered: true }> {
    return this.json('POST', `/v1/sessions/${encodeURIComponent(id)}/inject`, {
      generation,
      text,
      mode,
    })
  }

  resizeClaim(
    id: string,
    generation: string,
    clientPid: number,
    cols: number,
    rows: number,
  ): Promise<{ applied: boolean; reason?: string }> {
    return this.json('POST', `/v1/sessions/${encodeURIComponent(id)}/resize-claim`, {
      generation,
      clientPid,
      cols,
      rows,
    })
  }

  async tools(): Promise<{ items: TetherTool[]; defaultSlug: string | null }> {
    return this.json('GET', '/v1/tools?enabled=1')
  }

  async projects(refresh = false): Promise<TetherProject[]> {
    const body = await this.json<{ projects: TetherProject[] }>(
      'GET',
      refresh ? '/v1/projects?refresh=1' : '/v1/projects',
    )
    return body.projects
  }

  guiResult(commandId: string, result: { applied: boolean; error?: string }): Promise<unknown> {
    return this.json('POST', `/v1/gui/results/${encodeURIComponent(commandId)}`, result)
  }

  /** Open one long-lived NDJSON stream. Resolves when it ends; rejects with
   * TetherUnavailable or TetherError when it cannot be opened. */
  stream(
    path: string,
    headers: Record<string, string>,
    onLine: (line: unknown) => void,
    signal: AbortSignal,
    idleMs = STREAM_IDLE_MS,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let idle: NodeJS.Timeout | undefined
      const req = request({ socketPath: this.socketPath, method: 'GET', path, headers, signal })
      const arm = () => {
        clearTimeout(idle)
        idle = setTimeout(() => req.destroy(new Error('stream idle')), idleMs)
      }
      const finish = (error?: Error) => {
        clearTimeout(idle)
        if (error && !signal.aborted) reject(new TetherUnavailable(error.message))
        else resolve()
      }
      req.on('response', (res) => {
        if ((res.statusCode ?? 0) !== 200) {
          res.resume()
          clearTimeout(idle)
          reject(new TetherError(res.statusCode ?? 0, `http_${res.statusCode}`, {}))
          return
        }
        arm()
        let buffer = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          arm()
          const { lines, rest } = splitNdjson(buffer + chunk)
          buffer = rest
          for (const line of lines) {
            let parsed: unknown
            try {
              parsed = JSON.parse(line)
            } catch {
              continue // a malformed frame is skipped, never fatal
            }
            onLine(parsed)
          }
        })
        res.on('end', () => finish())
        res.on('error', (error) => finish(error))
      })
      req.on('error', (error) => finish(error))
      req.end()
    })
  }
}

/** Capped exponential reconnect delay. */
export function reconnectDelay(attempt: number): number {
  return Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.max(0, attempt))
}

export interface EventCursor {
  bootId: string | null
  seq: number
}

/**
 * Pure event-stream bookkeeping. `resync` means the caller must re-list
 * sessions: on first connect, on a `gap`, and after a daemon restart. Events
 * already applied (seq at or below the cursor) are dropped.
 */
export function applyStreamEvent(
  cursor: EventCursor,
  event: TetherEvent,
): { cursor: EventCursor; deliver: boolean; resync: boolean } {
  if (event.type === 'hello') {
    const restarted = cursor.bootId !== null && cursor.bootId !== event.bootId
    return {
      cursor:
        restarted || cursor.bootId === null ? { bootId: event.bootId, seq: event.seq } : cursor,
      deliver: false,
      resync: cursor.bootId === null || restarted,
    }
  }
  if (event.type === 'gap') {
    return { cursor: { bootId: event.bootId, seq: event.seq }, deliver: false, resync: true }
  }
  if (event.type === 'heartbeat') return { cursor, deliver: false, resync: false }
  if (event.bootId !== cursor.bootId) {
    return { cursor: { bootId: event.bootId, seq: event.seq }, deliver: true, resync: true }
  }
  if (event.seq <= cursor.seq) return { cursor, deliver: false, resync: false }
  return { cursor: { bootId: cursor.bootId, seq: event.seq }, deliver: true, resync: false }
}

export function eventStreamPath(cursor: EventCursor): string {
  if (cursor.bootId === null) return '/v1/events'
  const params = new URLSearchParams({ since: String(cursor.seq), bootId: cursor.bootId })
  return `/v1/events?${params}`
}

function isTetherEvent(value: unknown): value is TetherEvent {
  const event = value as TetherEvent | null
  return (
    !!event &&
    typeof event.type === 'string' &&
    typeof event.bootId === 'string' &&
    typeof event.seq === 'number'
  )
}

export interface EventSubscriber {
  /** The stream (re)connected. */
  onConnected?(): void
  /** The stream dropped; Tether control is unavailable until it returns. */
  onDisconnected?(error: unknown): void
  /** Re-list everything: first connect, gap, or daemon restart. */
  onResync(): void
  onEvent(event: TetherEvent): void
}

/** Follow `GET /v1/events` for the life of the app, reconnecting with backoff
 * and resuming from the last seq, re-listing on any gap. */
export function followEvents(client: TetherClient, subscriber: EventSubscriber): () => void {
  const controller = new AbortController()
  let cursor: EventCursor = { bootId: null, seq: 0 }
  void (async () => {
    let attempt = 0
    while (!controller.signal.aborted) {
      let connected = false
      try {
        await client.stream(
          eventStreamPath(cursor),
          {},
          (line) => {
            if (!isTetherEvent(line)) return
            if (!connected) {
              connected = true
              attempt = 0
              subscriber.onConnected?.()
            }
            const step = applyStreamEvent(cursor, line)
            cursor = step.cursor
            if (step.resync) subscriber.onResync()
            if (step.deliver) subscriber.onEvent(line)
          },
          controller.signal,
        )
        if (connected) subscriber.onDisconnected?.(new Error('event stream ended'))
      } catch (error) {
        subscriber.onDisconnected?.(error)
      }
      if (controller.signal.aborted) return
      await new Promise((resolve) => setTimeout(resolve, reconnectDelay(attempt++)))
    }
  })()
  return () => controller.abort()
}

export interface GuiCommand {
  commandId: string
  kind: 'show' | 'position' | 'title'
  sessionId: string
  generation: string
  bounds?: { x: number; y: number; width: number; height: number }
  label?: string
}

/** Validate one GUI channel command line. */
export function parseGuiCommand(value: unknown): GuiCommand | null {
  const line = value as Record<string, unknown> | null
  if (!line || line.type !== 'command') return null
  if (
    typeof line.commandId !== 'string' ||
    (line.kind !== 'show' && line.kind !== 'position' && line.kind !== 'title') ||
    typeof line.sessionId !== 'string' ||
    !/^[0-9a-f]{8}$/.test(line.sessionId) ||
    typeof line.generation !== 'string'
  )
    return null
  const command: GuiCommand = {
    commandId: line.commandId,
    kind: line.kind,
    sessionId: line.sessionId,
    generation: line.generation,
  }
  if (line.kind === 'position') {
    const b = line.bounds as Record<string, unknown> | null
    const int = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n)
    if (!b || !int(b.x) || !int(b.y) || !int(b.width) || !int(b.height)) return null
    command.bounds = {
      x: b.x as number,
      y: b.y as number,
      width: b.width as number,
      height: b.height as number,
    }
  }
  if (line.kind === 'title') {
    if (typeof line.label !== 'string') return null
    command.label = line.label
  }
  return command
}

/** The GUI's verdict for one command: applied, or a stable error code. */
export type GuiVerdict = { applied: true } | { applied: false; error: string }

/**
 * Hold `GET /v1/gui/channel` as the one Aico GUI client, apply each
 * show/position/title command and post its result. Reconnects with backoff;
 * a `superseded` notice (another GUI took over) stops it for good.
 */
export function holdGuiChannel(
  client: TetherClient,
  apply: (command: GuiCommand) => Promise<GuiVerdict>,
  log: (message: string, error?: unknown) => void = () => {},
): () => void {
  const controller = new AbortController()
  void (async () => {
    let attempt = 0
    let superseded = false
    while (!controller.signal.aborted && !superseded) {
      try {
        await client.stream(
          '/v1/gui/channel',
          { 'x-tether-client': 'aico-gui' },
          (line) => {
            const type = (line as { type?: unknown } | null)?.type
            if (type === 'hello') {
              attempt = 0
              log('GUI channel connected')
            } else if (type === 'superseded') {
              superseded = true
              log('GUI channel superseded by another GUI client; not reconnecting')
            } else if (type === 'command') {
              const command = parseGuiCommand(line)
              if (!command) {
                log('GUI channel: malformed command ignored')
                return
              }
              void apply(command)
                .catch((error): GuiVerdict => {
                  log(`GUI command ${command.kind} failed`, error)
                  return { applied: false, error: 'gui_failed' }
                })
                .then((verdict) => client.guiResult(command.commandId, verdict))
                .catch((error) => log('GUI result could not be posted', error))
            }
          },
          controller.signal,
        )
      } catch (error) {
        if (!controller.signal.aborted) log('GUI channel unavailable', error)
      }
      if (controller.signal.aborted || superseded) return
      await new Promise((resolve) => setTimeout(resolve, reconnectDelay(attempt++)))
    }
  })()
  return () => controller.abort()
}
