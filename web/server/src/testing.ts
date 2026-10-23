// A fake Tether for the tests: sessions in memory, every call recorded.

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir } from 'node:os'
import {
  type SessionDescriptor,
  type TetherClient,
  TetherError,
  type ViewerLabel,
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
  ]
  projectList = [{ id: 'aico', name: 'Aico', root: '/srv/workspaces/projects/aico' }]
  /** Fail `createSession` for this tool. */
  failTool: string | null = null
  holder: { generation: string; holder: unknown } = { generation: 'g1', holder: null }

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

  async end(id: string, generation: string) {
    this.record('end', id, generation)
    this.need(id)
    this.sessions.delete(id)
    return { status: 'ended' as const }
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
    return attachAnswer(this.need(id).generation)
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

  async projects() {
    return this.projectList
  }

  async version() {
    return { name: 'tether', version: '0.0.0-test', apiVersion: 2, minApiVersion: 1 }
  }

  async request(method: string, path: string, body?: unknown) {
    this.record('request', method, path, body)
    if (method === 'GET' && path === '/v1/tools')
      return { status: 200, body: { items: this.tools, defaultSlug: 'claude' } }
    if (method === 'POST' && path === '/v1/sessions') {
      const input = body as Record<string, unknown>
      if (input.tool === this.failTool) throw new TetherError(409, 'admission_denied', {})
      const session = this.add({
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
