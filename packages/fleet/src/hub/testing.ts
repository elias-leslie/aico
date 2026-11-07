// Fixtures the hub's tests share: a stand-in remote Tether, a hub on test ports, and the
// front socket a daemon would put in front of it. The Tether-side test builds on the same ones.

import { unlinkSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { HttpError, readJsonObject, sendError, sendJson } from '@aico/shared/http'
import { Hub, type HubDeps } from './hub'
import type { HubPorts, ToolLogin } from './types'

/** How the tests' fake tools sign in; Tether's own test keeps this equal to the adapters'. */
export const TEST_LOGINS: Record<string, ToolLogin> = {
  'claude-code': {
    signIn: 'claude auth login',
    signOut: { kind: 'revoke' },
    grant: true,
    local: { bin: 'claude', authFile: '.claude/.credentials.json' },
  },
  codex: {
    signIn: 'codex login --device-auth',
    signOut: { kind: 'command', line: 'codex logout' },
    local: { bin: 'codex', authFile: '.codex/auth.json' },
  },
  'aico-agent': { signIn: null, signOut: null },
  pi: {
    signIn: "echo 'In pi, type /login and pick a provider.'; pi",
    signOut: { kind: 'session', line: "echo 'In pi, type /logout.'; pi" },
    local: { bin: 'pi', authFile: '.pi/agent/auth.json' },
  },
  agy: {
    signIn: "echo 'agy asks you to sign in when it starts.'; agy",
    signOut: { kind: 'session', line: "echo 'In agy, type /logout.'; agy" },
    local: { bin: 'agy', authFile: '.gemini/antigravity-cli/antigravity-oauth-token' },
    signInLink: { host: 'accounts.google.com' },
  },
}

/** The first API that runs each fake tool through a session entry, in display order. */
export const TEST_ENTRY_APIS: [string, number][] = [
  ['claude-code', 15],
  ['codex', 19],
  ['pi', 20],
]

export const TEST_PORTS: HubPorts = {
  apiVersion: 32,
  isInstanceName: (value) => /^[a-z0-9][a-z0-9-]{0,31}$/.test(value),
  dbFile: 'test-state',
  tools: {
    logins: TEST_LOGINS,
    signInTitle: 'Sign in: ',
    entryApiVersion: (tool) => TEST_ENTRY_APIS.find(([id]) => id === tool)?.[1],
    entryTools: () => TEST_ENTRY_APIS.map(([id, entryApiVersion]) => ({ id, entryApiVersion })),
  },
}

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

export type Item = Record<string, unknown> & { id: string }

export function session(id: string, extra: Record<string, unknown> = {}): Item {
  return {
    id,
    generation: `gen-${id}`,
    status: 'running',
    tool: 'shell',
    projectId: 'p',
    origin: 'aico',
    rootRequestId: null,
    tmux: { socket: '/home/u/.local/state/tether/default/tmux/x/server.sock' },
    createdAt: 1,
    wakes: [],
    ...extra,
  }
}

async function body(req: IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = []
  for await (const part of req) parts.push(part as Buffer)
  const text = Buffer.concat(parts).toString('utf8')
  return text ? JSON.parse(text) : null
}

/** A stand-in remote Tether on the link's forwarded socket. */
export class FakePeer {
  server: Server | null = null
  sessions: Item[] = []
  identity: Record<string, unknown> = { name: 'vm-1', machineId: 'aaaa' }
  /** Absent: an older Tether that names no API version in its health. */
  apiVersion: number | undefined = undefined
  /** Absent: a Tether from before health named its release. */
  release: { hash: string; issuedAt: number | null } | undefined = undefined
  requests: { method: string; url: string; body: unknown }[] = []
  refuseEnd = false
  /** Refuse creates and deliveries as an older Tether refuses a field it
   * does not know. */
  refuseBody = false
  failSessions = false
  /** Health never answers (a VM that stopped dead: the socket takes the
   * connection, nothing comes back). */
  hangHealth = false
  /** Hold the initial transport handshake until a synthetic host is ready. */
  healthReady: Promise<void> | null = null
  readonly streams = new Set<ServerResponse>()
  roots: Record<string, unknown>[] = []
  rootListHandler: RequestHandler | null = null
  /** Null: an older Tether with no asks or shares routes (404). */
  asks: Record<string, unknown>[] | null = []
  shares: Record<string, unknown>[] | null = []
  /** Control the gap between asks being cached and the whole link-up finishing. */
  sharesReady: Promise<void> | null = null

  constructor(readonly socket: string) {}

  async start(): Promise<void> {
    try {
      unlinkSync(this.socket)
    } catch {}
    this.server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve) => this.server?.listen(this.socket, resolve))
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }

  emit(type: string, data: Record<string, unknown>): void {
    for (const stream of this.streams)
      stream.write(`${JSON.stringify({ seq: 1, bootId: 'b', type, at: 1, data })}\n`)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/'
    const payload = req.method === 'POST' ? await body(req) : undefined
    this.requests.push({ method: req.method ?? '', url, body: payload })
    if (url === '/v1/health') {
      if (this.hangHealth) return
      await this.healthReady
      return sendJson(res, 200, {
        status: 'ok',
        instance: 'default',
        apiVersion: this.apiVersion,
        release: this.release,
        host: this.identity,
      })
    }
    if (
      this.refuseBody &&
      req.method === 'POST' &&
      (url === '/v1/roots' || /\/deliveries$/.test(url))
    )
      return sendJson(res, 400, { error: 'invalid_body', field: 'reply' })
    if (url === '/v1/sessions' && req.method === 'GET') {
      if (this.failSessions) return sendJson(res, 500, { error: 'internal_error' })
      return sendJson(res, 200, { items: this.sessions })
    }
    if (url === '/v1/asks' && this.asks) return sendJson(res, 200, { items: this.asks })
    if (url === '/v1/shares' && this.shares) {
      await this.sharesReady
      return sendJson(res, 200, { items: this.shares })
    }
    const askRoute = /^\/v1\/asks\/([0-9a-f]{12})(\/(answer|done))?$/.exec(url)
    if (askRoute && this.asks) {
      const found = this.asks.find((item) => item.id === askRoute[1])
      if (!found) return sendJson(res, 404, { error: 'not_found' })
      if (askRoute[3] === 'answer')
        return sendJson(res, 200, { ...found, state: 'answered', answer: 'Yes' })
      if (askRoute[3] === 'done') return sendJson(res, 200, { ...found, state: 'done' })
      return sendJson(res, 200, found)
    }
    if (url === '/v1/events') {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write(`${JSON.stringify({ seq: 0, bootId: 'b', type: 'hello', at: 1, data: {} })}\n`)
      this.streams.add(res)
      res.once('close', () => this.streams.delete(res))
      return
    }
    if (/^\/v1\/sessions\/[0-9a-f]{8}\/chat\/stream$/.test(url)) {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write(`${JSON.stringify({ type: 'hello' })}\n`)
      return
    }
    if (/^\/v1\/sessions\/[0-9a-f]{8}\/attach$/.test(url))
      return sendJson(res, 200, { generation: 'g', argv: ['/usr/bin/tmux'], env: {} })
    if (url === '/v1/sessions' && req.method === 'POST') {
      const created = session('cccc0003')
      this.sessions.push(created)
      return sendJson(res, 201, created)
    }
    if (url === '/v1/roots/root-a' && req.method === 'GET') {
      // Chunked, without a length, as root-control answered before.
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.write('{"requestId":"root-a",')
      res.end('"status":"running"}')
      return
    }
    if (url.startsWith('/v1/roots?') && req.method === 'GET') {
      if (this.rootListHandler) return this.rootListHandler(req, res)
      return sendJson(res, 200, { owner: 'aico', roots: this.roots })
    }
    if (url === '/v1/roots' && req.method === 'POST')
      return sendJson(res, 201, { requestId: 'req-1', widgetId: 'dddd0004' })
    const end = /^\/v1\/sessions\/([0-9a-f]{8})\/end$/.exec(url)
    if (end && req.method === 'POST')
      return this.refuseEnd
        ? sendJson(res, 409, { error: 'not_ended' })
        : sendJson(res, 200, { id: end[1], status: 'ended' })
    const one = /^\/v1\/sessions\/([0-9a-f]{8})$/.exec(url)
    if (one) {
      const found = this.sessions.find((item) => item.id === one[1])
      return found ? sendJson(res, 200, found) : sendJson(res, 404, { error: 'not_found' })
    }
    sendJson(res, 404, { error: 'not_found' })
  }
}

