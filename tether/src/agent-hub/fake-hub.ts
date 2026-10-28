// A small fake Agent Hub over HTTP, for tests: the same routes and wire shapes
// the SDK client uses (sessions, agents, models, turns), so Tether's real SDK
// client runs against it. A turn stays "running" until the test finishes it.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeHubSession {
  id: string
  project_id: string
  provider: string
  model: string
  agent_slug: string | null
  external_id: string | null
  cwd: string | null
  work_role: unknown
  status: 'active' | 'completed'
  messages: string[]
  turnRunning: boolean
  turnPhase: string | null
}

export interface FakeHubRequest {
  method: string
  path: string
  headers: Record<string, string | string[] | undefined>
  body: Record<string, unknown> | null
}

export class FakeHub {
  readonly sessions = new Map<string, FakeHubSession>()
  readonly requests: FakeHubRequest[] = []
  agents = [{ slug: 'chat', primary_model_id: 'cheap-model', is_active: true }]
  models = [{ id: 'cheap-model', provider: 'fake', routable: true }]
  /** Answer every request with this status instead (an outage). */
  down: number | null = null
  private server: Server | null = null
  private readonly open = new Set<ServerResponse>()

  async listen(): Promise<string> {
    const server = createServer((req, res) => void this.handle(req, res))
    this.server = server
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  async close(): Promise<void> {
    for (const res of this.open) res.destroy()
    this.server?.closeAllConnections()
    await new Promise<void>((resolve) => this.server?.close(() => resolve()))
  }

  /** The turn ends: the session is idle again. */
  finishTurn(id: string): void {
    const session = this.sessions.get(id)
    if (session) {
      session.turnRunning = false
      session.turnPhase = null
    }
  }

  count(method: string, path: RegExp): number {
    return this.requests.filter((r) => r.method === method && path.test(r.path)).length
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake')
    let body: Record<string, unknown> | null = null
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    this.requests.push({
      method: req.method ?? 'GET',
      path: url.pathname,
      headers: { ...req.headers },
      body,
    })
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (this.down !== null) return json(this.down, { error: 'down', message: 'Agent Hub is down' })
    const route = `${req.method} ${url.pathname}`
    if (route === 'GET /api/agents')
      return json(200, { agents: this.agents, total: this.agents.length })
    if (route === 'GET /api/models') return json(200, { models: this.models })
    if (route === 'POST /api/sessions' && body) {
      const id = String(body.session_id)
      if (!this.sessions.has(id))
        this.sessions.set(id, {
          id,
          project_id: String(body.project_id),
          provider: String(body.provider),
          model: String(body.model),
          agent_slug: (body.agent_slug as string | null) ?? null,
          external_id: (body.external_id as string | null) ?? null,
          cwd: (body.cwd as string | null) ?? null,
          work_role: body.work_role ?? null,
          status: 'active',
          messages: [],
          turnRunning: false,
          turnPhase: null,
        })
      return json(201, this.summary(this.sessions.get(id) as FakeHubSession))
    }
    const one = /^\/api\/sessions\/([^/]+)(\/close)?$/.exec(url.pathname)
    if (one) {
      const session = this.sessions.get(decodeURIComponent(one[1]))
      if (!session) return json(404, { error: 'not_found', message: 'no such session' })
      if (req.method === 'GET' && !one[2]) return json(200, this.summary(session))
      if (req.method === 'POST' && one[2]) {
        session.status = 'completed'
        session.turnRunning = false
        return json(200, { id: session.id, status: 'completed', message: 'closed' })
      }
    }
    if (route === 'POST /api/complete' && body) {
      const session = this.sessions.get(String(body.session_id))
      if (!session) return json(404, { error: 'not_found', message: 'no such session' })
      if (session.turnRunning)
        return json(409, { error: 'turn_running', message: 'a turn is already running' })
      const message = (body.messages as { content: string }[])[0]
      session.messages.push(message.content)
      session.turnRunning = true
      session.turnPhase = 'waiting_for_model'
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(
        `data: ${JSON.stringify({ type: 'connected', seq: 1, session_id: session.id, turn_id: 'turn-1' })}\n\n`,
      )
      this.open.add(res)
      res.on('close', () => this.open.delete(res))
      return
    }
    if (route === 'POST /api/complete/cancel' && body) {
      const session = this.sessions.get(String(body.session_id))
      const cancelled = Boolean(session?.turnRunning)
      this.finishTurn(String(body.session_id))
      return json(200, { cancelled, session_id: body.session_id })
    }
    return json(404, { error: 'not_found', message: route })
  }

  private summary(session: FakeHubSession): Record<string, unknown> {
    return {
      id: session.id,
      project_id: session.project_id,
      provider: session.provider,
      model: session.model,
      agent_slug: session.agent_slug,
      external_id: session.external_id,
      status: session.status,
      turn_state: session.turnRunning ? 'running' : 'idle',
      turn_phase: session.turnPhase,
      message_count: session.messages.length,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    }
  }
}
