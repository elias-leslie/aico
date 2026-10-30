// A fake Tether for the tests: sessions in memory, every call recorded.

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir } from 'node:os'
import {
  type RunsAnswer,
  type SessionDescriptor,
  type TetherClient,
  TetherError,
  type ViewerLabel,
  type Wake,
} from 'tether/client'
import { Router } from './http'

export interface Call {
  method: string
  args: unknown[]
}

let counter = 0

export function descriptor(fields: Partial<SessionDescriptor> = {}): SessionDescriptor {
  counter += 1
  const id = fields.id ?? `s${String(counter).padStart(7, '0')}`
  return {
    id,
    ownershipId: `own-${id}`,
    generation: 'g1',
    status: 'running',
    available: true,
    tool: 'shell',
    name: null,
    label: id,
    projectId: null,
    projectRoot: null,
    origin: 'a-term',
    rootRequestId: null,
    lifecycleVersion: 1,
    tmux: { serverId: null, socket: null, sessionId: '$1', paneId: '%1', sessionName: id },
    createdAt: 1_700_000_000_000 + counter,
    ...fields,
  } as SessionDescriptor
}

/** An attach answer `ownAttachTarget` accepts (a socket path of this user's own Tether). */
export function attachAnswer(generation = 'g1') {
  const state = process.env.XDG_STATE_HOME || `${process.env.HOME || homedir()}/.local/state`
  return {
    generation,
    argv: [
      '/usr/bin/tmux',
      '-S',
      `${state}/tether/default/tmux/${'0'.repeat(32)}/server.sock`,
      'attach-session',
      '-t',
      '$1',
    ],
    env: { TERM: 'xterm-256color' },
  }
}

/** The hub's attach answer for a session on `host`: the peer's own answer
 * plus that host's ssh link. */
