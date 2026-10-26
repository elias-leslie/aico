// Aico's client for Tether, the per-user session daemon that owns every tmux
// session, tmux server and agent launch (docs/api-v1.md). The desktop and the
// web server share it. Everything here speaks HTTP/1.1 over Tether's private
// 0600 Unix socket; nothing is network-exposed.
//
// Tether being down is "control unavailable", never "session gone": tmux
// servers and panes keep running while the daemon restarts.

import { statSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import {
  type AttachAnswer,
  type ContextHook,
  type GuiCommand,
  type GuiVerdict,
  parseAttachAnswer,
  parseContextHook,
  parseGuiCommand,
  type ResizeClaimAnswer,
  type SessionDescriptor,
  type SizeHolder,
  splitNdjson,
  TetherError,
  type TetherEvent,
  type TetherProject,
  type TetherTool,
  TetherUnavailable,
  type TetherVersion,
  type ViewerLabel,
  type Wake,
  type WakeList,
} from './contracts'

const DEFAULT_TIMEOUT_MS = 5_000
/** Tether sends a heartbeat every 15 s; three missed ones mean a half-open stream. */
export const STREAM_IDLE_MS = 45_000
const RECONNECT_MIN_MS = 500
const RECONNECT_MAX_MS = 10_000

/** This user's own `$XDG_RUNTIME_DIR/tether/<TETHER_INSTANCE|default>/control.sock`. */
export function ownTetherSocketPath(env: NodeJS.ProcessEnv, uid: number | undefined): string {
  const runtime = env.XDG_RUNTIME_DIR || (uid === undefined ? '/tmp' : `/run/user/${uid}`)
  const instance = env.TETHER_INSTANCE || 'default'
  return join(runtime, 'tether', instance, 'control.sock')
}

/** This user's `tether@default`, the one instance agent shares are accepted from. */
export function defaultTetherSocketPath(env: NodeJS.ProcessEnv, uid: number | undefined): string {
  return ownTetherSocketPath({ ...env, TETHER_INSTANCE: 'default' }, uid)
}

/** The active instance, the one new sessions go to: `TETHER_SOCKET`, else this user's own. */
export function tetherSocketPath(env: NodeJS.ProcessEnv, uid: number | undefined): string {
  return env.TETHER_SOCKET || ownTetherSocketPath(env, uid)
}

/** Instances to consult (a pool's sockets): only the active one, since every
 * session belongs to this user's own Tether. */
export function knownTetherSockets(env: NodeJS.ProcessEnv, uid: number | undefined): string[] {
  return [tetherSocketPath(env, uid)]
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

  /** The instances this client covers; a plain client is just itself. */
  instances(): TetherClient[] {
    return [this]
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
    /** Start in a new empty workspace with no first-party context (docs/root-control.md). */
    blankSlate?: true
    /** An Agent Hub prompt revision snapshot added to the tool's prompt. */
    instructions?: {
      prompt: string
      name: string
      revision: string
      contentHash?: string | null
      createdAt?: string | null
      content: string
    }
    size: { cols: number; rows: number }
  }): Promise<SessionDescriptor> {
    return this.json('POST', '/v1/sessions', { ...input, origin: 'aico' }, { timeoutMs: 60_000 })
  }

  rename(id: string, generation: string, name: string | null): Promise<SessionDescriptor> {
    return this.json('PATCH', `/v1/sessions/${encodeURIComponent(id)}`, { generation, name })
  }

  /** Mark or unmark a coordinator in the catalog; Tether forwards it to this
   * GUI and publishes `session.updated`. */
  setCoordinator(id: string, generation: string, coordinator: boolean): Promise<unknown> {
    return this.json('POST', `/v1/widgets/${encodeURIComponent(id)}/coordinator`, {
      generation,
      coordinator,
    })
  }

  /** End the session. Its wakes go with it unless `keepWakes`: then they
   * outlive it and relaunch its conversation at their time. */
  end(
    id: string,
    generation: string,
    options: { keepWakes?: boolean } = {},
  ): Promise<{ status: 'ended'; keptWakes?: number }> {
    return this.json(
      'POST',
      `/v1/sessions/${encodeURIComponent(id)}/end`,
      options.keepWakes ? { generation, keepWakes: true } : { generation },
      { timeoutMs: 30_000 },
    )
  }

  /** Every wake, kept ones included, with Tether's wake policy. */
  wakes(): Promise<WakeList> {
    return this.json('GET', '/v1/wakes')
  }

  /** One session's wakes, with the policy (the menus' quick choices). */
  sessionWakes(id: string): Promise<WakeList> {
    return this.json('GET', `/v1/sessions/${encodeURIComponent(id)}/wakes`)
  }

  addWake(
    id: string,
    input: { dueAt: number; note: string; createdBy?: 'agent' | 'owner' },
  ): Promise<Wake> {
    return this.json('POST', `/v1/sessions/${encodeURIComponent(id)}/wakes`, input)
  }

  moveWake(wakeId: string, dueAt: number): Promise<Wake> {
    return this.json('PATCH', `/v1/wakes/${encodeURIComponent(wakeId)}`, { dueAt })
  }

  cancelWake(wakeId: string): Promise<{ deleted: true }> {
    return this.json('DELETE', `/v1/wakes/${encodeURIComponent(wakeId)}`)
  }

  loadTui(id: string, generation: string, tool: string): Promise<SessionDescriptor> {
    return this.json(
      'POST',
      `/v1/sessions/${encodeURIComponent(id)}/load-tui`,
      { generation, tool },
      { timeoutMs: 60_000 },
    )
  }

  /** Respawn in another project (`projectId`) or a plain directory
   * (`projectRoot`, as the Personal Workspace). */
  switchProject(
    id: string,
    generation: string,
    target: { projectId: string } | { projectRoot: string },
  ): Promise<SessionDescriptor> {
    return this.json(
      'POST',
      `/v1/sessions/${encodeURIComponent(id)}/switch-project`,
      { generation, ...target },
      { timeoutMs: 60_000 },
    )
  }

  /** Re-check the session's context hook now (what Aico did on window load). */
  async contextCheck(id: string): Promise<ContextHook | null> {
    const body = await this.json<{ contextHook?: ContextHook }>(
      'POST',
      `/v1/sessions/${encodeURIComponent(id)}/context-check`,
      undefined,
      { timeoutMs: 30_000 },
    )
    return parseContextHook(body.contextHook)
  }

  diagnostics(id: string): Promise<Record<string, unknown>> {
    return this.json('GET', `/v1/sessions/${encodeURIComponent(id)}/diagnostics`, undefined, {
      timeoutMs: 15_000,
    })
  }

  attach(id: string): Promise<AttachAnswer> {
    return this.json('GET', `/v1/sessions/${encodeURIComponent(id)}/attach`, undefined, {
      timeoutMs: 30_000,
    }).then(parseAttachAnswer)
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

  /** Claim the shared window size for this attached tmux client. `viewer`
   * names the claimer for the other views ("Viewing on …"). */
  resizeClaim(
    id: string,
    generation: string,
    clientPid: number,
    cols: number,
    rows: number,
    viewer?: ViewerLabel,
  ): Promise<ResizeClaimAnswer> {
    return this.json('POST', `/v1/sessions/${encodeURIComponent(id)}/resize-claim`, {
      generation,
      clientPid,
      cols,
      rows,
      ...(viewer ? { viewer } : {}),
    })
  }

  /** Who holds the session's shared window size; null when unknown. */
  resizeHolder(id: string): Promise<{ generation: string; holder: SizeHolder | null }> {
    return this.json('GET', `/v1/sessions/${encodeURIComponent(id)}/resize-claim`)
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

  guiResult(commandId: string, result: GuiVerdict): Promise<unknown> {
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

function isSocket(path: string): boolean {
  try {
    return statSync(path).isSocket()
  } catch {
    return false
  }
}

const isMissing = (error: unknown): error is TetherError =>
  error instanceof TetherError && error.status === 404

/**
 * The active instance plus the other known one, behind the one-client API.
 * New sessions, tools and projects go to the active instance; the session list
 * merges both; a call about one session asks the active instance first and
 * falls back to the other on 404, so each session is handled by the instance
 * that owns it. The other instance counts only while its socket exists; its
 * outage does not hide the active instance's list. An unreachable candidate
 * fails any lookup that ended in 404: it may still own that session.
 */
export class TetherPool extends TetherClient {
  private readonly all: TetherClient[]

  constructor(
    sockets: string[],
    defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
    private readonly socketExists: (path: string) => boolean = isSocket,
  ) {
    super(sockets[0], defaultTimeoutMs)
    this.all = sockets.map((path) => new TetherClient(path, defaultTimeoutMs))
  }

  override instances(): TetherClient[] {
    return this.all
  }

  private candidates(): TetherClient[] {
    const [active, ...others] = this.all
    return [active, ...others.filter((client) => this.socketExists(client.socketPath))]
  }

  override async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<{ status: number; body: T }> {
    const route = trimTrailingSlashes(path.split('?')[0])
    if (route === '/v1/sessions' && method === 'GET') return this.mergedSessions(path, options)
    if (/^\/v1\/(sessions|widgets)\/[^/]/.test(route))
      return this.byOwner(method, path, body, options)
    return this.all[0].request<T>(method, path, body, options)
  }

  private async mergedSessions<T>(
    path: string,
    options: RequestOptions,
  ): Promise<{ status: number; body: T }> {
    const merged = new Map<string, unknown>()
    let first: { status: number; body: T } | null = null
    for (const client of this.candidates()) {
      let answer: { status: number; body: T }
      try {
        answer = await client.request<T>('GET', path, undefined, options)
      } catch (error) {
        if (client !== this.all[0] && error instanceof TetherUnavailable) continue
        throw error
      }
      first ??= answer
      const items = (answer.body as { items?: { id: string }[] } | null)?.items
      for (const item of items ?? []) if (!merged.has(item.id)) merged.set(item.id, item)
    }
    const head = first as { status: number; body: T }
    return { status: head.status, body: { ...head.body, items: [...merged.values()] } }
  }

  private async byOwner<T>(
    method: string,
    path: string,
    body: unknown,
    options: RequestOptions,
  ): Promise<{ status: number; body: T }> {
    let missing: { status: number; body: T } | TetherError | null = null
    let unavailable: TetherUnavailable | null = null
    for (const client of this.candidates()) {
      try {
        const answer = await client.request<T>(method, path, body, options)
        if (answer.status !== 404) return answer
        missing ??= answer
      } catch (error) {
        if (error instanceof TetherUnavailable) unavailable ??= error
        else if (isMissing(error)) missing ??= error
        else throw error
      }
    }
    if (unavailable) throw unavailable // another instance may still own it: not "gone"
    if (missing instanceof TetherError) throw missing
    return missing as { status: number; body: T }
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
        if (controller.signal.aborted) return // stopped on purpose (quit)
        if (connected) subscriber.onDisconnected?.(new Error('event stream ended'))
      } catch (error) {
        if (controller.signal.aborted) return
        subscriber.onDisconnected?.(error)
      }
      await new Promise((resolve) => setTimeout(resolve, reconnectDelay(attempt++)))
    }
  })()
  return () => controller.abort()
}

/**
 * Hold `GET /v1/gui/channel` as the one Aico GUI client, apply each
 * view mutation or read-only layout command and post its result. Reconnects with backoff;
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
                // Version skew (an unknown kind or field) should not leave
                // Tether waiting out its timeout: answer when there is an id.
                const commandId = (line as { commandId?: unknown }).commandId
                log('GUI channel: malformed command rejected')
                if (typeof commandId === 'string' && commandId)
                  void client
                    .guiResult(commandId, { applied: false, error: 'invalid_body' })
                    .catch((error) => log('GUI result could not be posted', error))
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

/** Drops trailing slashes. Not /\/+$/: it backtracks on a long run of '/'
 * (CodeQL js/polynomial-redos). */
export function trimTrailingSlashes(text: string): string {
  let end = text.length
  while (end > 0 && text.charCodeAt(end - 1) === 47) end--
  return text.slice(0, end)
}