/** What a test hub reads of the test around it. */
export interface TestHubContext {
  dir: string
  ports?: HubPorts
  /** Read when the hub publishes or reads settings, so a test may swap them. */
  readonly events: { type: string; data: Record<string, unknown> }[]
  readonly settings: Map<string, string>
  local: Set<string>
  localRoots: Map<string, string>
}

/** A hub over `ctx.dir`'s hosts.json, with no ssh and no wait on real clocks. */
export function makeTestHub(ctx: TestHubContext, overrides: Partial<HubDeps> = {}): Hub {
  return new Hub({
    fleetPeers: () => ['vm', 'fresh', 'a', 'b'],
    env: { XDG_RUNTIME_DIR: ctx.dir, TETHER_HOSTS_FILE: join(ctx.dir, 'hosts.json') },
    uid: 1000,
    publish: (type, data) => ctx.events.push({ type, data }),
    settings: {
      get: (key) => ctx.settings.get(key) ?? null,
      put: (key, value) => ctx.settings.set(key, value),
    },
    isLocalSession: (id) => ctx.local.has(id),
    isLocalRoot: (id, logical) =>
      ctx.localRoots.has(id) && (logical === undefined || ctx.localRoots.get(id) === logical),
    isLocalAsk: (id) => id === 'cccccccccccc',
    leadName: (id) => (id === 'eeee0005' ? 'Aico — Remote hosts' : null),
    claimLocal: (id) =>
      ctx.local.has(id) ? { coordinatorId: id, coordinatorColor: '#6fa8ff', parentId: id } : null,
    log: () => {},
    random: () => 0,
    gate: { kick: () => {}, linkGraceMs: 200 },
    // Never an ssh from a test: a host on an older API fails its update.
    update: async () => ({ code: 1, stdout: '', output: 'no release in tests' }),
    ports: ctx.ports ?? TEST_PORTS,
    ...overrides,
  })
}

/** The socket a daemon puts in front of the hub: the hub's own routes, then `local`
 * (the Tether routes a test brings), else the hub creates. */
export function frontServer(hub: () => Hub, local: () => RequestHandler | null): Server {
  return createServer((req, res) => {
    if (hub().forward(req, res)) return
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://local')
        if (
          req.method === 'GET' &&
          (url.pathname === '/v1/tools' || url.pathname === '/v1/projects') &&
          url.searchParams.has('host')
        )
          return await hub().query(res, url.searchParams.get('host') ?? '', url.pathname)
        if (req.url === '/v1/sessions' && req.method === 'POST')
          return await hub().create(res, '/v1/sessions', await readJsonObject(req))
        if (req.url === '/v1/roots' && req.method === 'POST') {
          const handler = local()
          return handler
            ? await handler(req, res)
            : await hub().create(res, '/v1/roots', await readJsonObject(req))
        }
        sendJson(res, 404, { error: 'not_found', local: true })
      } catch (error) {
        if (error instanceof HttpError) sendError(res, error)
        else throw error
      }
    })()
  })
}