export function remoteAttachAnswer(host: string, generation = 'g1') {
  const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`
  return {
    generation,
    argv: [
      '/usr/bin/tmux',
      '-S',
      `/home/peer/.local/state/tether/default/tmux/${'1'.repeat(32)}/server.sock`,
      'attach-session',
      '-t',
      '$1',
    ],
    env: { TERM: 'xterm-256color' },
    host,
    ssh: { alias: host, control: `${runtime}/tether/peers/${host}/ssh.ctl` },
  }
}

const notFound = () => new TetherError(404, 'not_found', {})

export class FakeTether {
  readonly calls: Call[] = []
  sessions = new Map<string, SessionDescriptor>()
  tools: Record<string, unknown>[] = [
    { slug: 'shell', name: 'Shell', enabled: true, displayOrder: 0, isDefault: false },
    {
      slug: 'claude',
      name: 'Claude',
      enabled: true,
      displayOrder: 1,
      isDefault: true,
      aliases: ['cc'],
    },
    { slug: 'codex', name: 'Codex', enabled: false, displayOrder: 2, isDefault: false },
    { slug: 'agent-hub', name: 'Agent Hub', enabled: true, displayOrder: 3, isDefault: false },
  ]
  projectList = [{ id: 'aico', name: 'Aico', root: '/srv/workspaces/projects/aico' }]
  /** Fail `createSession` for this tool. */
  failTool: string | null = null
  holder: { generation: string; holder: unknown } = { generation: 'g1', holder: null }
  /** The hub's linked hosts (`hosts()`). */
  hostRows: { name: string; state: string; ssh: string; sessions: number }[] = []
  /** Errors the next `attach` calls throw, in order. */
  attachFailures: Error[] = []

  add(fields: Partial<SessionDescriptor> = {}): SessionDescriptor {
    const session = descriptor(fields)
    this.sessions.set(session.id, session)
    return session
  }

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args })
  }

  callsOf(method: string): unknown[][] {
    return this.calls.filter((call) => call.method === method).map((call) => call.args)
  }

  private need(id: string): SessionDescriptor {
    const session = this.sessions.get(id)
    if (!session) throw notFound()
    return session
  }

  async listSessions() {
    return [...this.sessions.values()]
  }

  async getSession(id: string) {
    return this.need(id)
  }

  async rename(id: string, generation: string, name: string | null) {
    this.record('rename', id, generation, name)
    const session = this.need(id)
    session.name = name
    return session
  }

  async end(id: string, generation: string, options: { keepWakes?: boolean } = {}) {
    this.record('end', id, generation, ...(options.keepWakes ? [options] : []))
    this.need(id)
    this.sessions.delete(id)
    return { status: 'ended' as const }
  }

  /** The wakes Tether lists, kept ones (`sessionId` null) included. */
  wakeRows: Wake[] = []
  wakePolicy = {
    laterMinutes: 60,
    tonightHour: 21,
    morningHour: 8,
    maxPerSession: 5,
    noteMaxChars: 500,
    quietSeconds: 15,
    lateNoticeMinutes: 5,
    relaunchAttempts: 15,
  }
  /** Fail the next `addWake` with this Tether refusal. */
  failWake: TetherError | null = null

  async wakes() {
    this.record('wakes')
    return { items: this.wakeRows, policy: this.wakePolicy }
  }

  async sessionWakes(id: string) {
    this.record('sessionWakes', id)
    this.need(id)
    return {
      items: this.wakeRows.filter((wake) => wake.sessionId === id),
      policy: this.wakePolicy,
    }
  }

  async addWake(id: string, input: { dueAt: number; note: string; createdBy?: 'agent' | 'owner' }) {
    this.record('addWake', id, input)
    this.need(id)
    if (this.failWake) throw this.failWake
    const wake: Wake = {
      id: String(this.wakeRows.length + 1).padStart(12, '0'),
      sessionId: id,
      dueAt: input.dueAt,
      note: input.note,
      createdBy: input.createdBy ?? 'agent',
      createdAt: Date.now(),
      kept: false,
      attempts: 0,
      lastError: null,
    }
    this.wakeRows.push(wake)
    return wake
  }

  async cancelWake(wakeId: string) {
    this.record('cancelWake', wakeId)
    if (!this.wakeRows.some((wake) => wake.id === wakeId)) throw notFound()
    this.wakeRows = this.wakeRows.filter((wake) => wake.id !== wakeId)
    return { deleted: true as const }
  }

  async loadTui(id: string, generation: string, tool: string) {
    this.record('loadTui', id, generation, tool)
    const session = this.need(id)
    session.tool = tool
    session.generation = `${generation}+`
    return session
  }

  async attach(id: string) {
    this.record('attach', id)
    const failure = this.attachFailures.shift()
    if (failure) throw failure
    const session = this.need(id)
    return session.host
      ? remoteAttachAnswer(session.host, session.generation)
      : attachAnswer(session.generation)
  }

  async hosts() {
    this.record('hosts')
    return this.hostRows
  }

  async resizeClaim(
    id: string,
    generation: string,
    clientPid: number,
    cols: number,
    rows: number,
    viewer?: ViewerLabel,
  ) {
    this.record('resizeClaim', id, generation, clientPid, cols, rows, viewer)
    return { applied: true as const, changed: false }
  }

  async resizeHolder(id: string) {
    this.record('resizeHolder', id)
    return this.holder
  }

  /** Each remote host's projects (`projects(…, host)`). */
  hostProjects: Record<string, typeof this.projectList> = {}

  async projects(_refresh = false, host?: string) {
    if (host === undefined) return this.projectList
    const list = this.hostProjects[host]
    if (!list) throw new TetherError(400, 'unknown_host', {})
    return list
  }

  /** What `runs()` answers, and the run controls Tether is to refuse. */
  runsAnswer: RunsAnswer = { status: 'ok', error: null, updatedAt: null, items: [] }
  failRun: TetherError | null = null

  async runs() {
    this.record('runs')
    return this.runsAnswer
  }

  async resumeRun(runId: string, action: string, stepKey?: string | null) {
    this.record('resumeRun', runId, action, stepKey ?? null)
    if (this.failRun) throw this.failRun
    return { ok: true as const }
  }

  async cancelRun(runId: string, stepKey?: string | null) {
    this.record('cancelRun', runId, stepKey ?? null)
    if (this.failRun) throw this.failRun
    return { ok: true as const }
  }

  async dismissRun(runId: string) {
    this.record('dismissRun', runId)
    if (this.failRun) throw this.failRun
    return { ok: true as const }
  }

  async version() {
    return { name: 'tether', version: '0.0.0-test', apiVersion: 3, minApiVersion: 1 }
  }

  async request(method: string, path: string, body?: unknown) {
    this.record('request', method, path, body)
    if (method === 'GET' && path === '/v1/tools')
      return { status: 200, body: { items: this.tools, defaultSlug: 'claude' } }
    if (method === 'POST' && path === '/v1/sessions') {
      const input = body as Record<string, unknown>
      if (input.tool === this.failTool) throw new TetherError(409, 'admission_denied', {})
      if (typeof input.host === 'string') {
        const row = this.hostRows.find((h) => h.name === input.host)
        if (!row) throw new TetherError(400, 'unknown_host', { error: 'unknown_host' })
        if (row.state !== 'connected')
          throw new TetherError(409, 'host_unavailable', {
            error: 'host_unavailable',
            host: row.name,
            state: row.state,
            reason: 'link down',
          })
      }
      const session = this.add({
        host: typeof input.host === 'string' ? input.host : null,
        tool: String(input.tool),
        projectId: (input.projectId as string) ?? null,
        projectRoot: (input.projectRoot as string) ?? null,
        name: (input.name as string) ?? null,
      })
      return { status: 201, body: session }
    }
    const respawn = /^\/v1\/sessions\/([^/]+)\/respawn$/.exec(path)
    if (method === 'POST' && respawn) {
      const session = this.need(decodeURIComponent(respawn[1]))
      session.generation = `${session.generation}+`
      session.status = 'running'
      return { status: 200, body: session }
    }
    throw new Error(`FakeTether: unexpected ${method} ${path}`)
  }

  get client(): TetherClient {
    return this as unknown as TetherClient
  }
}

/** A loopback server answering only `register`'s routes; `close` when done. */
export async function serveRoutes(register: (router: Router) => void) {
  const router = new Router()
  register(router)
  const server = createServer((req, res) => {
    void router.handle(req, res, new URL(req.url ?? '/', 'http://localhost')).then((handled) => {
      if (!handled) {
        res.statusCode = 404
        res.end()
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
